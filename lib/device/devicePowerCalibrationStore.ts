/**
 * The calibration snapshot, held in memory and written through to the
 * userdata database as each change is accepted.
 *
 * Learned data lives there by ruling (`notes/settings-key-ownership.md`
 * § "Which store a key lives in"): one row per device, diffed, so an accepted
 * sample rewrites that device's row and nothing else, and a write costs the
 * bytes written. That is also why there is no debounce, dirty flag or flush:
 * nothing is buffered, so a restart (or an OOM kill) loses nothing accepted.
 * Pure-store logic lives in `lib/device/devicePowerCalibration.ts`.
 */
import type { DeviceCalibration, PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';
import {
  type LegacyStepReset,
  type RecordSampleInput,
  type RecordSampleOutcome,
  normalizeDeviceCalibration,
  normalizePersistedPowerCalibration,
  POWER_CALIBRATION_VERSION,
  pruneStale,
  recordSample,
  withLegacyCalibrationUnder,
} from './devicePowerCalibration';
import type { SettingsPort } from '../ports/homeyRuntime';
import { importLegacySettingsKey, isLegacySettingsKeyListed } from '../store/legacySettingsImport';
import { createJsonRowTable } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { POWER_CALIBRATION } from '../utils/settingsKeys';
import type {
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorFields,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';

const moduleLogger = getLogger('device/power-calibration-store');

const DEFAULT_PRUNE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The calibration's rows: one per device, its steps and last touch as JSON.
 * A row that does not read as a device calibration is deleted as read
 * (`lib/store/jsonRowTable.ts`); a device whose steps are partly malformed
 * keeps the steps that read.
 */
export type PowerCalibrationRepository = {
  /** What the store holds; no devices when it holds none. Throws only on I/O. */
  read(): PowerCalibrationSnapshot;
  /** Persist `snapshot`, touching only the devices that differ from what the store holds. */
  write(snapshot: PowerCalibrationSnapshot): void;
};

export const createPowerCalibrationRepository = (db: UserdataDatabase): PowerCalibrationRepository => {
  const devices = createJsonRowTable<DeviceCalibration>(
    db, 'power_calibration_devices', ['device_id', 'calibration_json'],
    (value) => normalizeDeviceCalibration(value) ?? undefined,
  );
  return {
    read: () => ({
      version: POWER_CALIBRATION_VERSION,
      devices: Object.fromEntries(db.transaction(() => devices.read())),
    }),
    write: (snapshot) => db.transaction(() => devices.write(new Map(Object.entries(snapshot.devices)))),
  };
};

/**
 * The one-shot import of the legacy `power_calibration` settings blob into the
 * store, run at boot before the store is read. Rules and their reasons:
 * `lib/store/legacySettingsImport.ts`. Samples are written from an empty boot
 * (a deferred import still calibrates), so "the store holds rows" never
 * retires the key: the blob goes under what the store holds instead. A blob a
 * build without the step floor wrote has its under-learned steps reset on the
 * way in, each named once.
 */
export const importLegacyPowerCalibration = (settings: SettingsPort, repository: PowerCalibrationRepository): void => {
  if (isLegacySettingsKeyListed(settings, POWER_CALIBRATION) !== true) return;
  const result = importLegacySettingsKey(settings, POWER_CALIBRATION, {
    holds: () => false,
    adopt: (raw) => {
      const legacy = normalizePersistedPowerCalibration(raw);
      if (legacy === null) return false;
      repository.write(withLegacyCalibrationUnder(repository.read(), legacy.snapshot));
      if (legacy.kind === 'upgraded') logLegacyStepReset(legacy.resetSteps);
      return true;
    },
  });
  if (result.outcome === 'imported') {
    moduleLogger.info({ event: 'legacy_power_calibration_imported' });
  } else if (result.outcome === 'retired') {
    moduleLogger.info({ event: 'legacy_power_calibration_key_retired', reason: result.reason });
  } else {
    moduleLogger.warn({
      event: 'legacy_power_calibration_import_deferred',
      reason: result.reason,
      ...(result.error === undefined ? {} : { err: normalizeError(result.error) }),
    });
  }
};

/**
 * One line per import of a value without the step-floor mark, naming every
 * step the reset dropped (possibly none) so a relearning rung can be traced
 * to it.
 */
function logLegacyStepReset(resetSteps: LegacyStepReset[]): void {
  moduleLogger.info({
    event: 'power_calibration_under_learned_steps_reset',
    resetCount: resetSteps.length,
    resetSteps,
  });
}

/**
 * Outcome of {@link PowerCalibrationStore.ingestDeviceSnapshot}. `null` means
 * the snapshot was ineligible (not stepped-load, no fresh data, off-step) and
 * the caller should silently no-op — there is no useful debug payload for an
 * event-driven trigger that simply does not apply.
 */
export type IngestDeviceSnapshotOutcome = RecordSampleOutcome | null;

/**
 * Mutable in-memory holder around the immutable {@link recordSample}
 * pipeline, writing every accepted change through to its repository.
 */
export class PowerCalibrationStore {
  private snapshot: PowerCalibrationSnapshot;

  constructor(private readonly repository: PowerCalibrationRepository) {
    this.snapshot = repository.read();
  }

  getSnapshot(): PowerCalibrationSnapshot {
    return this.snapshot;
  }

  /** Submit a sample. Updates the snapshot, and the store, when accepted. */
  recordSample(input: RecordSampleInput): RecordSampleOutcome {
    const outcome = recordSample(this.snapshot, input);
    if (outcome.accepted) this.adopt(outcome.snapshot);
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

  /** Drop devices that haven't been touched in `maxAgeMs`, so the store stays bounded across device lifecycles. */
  prune(nowMs: number, maxAgeMs: number = DEFAULT_PRUNE_MAX_AGE_MS): void {
    const next = pruneStale(this.snapshot, maxAgeMs, nowMs);
    if (next !== this.snapshot) this.adopt(next);
  }

  /**
   * Hold `next` and write it through. A write that fails keeps it in memory,
   * and the next write carries its rows too: the diff base is what the
   * database last committed.
   */
  private adopt(next: PowerCalibrationSnapshot): void {
    this.snapshot = next;
    try {
      this.repository.write(next);
    } catch (err) {
      moduleLogger.error({ event: 'power_calibration_persist_failed', err: normalizeError(err) });
    }
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
 * Per-(device, step) debounce for the event-driven hook. Telemetry
 * from EV chargers and inverter-style heaters can publish `measure_power`
 * every 1–2 s; without this floor the EMA inside `recordSample` would saturate
 * its `alpha` term to MIN_ALPHA within ~30 s of operation and stop responding
 * to legitimate drift. Mirrors the prior `DEFAULT_CADENCE_MIN_INTERVAL_MS` that
 * the retired periodic sweep applied inside the store.
 */
const HOOK_CADENCE_MIN_INTERVAL_MS = 30_000;

/**
 * Build a `DeviceTransport.onSnapshotMutated` callback that forwards each
 * eligible mutation to the calibration store. Emits a single per-sample
 * structured debug record (one device, one outcome) — never the bulk
 * aggregate that the retired periodic sweep used to produce.
 *
 * Holds a per-(device, step) debounce so a chatty device that publishes
 * measure_power every second does not flood the EMA with samples that all
 * reflect the same underlying steady-state draw. The same debounce bounds the
 * store's writes, one per accepted sample, to about two a minute per step.
 */
export function createCalibrationSnapshotMutationHook(
  store: PowerCalibrationStore,
  debugStructured: StructuredDebugEmitter,
): (
  snapshot: TargetDeviceSnapshot & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe,
  nowMs: number,
) => void {
  const lastIngestMsByDeviceStep = new Map<string, number>();
  const lastSkipLogMsByDeviceStepReason = new Map<string, number>();
  // Whether this skip line may be written now, claiming the slot when it may.
  // Unkeyed calls (no reported step) are never capped, as the ingest debounce
  // does not cap them either.
  const claimSkipLogSlot = (debounceKey: string | null, reason: string, nowMs: number): boolean => {
    if (debounceKey === null) return true;
    const skipKey = `${debounceKey}::${reason}`;
    const previous = lastSkipLogMsByDeviceStepReason.get(skipKey);
    if (previous !== undefined && nowMs - previous < HOOK_CADENCE_MIN_INTERVAL_MS) return false;
    lastSkipLogMsByDeviceStepReason.set(skipKey, nowMs);
    return true;
  };
  return (snapshot, nowMs) => {
    const stepId = snapshot.reportedStepId;
    const debounceKey = typeof stepId === 'string' && stepId.length > 0
      ? `${snapshot.id}::${stepId}`
      : null;
    if (debounceKey !== null) {
      const previous = lastIngestMsByDeviceStep.get(debounceKey);
      if (previous !== undefined && nowMs - previous < HOOK_CADENCE_MIN_INTERVAL_MS) return;
    }
    const outcome = store.ingestDeviceSnapshot(snapshot, nowMs);
    // Only record the debounce cursor on an accepted sample. The debounce
    // exists solely to stop chatty telemetry from saturating EMA `alpha`, and
    // `alpha` only advances on accepted samples — `recordSample` does not
    // mutate state on rejection. Debouncing on rejected outcomes
    // (`stale_observation`, `above_step_ceiling`, etc.) would silently drop
    // the next valid sample for up to the debounce window without protecting
    // anything in return.
    if (outcome?.accepted === true && debounceKey !== null) {
      lastIngestMsByDeviceStep.set(debounceKey, nowMs);
    }
    if (!outcome) return;
    // Memory back-pressure: bounded. The `power_calibration` topic is off by
    // default, and `getStructuredDebugEmitter` (app.ts) returns a no-op when
    // the topic is disabled. When enabled, each call hits the pino root logger
    // whose destination (`lib/logging/homeyDestination.ts`) is a sync Writable
    // that invokes `callback()` immediately and dispatches the JSON line to
    // Homey SDK `this.log()` / `this.error()` — no in-memory queue, no
    // unbounded buffer; rotation is handled externally by the Homey supervisor.
    // The per-(device, step) debounce above caps accepted records to roughly
    // two a minute per device under steady load. It does not apply to rejected
    // samples, which a trickling charger on its lowest rung produces on every
    // reading for as long as the car trickles, so the skip line is capped the
    // same way, per (device, step, reason), below.
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
    if (!claimSkipLogSlot(debounceKey, outcome.reason, nowMs)) return;
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

