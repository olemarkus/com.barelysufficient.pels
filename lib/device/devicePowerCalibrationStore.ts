/**
 * App-layer wiring for {@link PowerCalibrationStore}.
 *
 * Holds the calibration snapshot in memory, accepts per-device samples that
 * the device manager dispatches whenever an observation actually mutated the
 * snapshot, debounces writes back to Homey settings, and periodically prunes
 * stale entries. Pure-store logic lives in `lib/device/devicePowerCalibration.ts`.
 */
import type { HomeyRuntime } from '../ports/homeyRuntime';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';
import {
  type RecordSampleConfig,
  type RecordSampleInput,
  type RecordSampleOutcome,
  POWER_CALIBRATION_VERSION,
  createEmptyPowerCalibrationSnapshot,
  isStrictlyValidPersistedDevice,
  mergeRecoveredCalibrationHistory,
  normalizePowerCalibrationSnapshot,
  pruneStale,
  recordSample,
} from './devicePowerCalibration';
import { POWER_CALIBRATION, POWER_CALIBRATION_INITIALIZED } from '../utils/settingsKeys';
import type {
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorFields,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { isFiniteNumber } from '../utils/appTypeGuards';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';

const moduleLogger = getLogger('device/power-calibration-store');

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
/**
 * How long a *transient-miss* recovery re-read (SDK answering, value absent,
 * init marker present) may keep deferring the first write, measured from the
 * FIRST deferred attempt — not from boot, so a store whose first mutation
 * arrives hours later still gets a full window of spaced re-reads instead of
 * abandoning on a single one. Repeated genuine absence across those re-reads
 * means the persisted key is really gone, and writing over an absent key
 * destroys nothing — so past the deadline the store stops waiting. A *thrown*
 * re-read never uses this deadline: it defers indefinitely, because every
 * retry re-reads and a healed SDK then recovers the history, while abandoning
 * on a clock would overwrite it at exactly the moment the SDK heals.
 */
const DEFAULT_RECOVERY_DEFERRAL_MS = 5 * 60 * 1000;

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

/**
 * Outcome of {@link PowerCalibrationStore.ingestDeviceSnapshot}. `null` means
 * the snapshot was ineligible (not stepped-load, no fresh data, off-step) and
 * the caller should silently no-op — there is no useful debug payload for an
 * event-driven trigger that simply does not apply.
 */
export type IngestDeviceSnapshotOutcome = RecordSampleOutcome | null;

/**
 * What a recovery re-read of the persisted snapshot established, applied by
 * the private settle step of {@link PowerCalibrationStore.resolveRecoveryForWrite}.
 */
type RecoveredCalibrationHistory =
  | { kind: 'recovered'; snapshot: PowerCalibrationSnapshot }
  | { kind: 'nothing_recoverable' };

/**
 * Outcome of settling the boot-time recovery re-read ahead of a write.
 * `ready` carries the snapshot to persist (merged when history was
 * recovered); `deferred` means the persisted value may still be recoverable
 * but was not readable right now, so this write must not happen — the store
 * stays dirty and the persist guard retries, re-reading each time.
 */
type RecoveryWriteResolution =
  | { kind: 'ready'; snapshot: PowerCalibrationSnapshot }
  | { kind: 'deferred' };

/**
 * Mutable in-memory cache around the immutable {@link recordSample} pipeline.
 * Tracks a dirty flag and a debounce window so callers can flush to settings
 * without writing on every accepted sample.
 */
export class PowerCalibrationStore {
  private snapshot: PowerCalibrationSnapshot;
  private dirty = false;
  private lastPersistMs: number;
  private recoveryPending: boolean;
  /** Throttle cursor for recovery re-reads; sentinel = never attempted. */
  private lastRecoveryAttemptMs = Number.NEGATIVE_INFINITY;
  /**
   * Per-arm deferral windows, each armed by that arm's FIRST deferred
   * attempt; 0 = not armed yet. They must stay separate: a long thrown phase
   * that healed into a transiently-absent read would otherwise hand the
   * transient-miss arm an already-expired shared window, abandoning recovery
   * after ZERO spaced absent re-reads — the exact overwrite this machinery
   * exists to prevent.
   */
  private readThrewDeferralUntilMs = 0;
  private transientMissDeferralUntilMs = 0;
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
    // A grace window engages exactly when the boot read was suspect, so the
    // same signal marks the persisted value as still worth a recovery re-read
    // before the first write is allowed to overwrite it.
    this.recoveryPending = this.persistGraceUntilMs > 0;
  }

  getSnapshot(): PowerCalibrationSnapshot {
    return this.snapshot;
  }

  /**
   * Resolve the pending recovery re-read before the first post-grace write.
   * The abandon-grace window blocks writes while a transiently unreadable
   * boot read might still recover, but blocking alone only postpones the
   * overwrite — this re-read is what actually recovers the value, which is the
   * whole point of the pairing: grace alone defers the damage, the re-read
   * undoes it.
   * Decision table:
   *  - Value present → normalise (prune mirrors what the load path would
   *    have done, honouring the configured retention) and merge under the
   *    in-memory state; write.
   *  - Value absent, marker absent → genuine wipe/fresh state; write.
   *  - Value absent, marker present (or marker read threw) → transient miss;
   *    defer until `DEFAULT_RECOVERY_DEFERRAL_MS` past that arm's FIRST
   *    deferred attempt, then treat as genuinely gone (writing over an
   *    absent key destroys nothing).
   *  - Re-read threw → defer with no deadline: every retry re-reads, so a
   *    healed SDK recovers the history, while a deadline would overwrite it
   *    at exactly the moment the SDK heals. While the SDK throws on reads,
   *    the paired write would almost certainly fail anyway. Past its own
   *    deferral window the log escalates to warn so a permanent stall is
   *    triagable.
   *
   * This is the ONLY seam over the recovery state machine, and only the
   * write path (`writeAndMark`, via `persistPowerCalibrationIfDue` /
   * `persistPowerCalibrationFlush`) may call it: the throttle, the deferral
   * windows, and the settle step are private precisely so no other caller
   * can settle recovery without performing the re-read — settling from
   * outside would silently disarm first-write protection.
   */
  resolveRecoveryForWrite(
    params: { homey: HomeyRuntime; nowMs: number },
    snapshot: PowerCalibrationSnapshot,
  ): RecoveryWriteResolution {
    if (!this.recoveryPending) return { kind: 'ready', snapshot };
    // Rate-limit: without this gate the deferral path re-reads and logs on
    // every power sample (10 s) for as long as the SDK stays broken. The
    // ordinary debounce cannot help — it never advances before the first
    // successful write.
    if (!this.beginRecoveryAttempt(params.nowMs)) return { kind: 'deferred' };
    const reread = readPersistedSnapshot(params.homey);
    if (!reread.threw && reread.value !== undefined && reread.value !== null) {
      const recovered = pruneStale(
        normalizePowerCalibrationSnapshot(reread.value),
        this.pruneMaxAgeMs,
        params.nowMs,
      );
      this.settleRecovery({ kind: 'recovered', snapshot: recovered });
      moduleLogger.info({
        event: 'power_calibration_recovery_merged',
        recoveredDevices: Object.keys(recovered.devices).length,
        inMemoryDevices: Object.keys(snapshot.devices).length,
      });
      return { kind: 'ready', snapshot: this.snapshot };
    }
    if (!reread.threw) {
      const markerRead = readInitMarker(params.homey);
      const markerPresent = markerRead.threw ? true : markerRead.value;
      if (!markerPresent) {
        // Absent value and no we've-written-before marker: nothing was ever
        // (or is any longer) persisted, so there is nothing to recover.
        this.settleRecovery({ kind: 'nothing_recoverable' });
        return { kind: 'ready', snapshot };
      }
      if (this.noteRecoveryDeferred(params.nowMs, 'transient_miss') === 'past_window') {
        this.settleRecovery({ kind: 'nothing_recoverable' });
        moduleLogger.warn({ event: 'power_calibration_recovery_abandoned' });
        return { kind: 'ready', snapshot };
      }
      moduleLogger.info({
        event: 'power_calibration_recovery_write_deferred',
        reason: 'transient_miss',
      });
      return { kind: 'deferred' };
    }
    const deferredPayload = {
      event: 'power_calibration_recovery_write_deferred',
      reason: 'read_threw',
    };
    if (this.noteRecoveryDeferred(params.nowMs, 'read_threw') === 'past_window') {
      moduleLogger.warn(deferredPayload);
    } else {
      moduleLogger.info(deferredPayload);
    }
    return { kind: 'deferred' };
  }

  /**
   * Throttle gate for recovery re-reads: at most one attempt per persist
   * debounce window. Records the attempt when it admits one.
   */
  private beginRecoveryAttempt(nowMs: number): boolean {
    if (nowMs - this.lastRecoveryAttemptMs < this.persistDebounceMs) return false;
    this.lastRecoveryAttemptMs = nowMs;
    return true;
  }

  /**
   * Record that a recovery attempt could not read the persisted value and had
   * to defer the write. The first call for an arm arms THAT arm's deferral
   * window; the answer says whether it has since elapsed. The *transient-miss*
   * arm abandons recovery on `past_window` (the value has been absent across
   * its own spaced re-reads and writing over an absent key destroys nothing);
   * the *thrown* arm never abandons and uses `past_window` only to escalate
   * its log level, so a permanent read stall is visible to log triage.
   */
  private noteRecoveryDeferred(
    nowMs: number,
    arm: 'read_threw' | 'transient_miss',
  ): 'within_window' | 'past_window' {
    if (arm === 'read_threw') {
      if (this.readThrewDeferralUntilMs === 0) {
        this.readThrewDeferralUntilMs = nowMs + DEFAULT_RECOVERY_DEFERRAL_MS;
      }
      return nowMs < this.readThrewDeferralUntilMs ? 'within_window' : 'past_window';
    }
    if (this.transientMissDeferralUntilMs === 0) {
      this.transientMissDeferralUntilMs = nowMs + DEFAULT_RECOVERY_DEFERRAL_MS;
    }
    return nowMs < this.transientMissDeferralUntilMs ? 'within_window' : 'past_window';
  }

  /**
   * Settle the recovery re-read. `recovered` merges the re-read history under
   * the in-memory accepted state (in-memory wins per (device, step); recovered
   * fills everything else); `nothing_recoverable` records that the persisted
   * value is genuinely gone. Leaves the dirty flag as-is in both arms: a merge
   * with no pending mutations does not create something to write, and pending
   * mutations still need the write they were waiting for.
   */
  private settleRecovery(outcome: RecoveredCalibrationHistory): void {
    if (outcome.kind === 'recovered') {
      this.snapshot = mergeRecoveredCalibrationHistory({
        inMemory: this.snapshot,
        recovered: outcome.snapshot,
      });
    }
    this.recoveryPending = false;
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

  /**
   * Event-driven entrypoint: evaluate a single device snapshot when the device
   * manager has just observed a mutation that may yield a new calibration
   * sample (measure_power value changed, or reportedStepId changed). Returns
   * `null` when the snapshot is ineligible — caller treats that as a silent
   * no-op. Eligibility, freshness, and band gates are handled here and inside
   * `recordSample`.
   */
  ingestDeviceSnapshot(
    snapshot: TargetDeviceSnapshot & MeasuredPowerObservedProbe
      & SteppedLoadDescriptorProbe & ReportedStepObservedProbe,
    nowMs: number,
  ): IngestDeviceSnapshotOutcome {
    const sample = buildSampleFromDeviceSnapshot(snapshot, nowMs);
    if (!sample) return null;
    return this.recordSample(sample);
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
  homey: HomeyRuntime;
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

function readPersistedSnapshot(homey: HomeyRuntime): SettingsReadResult<unknown> {
  // The Homey SDK reads can transiently throw on startup. A throw is treated
  // as a missing-with-marker-present read so the load-grace window engages
  // and a subsequent recovery read can rebuild the prior history (per the
  // "Homey SDK reads can transiently fail" rule).
  try {
    return { value: homey.settings.get(POWER_CALIBRATION), threw: false };
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
  homey: HomeyRuntime;
  store: PowerCalibrationStore;
  nowMs: number;
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
  homey: HomeyRuntime;
  store: PowerCalibrationStore;
  nowMs: number;
}): boolean {
  const snapshot = params.store.snapshotForFlush(params.nowMs);
  if (!snapshot) return false;
  return writeAndMark(params, snapshot);
}

function writeAndMark(
  params: {
    homey: HomeyRuntime;
    store: PowerCalibrationStore;
    nowMs: number;
  },
  snapshot: PowerCalibrationSnapshot,
): boolean {
  const resolution = params.store.resolveRecoveryForWrite(
    { homey: params.homey, nowMs: params.nowMs },
    snapshot,
  );
  if (resolution.kind === 'deferred') return false;
  try {
    params.homey.settings.set(POWER_CALIBRATION, resolution.snapshot);
    params.store.markPersisted(params.nowMs);
  } catch (err) {
    moduleLogger.error({
      event: 'power_calibration_persist_failed',
      err: normalizeError(err),
    });
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

function readInitMarker(homey: HomeyRuntime): SettingsReadResult<boolean> {
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

function writeInitMarkerBestEffort(homey: HomeyRuntime): void {
  // Best-effort: failure means the next load or persist retries the write,
  // which is harmless because the marker is idempotent.
  try {
    homey.settings.set(POWER_CALIBRATION_INITIALIZED, true);
  } catch {
    // Non-fatal — the main calibration snapshot is unaffected.
  }
}

function buildSampleFromDeviceSnapshot(
  snapshot: TargetDeviceSnapshot & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe,
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

function isEligiblePowerCalibrationSnapshot(
  snapshot: TargetDeviceSnapshot & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe,
): snapshot is TargetDeviceSnapshot & SteppedLoadDescriptorFields & {
  reportedStepId: string;
  measuredPowerKw: number;
  lastFreshDataMs: number;
} {
  // The profile's presence IS the stepped-load kind
  // (`packages/shared-domain/src/steppedLoadObservedState.ts`), and the narrowed
  // shape guarantees a `SteppedLoadProfile` — no second presence or shape check.
  if (!isSteppedLoadSnapshot(snapshot)) return false;
  if (snapshot.steppedLoadProfile.steps.length === 0) return false;
  // Only sample when there is a *reported* step (real telemetry, not an
  // assumed-step fallback). The producer only sets `reportedStepId` from a
  // native/flow report; an assumed fallback never populates it, so a present
  // `reportedStepId` is exactly the previous `actualStepSource === 'reported'`
  // gate. Sampling on an assumed step would attribute measured power to a step
  // the device may never have visited.
  if (typeof snapshot.reportedStepId !== 'string' || snapshot.reportedStepId.length === 0) return false;
  // `stepCommandPending` is not on the raw snapshot, so the guard that used to
  // read it here was a no-op. A real pending signal has to reach this seam
  // through the snapshot decomposition before sampling can gate on one.

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

/**
 * Default per-(device, step) debounce for the event-driven hook. Telemetry
 * from EV chargers and inverter-style heaters can publish `measure_power`
 * every 1–2 s; without this floor the EMA inside `recordSample` would saturate
 * its `alpha` term to MIN_ALPHA within ~30 s of operation and stop responding
 * to legitimate drift. Mirrors the prior `DEFAULT_CADENCE_MIN_INTERVAL_MS` that
 * the retired periodic sweep applied inside the store.
 */
const DEFAULT_HOOK_CADENCE_MIN_INTERVAL_MS = 30_000;

/**
 * Build a `DeviceTransport.onSnapshotMutated` callback that forwards each
 * eligible mutation to the calibration store. Emits a single per-sample
 * structured debug record (one device, one outcome) when an emitter is
 * supplied — never the bulk aggregate that the retired periodic sweep used
 * to produce.
 *
 * Holds a per-(device, step) debounce so a chatty device that publishes
 * measure_power every second does not flood the EMA with samples that all
 * reflect the same underlying steady-state draw.
 */
export function createCalibrationSnapshotMutationHook(params: {
  /** Resolved on every invocation — the app replaces its store reference after
   *  the initial DeviceTransport construction, so the callback must not
   *  capture it. */
  getStore: () => PowerCalibrationStore;
  debugStructured?: StructuredDebugEmitter;
  /** Override the per-(device, step) debounce. Defaults to 30 s. Set to 0 to
   *  disable, primarily for tests. */
  minIntervalMs?: number;
}): (
  snapshot: TargetDeviceSnapshot & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe,
  nowMs: number,
) => void {
  const { getStore, debugStructured } = params;
  const minIntervalMs = params.minIntervalMs ?? DEFAULT_HOOK_CADENCE_MIN_INTERVAL_MS;
  const lastIngestMsByDeviceStep = new Map<string, number>();
  return (snapshot, nowMs) => {
    const stepId = snapshot.reportedStepId;
    const debounceKey = minIntervalMs > 0 && typeof stepId === 'string' && stepId.length > 0
      ? `${snapshot.id}::${stepId}`
      : null;
    if (debounceKey !== null) {
      const previous = lastIngestMsByDeviceStep.get(debounceKey);
      if (previous !== undefined && nowMs - previous < minIntervalMs) return;
    }
    const outcome = getStore().ingestDeviceSnapshot(snapshot, nowMs);
    // Only record the debounce cursor on an accepted sample. The debounce
    // exists solely to stop chatty telemetry from saturating EMA `alpha`, and
    // `alpha` only advances on accepted samples — `recordSample` does not
    // mutate state on rejection. Debouncing on rejected outcomes
    // (`stale_observation`, `above_step_ceiling`, etc.) would silently drop
    // the next valid sample for up to minIntervalMs without protecting
    // anything in return.
    if (outcome?.accepted === true && debounceKey !== null) {
      lastIngestMsByDeviceStep.set(debounceKey, nowMs);
    }
    if (!outcome || !debugStructured) return;
    // Memory back-pressure: bounded. The `power_calibration` topic is off by
    // default, and `getStructuredDebugEmitter` (app.ts) returns a no-op when
    // the topic is disabled. When enabled, each call hits the pino root logger
    // whose destination (`lib/logging/homeyDestination.ts`) is a sync Writable
    // that invokes `callback()` immediately and dispatches the JSON line to
    // Homey SDK `this.log()` / `this.error()` — no in-memory queue, no
    // unbounded buffer; rotation is handled externally by the Homey supervisor.
    // The per-(device, step) debounce above further caps the emit rate to
    // roughly two records per minute per device under steady load.
    if (outcome.accepted) {
      debugStructured({
        event: 'power_calibration_sample_accepted',
        deviceId: snapshot.id,
        deviceName: snapshot.name,
        stepId: snapshot.reportedStepId,
        measuredPowerKw: snapshot.measuredPowerKw,
        reset: outcome.reset,
      });
      return;
    }
    debugStructured({
      event: 'power_calibration_sample_skipped',
      deviceId: snapshot.id,
      deviceName: snapshot.name,
      stepId: snapshot.reportedStepId,
      measuredPowerKw: snapshot.measuredPowerKw,
      reason: outcome.reason,
    });
  };
}

