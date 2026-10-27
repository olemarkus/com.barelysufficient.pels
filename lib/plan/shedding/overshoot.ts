import type CapacityGuard from '../../power/capacityGuard';
import type { LatchedMeterReading } from '../../power/lastTotalPower';
import type { Logger as PinoLogger } from '../../logging/logger';
import type { PlanEngineState, ShedPlanLatch, StorageLeverState } from '../planState';
import type { MeasuredPower } from '../planContext';
import type { PlanInputDevice } from '../planTypes';
import {
  RECENT_RESTORE_OVERSHOOT_BYPASS_KW,
  RECENT_RESTORE_SHED_GRACE_MS,
} from '../planConstants';
import { PENDING_RELIEF_EPSILON_KW, resolvePendingShedRelief, type PendingShedRelief } from './pendingRelief';

/**
 * Whether this cycle's measurement may drive a shed: it may (`proceed`,
 * possibly as a same-sample escalation of a sustained incident), it is the
 * very sample the last shed was planned from (`skip_same_sample`, which still
 * holds any decision in its window rather than dropping it), or it is a new
 * sample that does not yet show relief a recent shed counted on
 * (`credit_pending_relief`), which is credited before anything new is shed.
 *
 * The credit's window runs from the latch's own stamp, NOT the incident's
 * mitigation clock: `PlanBuilder` runs shedding before
 * `OvershootTracker.updateOvershootState`, whose entry resets that clock, which
 * would strip the anchor off the first shed of every incident — the cycle the
 * credit matters most on.
 */
export type SameMeasurementSheddingDecision =
  | { kind: 'proceed'; escalatedSameSample: boolean; pending: PendingShedRelief | null }
  | { kind: 'skip_same_sample'; pending: PendingShedRelief | null }
  | { kind: 'credit_pending_relief'; pending: PendingShedRelief };

export function resolveSameMeasurementSheddingDecision(
  state: PlanEngineState,
  devices: readonly PlanInputDevice[],
  measurement: LatchedMeterReading,
  nowTs: number,
  power: MeasuredPower,
  /** The holds this cycle's storage stage left (`StorageRelief.levers`). */
  storageLevers: Readonly<Record<string, StorageLeverState>>,
  latch: ShedPlanLatch | null,
): SameMeasurementSheddingDecision {
  const alreadyShedThisSample = measurement.atMs === state.lastShedPlanMeasurementTs;
  const pending = resolvePendingShedRelief(
    latch, devices, measurement.powerW, nowTs, storageLevers, !power.gridBreached,
  );
  if (!alreadyShedThisSample) {
    // With nothing outstanding the reading is believed as it stands; the pending
    // answer still rides along, so the retirements it found are committed.
    return pending !== null && pending.totalKw > PENDING_RELIEF_EPSILON_KW
      ? { kind: 'credit_pending_relief', pending }
      : { kind: 'proceed', escalatedSameSample: false, pending };
  }
  if (power.physicalLimitBreached && state.overshoot.shouldEscalate(nowTs)) {
    return { kind: 'proceed', escalatedSameSample: true, pending: null };
  }
  return { kind: 'skip_same_sample', pending };
}

export function emitOvershootEscalationBlocked(
  capacityGuard: CapacityGuard,
  neededKw: number,
  remainingCandidates: number,
  measurementTs: number,
  nowTs: number,
  structuredLog: PinoLogger,
): void {
  structuredLog.info({
    event: 'capacity_overshoot_escalation_blocked',
    incidentId: capacityGuard.getCurrentIncidentId() ?? undefined,
    reasonCode: 'no_candidates',
    neededKw,
    remainingCandidates,
    measurementAgeMs: Math.max(0, nowTs - measurementTs),
  });
}

export type RecentRestoreState =
  | { recentlyRestored: false }
  | { recentlyRestored: true; sinceRestoreMs: number };

export function resolveRecentRestoreState(
  device: Pick<PlanInputDevice, 'id'>,
  state: PlanEngineState,
  nowTs: number,
  /** Severity, sentinel-carrying — this is the one reader that wants it. */
  needed: number,
): RecentRestoreState {
  const lastRestore = state.actuation.lastDeviceRestoreMs[device.id];
  if (!lastRestore) return { recentlyRestored: false };
  const sinceRestoreMs = nowTs - lastRestore;
  const recentlyRestored = sinceRestoreMs < RECENT_RESTORE_SHED_GRACE_MS;
  const overshootSevere = needed > RECENT_RESTORE_OVERSHOOT_BYPASS_KW;
  return recentlyRestored && !overshootSevere
    ? { recentlyRestored: true, sinceRestoreMs }
    : { recentlyRestored: false };
}
