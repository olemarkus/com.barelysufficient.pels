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
import { POWER_CALIBRATION } from '../utils/settingsKeys';
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
  ingestDevices(snapshots: readonly TargetDeviceSnapshot[], nowMs: number): IngestStats {
    const stats: IngestStats = { accepted: 0, skipped: 0, reset: 0 };
    for (const snapshot of snapshots) {
      const sample = buildSampleFromDeviceSnapshot(snapshot, nowMs);
      if (!sample) {
        stats.skipped += 1;
        continue;
      }
      const outcome = this.recordSample(sample);
      if (outcome.accepted) {
        stats.accepted += 1;
        if (outcome.reset) stats.reset += 1;
      } else {
        stats.skipped += 1;
      }
    }
    return stats;
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
 * Load a calibration store from Homey settings. Treats missing or malformed
 * values as an empty store rather than throwing, and applies an abandon-grace
 * window when the raw value was unparseable so a transient empty SDK read on
 * startup does not wipe persisted history (per the "Homey SDK reads can
 * transiently fail" rule).
 */
export function loadPowerCalibrationStore(params: {
  homey: Homey.App['homey'];
  options?: PowerCalibrationStoreOptions;
}): PowerCalibrationStore {
  const raw: unknown = params.homey.settings.get(POWER_CALIBRATION);
  const initialSnapshot = normalizePowerCalibrationSnapshot(raw);
  const rawWasMissingOrInvalid = !isPlausiblePersistedSnapshot(raw);
  const loadGraceMs = params.options?.loadGraceMs ?? (rawWasMissingOrInvalid ? DEFAULT_LOAD_GRACE_MS : 0);
  return new PowerCalibrationStore({
    ...(params.options ?? {}),
    initialSnapshot,
    loadGraceMs,
  });
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
    return true;
  } catch (err) {
    params.error('Failed to persist power calibration', err as Error);
    return false;
  }
}

function buildSampleFromDeviceSnapshot(
  snapshot: TargetDeviceSnapshot,
  nowMs: number,
): RecordSampleInput | null {
  if (snapshot.controlModel !== 'stepped_load') return null;
  const profile = snapshot.steppedLoadProfile;
  if (!profile || !Array.isArray(profile.steps) || profile.steps.length === 0) return null;
  const reportedStepId = snapshot.reportedStepId;
  if (typeof reportedStepId !== 'string' || reportedStepId.length === 0) return null;
  // Only sample when the actual step is *reported* (real telemetry, not an
  // assumed-step fallback) and matches the reported step. Sampling on an
  // assumed step would attribute measured power to a step the device may
  // never have visited.
  if (snapshot.actualStepSource !== 'reported') return null;
  if (snapshot.actualStepId !== reportedStepId) return null;
  if (snapshot.stepCommandPending === true) return null;
  if (!isFiniteNumber(snapshot.measuredPowerKw) || snapshot.measuredPowerKw < 0) return null;
  // Require a finite freshness timestamp. Without one, `recordSample`'s
  // freshness gate short-circuits, allowing arbitrarily stale samples through
  // — which contradicts the documented "fresh within 60s" sampling policy.
  if (!isFiniteNumber(snapshot.lastFreshDataMs)) return null;

  const nameplateKw = resolveStepNameplateKw(profile, reportedStepId);
  if (nameplateKw === null) return null;
  if (nameplateKw <= 0) return null; // off-step or zero-power step — skip

  return {
    deviceId: snapshot.id,
    stepId: reportedStepId,
    measuredPowerKw: snapshot.measuredPowerKw,
    nameplateKw,
    dataObservedAtMs: snapshot.lastFreshDataMs,
    nowMs,
  };
}

function resolveStepNameplateKw(profile: SteppedLoadProfile, stepId: string): number | null {
  const step = profile.steps.find((entry) => entry.id === stepId);
  if (!step) return null;
  if (!isFiniteNumber(step.planningPowerW)) return null;
  return step.planningPowerW / 1000;
}

export { POWER_CALIBRATION_CONSTANTS };
