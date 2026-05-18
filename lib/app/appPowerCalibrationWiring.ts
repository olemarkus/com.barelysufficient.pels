/**
 * App-layer wiring for {@link PowerCalibrationStore}.
 *
 * Holds the calibration snapshot in memory, dispatches samples from
 * `appPowerSampleIngest`, debounces writes back to Homey settings, and
 * periodically prunes stale entries. Pure-store logic lives in
 * `lib/observer/devicePowerCalibration.ts`.
 */
import type Homey from 'homey';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';
import {
  type RecordSampleSkipReason,
  type RecordSampleConfig,
  type RecordSampleInput,
  type RecordSampleOutcome,
  POWER_CALIBRATION_CONSTANTS,
  POWER_CALIBRATION_VERSION,
  createEmptyPowerCalibrationSnapshot,
  isStrictlyValidPersistedDevice,
  normalizePowerCalibrationSnapshot,
  pruneStale,
  recordSample,
} from '../observer/devicePowerCalibration';
import { POWER_CALIBRATION, POWER_CALIBRATION_INITIALIZED } from '../utils/settingsKeys';
import type { SteppedLoadProfile, TargetDeviceSnapshot } from '../utils/types';
import { isFiniteNumber } from '../utils/appTypeGuards';

const DEFAULT_PERSIST_DEBOUNCE_MS = 60_000;
const DEFAULT_PRUNE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Abandon-grace window after a load returned no persisted snapshot.
 * Persisting a freshly-empty store on the first sample after a transient
 * missing settings read would wipe historical observations; the wiring
 * layer waits at least this long before writing back, so a subsequent
 * settings read has a chance to restore the prior shape. Modeled on the
 * "Homey SDK reads can transiently fail" feedback note.
 */
const DEFAULT_LOAD_GRACE_MS = 5 * 60 * 1000;

export type PowerCalibrationStoreOptions = {
  initialSnapshot?: PowerCalibrationSnapshot;
  recordConfig?: RecordSampleConfig;
  persistDebounceMs?: number;
  pruneMaxAgeMs?: number;
  /** Set to a positive value when the persisted snapshot was absent /
   * malformed on load — the store will refuse persistence until this many
   * milliseconds elapse so a transient miss does not wipe prior history. */
  loadGraceMs?: number;
  /** Construction time. Defaults to `Date.now()`. */
  nowMs?: number;
};

export type IngestStats = {
  accepted: number;
  skipped: number;
  reset: number;
  skippedByReason: Partial<Record<PowerCalibrationSkipReason, number>>;
  rejectedSamples: PowerCalibrationRejectedSample[];
  rejectedSamplesTruncated: number;
};

export type PowerCalibrationSkipReason = RecordSampleSkipReason | 'ineligible_snapshot';

export type PowerCalibrationRejectedSample = {
  deviceId: string;
  deviceName: string;
  stepId: string;
  measuredPowerKw: number;
  nameplateKw: number;
  lowerStepCeilingKw: number | null;
  reason: RecordSampleSkipReason;
};

export type IngestDevicesOptions = {
  collectRejectedSamples?: boolean;
  rejectedSampleLimit?: number;
};

/**
 * Mutable in-memory cache around the immutable {@link recordSample} pipeline.
 * Tracks a dirty flag and a debounce window so callers can flush to settings
 * without writing on every accepted sample.
 */
export class PowerCalibrationStore {
  private snapshot: PowerCalibrationSnapshot;
  private dirty = false;
  private lastPersistMs: number;
  private readonly recordConfig: RecordSampleConfig | undefined;
  private readonly persistDebounceMs: number;
  private readonly pruneMaxAgeMs: number;
  private readonly persistGraceUntilMs: number;

  constructor(options: PowerCalibrationStoreOptions = {}) {
    this.snapshot = options.initialSnapshot ?? createEmptyPowerCalibrationSnapshot();
    this.lastPersistMs = 0;
    this.recordConfig = options.recordConfig;
    this.persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
    this.pruneMaxAgeMs = options.pruneMaxAgeMs ?? DEFAULT_PRUNE_MAX_AGE_MS;
    const graceMs = options.loadGraceMs ?? 0;
    this.persistGraceUntilMs = graceMs > 0
      ? (options.nowMs ?? Date.now()) + graceMs
      : 0;
  }

  getSnapshot(): PowerCalibrationSnapshot {
    return this.snapshot;
  }

  /** Replace the in-memory snapshot. Clears the dirty flag (assumes the caller
   * just synced from persistence). */
  importSnapshot(snapshot: PowerCalibrationSnapshot): void {
    this.snapshot = snapshot;
    this.dirty = false;
  }

  /** Submit a sample. Updates the snapshot in place when accepted. */
  recordSample(input: RecordSampleInput): RecordSampleOutcome {
    const outcome = recordSample(this.snapshot, input, this.recordConfig);
    if (outcome.accepted) {
      this.snapshot = outcome.snapshot;
      this.dirty = true;
    }
    return outcome;
  }

  /** Walk a TargetDeviceSnapshot batch and dispatch samples for eligible
   * stepped-load devices. Honors freshness, materialization, and floor gates;
   * delegates the per-sample EMA / nameplate / cadence gates to `recordSample`. */
  ingestDevices(
    snapshots: readonly TargetDeviceSnapshot[],
    nowMs: number,
    options: IngestDevicesOptions = {},
  ): IngestStats {
    const collectRejectedSamples = options.collectRejectedSamples ?? true;
    const rejectedSampleLimit = normalizeRejectedSampleLimit(options.rejectedSampleLimit);
    let accepted = 0;
    let skipped = 0;
    let reset = 0;
    let rejectedSamplesTruncated = 0;
    const skippedByReason = new Map<PowerCalibrationSkipReason, number>();
    const rejectedSamples: PowerCalibrationRejectedSample[] = [];
    for (const snapshot of snapshots) {
      const sample = buildSampleFromDeviceSnapshot(snapshot, nowMs);
      if (!sample) {
        skipped += 1;
        incrementSkipReason(skippedByReason, 'ineligible_snapshot');
        continue;
      }
      const outcome = this.recordSample(sample);
      if (outcome.accepted) {
        accepted += 1;
        if (outcome.reset) reset += 1;
        continue;
      }
      skipped += 1;
      incrementSkipReason(skippedByReason, outcome.reason);
      if (!collectRejectedSamples) continue;
      if (rejectedSamples.length >= rejectedSampleLimit) {
        rejectedSamplesTruncated += 1;
        continue;
      }
      rejectedSamples.push(buildRejectedSample(snapshot, sample, outcome.reason));
    }
    return {
      accepted,
      skipped,
      reset,
      skippedByReason: Object.fromEntries(skippedByReason.entries()),
      rejectedSamples,
      rejectedSamplesTruncated,
    };
  }

  /** Drop devices that haven't been touched in `pruneMaxAgeMs`. Returns true
   * when anything changed (caller may want to bump the dirty flag for an
   * earlier flush). */
  prune(nowMs: number, maxAgeMs: number = this.pruneMaxAgeMs): boolean {
    const next = pruneStale(this.snapshot, maxAgeMs, nowMs);
    if (next === this.snapshot) return false;
    this.snapshot = next;
    this.dirty = true;
    return true;
  }

  /**
   * Return the current snapshot when it is dirty AND past the debounce + load
   * grace gates. Pure read — does *not* mark the store clean. Callers must
   * invoke {@link markPersisted} after the snapshot has been durably written;
   * if the write throws, the store stays dirty and the same samples will be
   * retried on the next persist tick.
   */
  snapshotForPersist(nowMs: number): PowerCalibrationSnapshot | null {
    if (!this.dirty) return null;
    if (nowMs < this.persistGraceUntilMs) return null;
    if ((nowMs - this.lastPersistMs) < this.persistDebounceMs) return null;
    return this.snapshot;
  }

  /**
   * Return the current snapshot when it is dirty, bypassing the debounce
   * window only. The load-grace window is *still honored* — flushing inside
   * the grace window would write a possibly-incomplete in-memory state over
   * persisted history that was unreadable on startup, which is exactly the
   * scenario the grace is designed to prevent. For shutdown / prune paths
   * where a durable write is required outside the grace window. Like
   * {@link snapshotForPersist}, this is non-mutating; the caller commits
   * the write via {@link markPersisted}.
   */
  snapshotForFlush(nowMs: number): PowerCalibrationSnapshot | null {
    if (!this.dirty) return null;
    if (nowMs < this.persistGraceUntilMs) return null;
    return this.snapshot;
  }

  /**
   * Mark the most recently returned snapshot as durably persisted. Resets the
   * dirty flag and advances the debounce window. Must only be called after a
   * successful `homey.settings.set` — calling it before a write would silently
   * lose any samples buffered between the snapshot read and the next sample
   * arrival.
   */
  markPersisted(nowMs: number): void {
    this.dirty = false;
    this.lastPersistMs = nowMs;
  }

  isDirty(): boolean {
    return this.dirty;
  }
}

/**
 * Load a calibration store from Homey settings. Treats missing, malformed,
 * or thrown reads as an empty store rather than propagating the error, and
 * applies an abandon-grace window when the raw value was unparseable (or
 * unreadable) so a transient empty SDK read on startup does not wipe
 * persisted history (per the "Homey SDK reads can transiently fail" rule).
 *
 * Distinguishes a true fresh install (no persisted data and no
 * "we've-written-before" marker) from a transient SDK read miss (marker is
 * set, but the snapshot read returned null). On a fresh install there is no
 * history to preserve, so the grace window is skipped and the first sample
 * persists immediately — otherwise per-step EMAs collected in the first 5
 * minutes after restart can be lost if the app crashes before the grace
 * window elapses.
 *
 * A thrown snapshot read is treated as `raw absent`; a thrown marker read
 * is treated as `marker present`. The combination forces the cautious
 * branch (engage grace) when the SDK is unwilling to answer either query
 * — otherwise paired throws on startup would misclassify an existing
 * install as fresh.
 */
export function loadPowerCalibrationStore(params: {
  homey: Homey.App['homey'];
  options?: PowerCalibrationStoreOptions;
}): PowerCalibrationStore {
  const rawRead = readPersistedSnapshot(params.homey);
  const initialSnapshot = normalizePowerCalibrationSnapshot(rawRead.value);
  const rawIsPlausible = !rawRead.threw && isPlausiblePersistedSnapshot(rawRead.value);
  // Distinguish "raw genuinely absent" from "raw read threw". A throw means
  // we cannot tell whether prior history exists, so it must NOT collapse
  // into the fresh-install branch even when the marker is also absent —
  // that combination would otherwise overwrite an upgrading user's history
  // (marker may legitimately be missing on first post-upgrade boot).
  const rawIsAbsent = !rawRead.threw
    && (rawRead.value === undefined || rawRead.value === null);
  const markerRead = readInitMarker(params.homey);
  // Treat a thrown marker read as marker-present. Pairing a thrown marker
  // read with an absent snapshot would otherwise misclassify an existing
  // install as fresh and bypass the load-grace window — exactly the
  // data-loss case the marker is designed to prevent.
  const hasInitMarker = markerRead.threw ? true : markerRead.value;
  // Pre-existing users upgrading from a version without the marker should
  // have it backfilled now, so a subsequent transient miss is recognised as
  // such rather than misclassified as a fresh install. Skip the backfill if
  // the marker read threw — we have no signal about whether it's actually
  // missing.
  if (rawIsPlausible && !markerRead.threw && !markerRead.value) {
    writeInitMarkerBestEffort(params.homey);
  }
  const loadGraceMs = params.options?.loadGraceMs ?? resolveLoadGraceMs({
    rawIsPlausible,
    rawIsAbsent,
    rawReadThrew: rawRead.threw,
    hasInitMarker,
  });
  return new PowerCalibrationStore({
    ...(params.options ?? {}),
    initialSnapshot,
    loadGraceMs,
  });
}

type SettingsReadResult<T> = { value: T; threw: false } | { value: undefined; threw: true };

function readPersistedSnapshot(homey: Homey.App['homey']): SettingsReadResult<unknown> {
  // The Homey SDK reads can transiently throw on startup. A throw is treated
  // as a missing-with-marker-present read so the load-grace window engages
  // and a subsequent recovery read can rebuild the prior history (per the
  // "Homey SDK reads can transiently fail" rule).
  try {
    return { value: homey.settings.get(POWER_CALIBRATION) as unknown, threw: false };
  } catch {
    return { value: undefined, threw: true };
  }
}

/**
 * Decide whether to engage the abandon-grace window after loading.
 *  - Plausible raw → no grace; the loaded snapshot is authoritative.
 *  - Raw read threw → engage grace regardless of marker. A throw means the
 *    SDK refused to answer, and an upgrading install may legitimately have
 *    no marker yet — collapsing into the fresh-install branch would
 *    overwrite prior history on the next persist.
 *  - Raw absent AND marker absent → fresh install; no grace, write
 *    immediately so brand-new EMAs aren't lost to a crash inside the window.
 *  - Raw absent AND marker present → transient SDK miss; engage grace so a
 *    subsequent recovery read can rebuild the prior history.
 *  - Raw is a malformed object → preserve grace regardless of marker. A
 *    malformed payload signals partial corruption; the next persist could
 *    overwrite still-recoverable history with the rebuilt-empty snapshot.
 */
function resolveLoadGraceMs(args: {
  rawIsPlausible: boolean;
  rawIsAbsent: boolean;
  rawReadThrew: boolean;
  hasInitMarker: boolean;
}): number {
  if (args.rawIsPlausible) return 0;
  if (args.rawIsAbsent && !args.hasInitMarker) return 0;
  return DEFAULT_LOAD_GRACE_MS;
}

function isPlausiblePersistedSnapshot(value: unknown): boolean {
  // Reject anything the normaliser would silently drop. The normaliser is
  // intentionally lenient (it preserves device entries with partial step
  // corruption so a single bad record doesn't wipe history); the plausibility
  // check must be stricter — *any* malformed nested data is a red flag that
  // the persisted shape may be partially corrupt, and the next persist would
  // overwrite previously valid history.
  if (value === undefined || value === null) return false;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const versionField = (value as { version?: unknown }).version;
  if (versionField !== POWER_CALIBRATION_VERSION) return false;
  const devicesField = (value as { devices?: unknown }).devices;
  if (typeof devicesField !== 'object' || devicesField === null || Array.isArray(devicesField)) {
    return false;
  }
  return Object.values(devicesField as Record<string, unknown>).every(isStrictlyValidPersistedDevice);
}

/**
 * Persist the snapshot if the store is dirty and past the debounce + load
 * grace gates. Safe to call from a heartbeat tick. The store stays dirty
 * when the write fails, so the next call will retry the same samples.
 */
export function persistPowerCalibrationIfDue(params: {
  homey: Homey.App['homey'];
  store: PowerCalibrationStore;
  nowMs: number;
  error: (msg: string, err: Error) => void;
}): boolean {
  const snapshot = params.store.snapshotForPersist(params.nowMs);
  if (!snapshot) return false;
  return writeAndMark(params, snapshot);
}

/**
 * Persist the snapshot regardless of debounce / load-grace gates. For
 * shutdown and post-prune callers that need the on-disk representation to
 * reflect the in-memory state immediately.
 */
export function persistPowerCalibrationFlush(params: {
  homey: Homey.App['homey'];
  store: PowerCalibrationStore;
  nowMs: number;
  error: (msg: string, err: Error) => void;
}): boolean {
  const snapshot = params.store.snapshotForFlush(params.nowMs);
  if (!snapshot) return false;
  return writeAndMark(params, snapshot);
}

function writeAndMark(
  params: {
    homey: Homey.App['homey'];
    store: PowerCalibrationStore;
    nowMs: number;
    error: (msg: string, err: Error) => void;
  },
  snapshot: PowerCalibrationSnapshot,
): boolean {
  try {
    params.homey.settings.set(POWER_CALIBRATION, snapshot);
    params.store.markPersisted(params.nowMs);
  } catch (err) {
    params.error('Failed to persist power calibration', err as Error);
    return false;
  }
  // Mark "we've written before" so a subsequent boot with a missing snapshot
  // read is recognised as a transient SDK miss rather than a fresh install.
  // Outside the snapshot-write try/catch so a marker read/write failure does
  // not get reported as a snapshot-persist failure (the snapshot is already
  // durable at this point). Write whenever the marker is not confirmed
  // present — including when the read threw — otherwise persistent marker-
  // read failures would never write the marker, and a later boot with a
  // transient snapshot-read miss would be misclassified as a fresh install
  // (raw absent + marker absent) and overwrite prior history.
  const markerRead = readInitMarker(params.homey);
  const markerConfirmedPresent = !markerRead.threw && markerRead.value;
  if (!markerConfirmedPresent) {
    writeInitMarkerBestEffort(params.homey);
  }
  return true;
}

function readInitMarker(homey: Homey.App['homey']): SettingsReadResult<boolean> {
  // A thrown read leaves the caller unable to distinguish "marker absent"
  // from "we couldn't ask". Surface the throw so the caller can pick the
  // conservative interpretation (treat as marker present → engage grace)
  // rather than misclassifying an existing install as a fresh one.
  try {
    return { value: homey.settings.get(POWER_CALIBRATION_INITIALIZED) === true, threw: false };
  } catch {
    return { value: undefined, threw: true };
  }
}

function writeInitMarkerBestEffort(homey: Homey.App['homey']): void {
  // Best-effort: failure means the next load or persist retries the write,
  // which is harmless because the marker is idempotent.
  try {
    homey.settings.set(POWER_CALIBRATION_INITIALIZED, true);
  } catch {
    // Non-fatal — the main calibration snapshot is unaffected.
  }
}

function buildSampleFromDeviceSnapshot(
  snapshot: TargetDeviceSnapshot,
  nowMs: number,
): RecordSampleInput | null {
  if (!isEligiblePowerCalibrationSnapshot(snapshot)) return null;

  const profile = snapshot.steppedLoadProfile;
  const reportedStepId = snapshot.reportedStepId;
  const stepBand = resolveStepPowerBandKw(profile, reportedStepId);
  if (stepBand === null) return null;
  if (stepBand.nameplateKw <= 0) return null; // off-step or zero-power step — skip

  return {
    deviceId: snapshot.id,
    stepId: reportedStepId,
    measuredPowerKw: snapshot.measuredPowerKw,
    nameplateKw: stepBand.nameplateKw,
    ...(stepBand.lowerStepCeilingKw !== undefined ? { lowerStepCeilingKw: stepBand.lowerStepCeilingKw } : {}),
    dataObservedAtMs: snapshot.lastFreshDataMs,
    nowMs,
  };
}

function normalizeRejectedSampleLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit);
}

function isEligiblePowerCalibrationSnapshot(
  snapshot: TargetDeviceSnapshot,
): snapshot is TargetDeviceSnapshot & {
  controlModel: 'stepped_load';
  steppedLoadProfile: SteppedLoadProfile;
  reportedStepId: string;
  actualStepId: string;
  actualStepSource: 'reported';
  measuredPowerKw: number;
  lastFreshDataMs: number;
} {
  if (snapshot.controlModel !== 'stepped_load') return false;
  if (!snapshot.steppedLoadProfile || !Array.isArray(snapshot.steppedLoadProfile.steps)) return false;
  if (snapshot.steppedLoadProfile.steps.length === 0) return false;
  if (typeof snapshot.reportedStepId !== 'string' || snapshot.reportedStepId.length === 0) return false;
  // Only sample when the actual step is *reported* (real telemetry, not an
  // assumed-step fallback) and matches the reported step. Sampling on an
  // assumed step would attribute measured power to a step the device may
  // never have visited.
  if (snapshot.actualStepSource !== 'reported') return false;
  if (snapshot.actualStepId !== snapshot.reportedStepId) return false;
  if (snapshot.stepCommandPending === true) return false;
  if (!isFiniteNumber(snapshot.measuredPowerKw) || snapshot.measuredPowerKw < 0) return false;
  // Require a finite freshness timestamp. Without one, `recordSample`'s
  // freshness gate short-circuits, allowing arbitrarily stale samples through
  // — which contradicts the documented "fresh within 60s" sampling policy.
  return isFiniteNumber(snapshot.lastFreshDataMs);
}

function resolveStepPowerBandKw(profile: SteppedLoadProfile, stepId: string): {
  nameplateKw: number;
  lowerStepCeilingKw: number | undefined;
} | null {
  const step = profile.steps.find((entry) => entry.id === stepId);
  if (!step) return null;
  if (!isFiniteNumber(step.planningPowerW)) return null;
  const lowerStep = profile.steps
    .filter((entry) => isLowerPowerStep(entry, stepId, step.planningPowerW))
    .sort((left, right) => right.planningPowerW - left.planningPowerW)[0];
  return {
    nameplateKw: step.planningPowerW / 1000,
    lowerStepCeilingKw: lowerStep ? lowerStep.planningPowerW / 1000 : undefined,
  };
}

function isLowerPowerStep(
  entry: SteppedLoadProfile['steps'][number],
  stepId: string,
  stepPlanningPowerW: number,
): boolean {
  return entry.id !== stepId
    && isFiniteNumber(entry.planningPowerW)
    && entry.planningPowerW < stepPlanningPowerW;
}

function incrementSkipReason(
  counts: Map<PowerCalibrationSkipReason, number>,
  reason: PowerCalibrationSkipReason,
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function buildRejectedSample(
  snapshot: TargetDeviceSnapshot,
  sample: RecordSampleInput,
  reason: RecordSampleSkipReason,
): PowerCalibrationRejectedSample {
  return {
    deviceId: sample.deviceId,
    deviceName: snapshot.name,
    stepId: sample.stepId,
    measuredPowerKw: sample.measuredPowerKw,
    nameplateKw: sample.nameplateKw,
    lowerStepCeilingKw: sample.lowerStepCeilingKw ?? null,
    reason,
  };
}

export { POWER_CALIBRATION_CONSTANTS };
