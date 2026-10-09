import type CapacityGuard from '../../power/capacityGuard';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../../logging/logger';
import type { PlanEngineState, StorageLeverState } from '../planState';
import type { MeasuredPower } from '../planContext';
import type { PlanInputDevice } from '../planTypes';
import {
  RECENT_RESTORE_OVERSHOOT_BYPASS_KW,
  RECENT_RESTORE_SHED_GRACE_MS,
} from '../planConstants';
import { PENDING_RELIEF_EPSILON_KW, resolvePendingShedRelief, type PendingShedRelief } from './pendingRelief';
import type { OvershootStats } from './types';

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
  measurementTs: number | null,
  measurementPowerW: number | null,
  nowTs: number,
  power: MeasuredPower,
  /** The holds this cycle's storage stage left (`StorageRelief.levers`). */
  storageLevers: Readonly<Record<string, StorageLeverState>>,
): SameMeasurementSheddingDecision {
  const alreadyShedThisSample = measurementTs !== null
    && measurementTs === state.lastShedPlanMeasurementTs;
  const pending = resolvePendingShedRelief(
    state.shedPlanLatch, devices, measurementPowerW, nowTs, storageLevers, !power.gridBreached,
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
  measurementTs: number | null,
  nowTs: number,
  structuredLog?: PinoLogger,
): void {
  structuredLog?.info({
    event: 'capacity_overshoot_escalation_blocked',
    incidentId: capacityGuard.getCurrentIncidentId() ?? undefined,
    reasonCode: 'no_candidates',
    neededKw,
    remainingCandidates,
    measurementAgeMs: measurementTs === null ? null : Math.max(0, nowTs - measurementTs),
  });
}

export function resolveRecentRestoreState(
  device: Pick<PlanInputDevice, 'id' | 'name'>,
  state: PlanEngineState,
  nowTs: number,
  /** Severity, sentinel-carrying — this is the one reader that wants it. */
  needed: number,
  debugStructured?: StructuredDebugEmitter,
): boolean {
  const lastRestore = state.actuation.lastDeviceRestoreMs[device.id];
  if (!lastRestore) return false;
  const sinceRestoreMs = nowTs - lastRestore;
  const recentlyRestored = sinceRestoreMs < RECENT_RESTORE_SHED_GRACE_MS;
  const overshootSevere = needed > RECENT_RESTORE_OVERSHOOT_BYPASS_KW;
  if (recentlyRestored && !overshootSevere) {
    debugStructured?.({
      event: 'plan_shed_deprioritized_recent_restore',
      deviceId: device.id,
      deviceName: device.name,
      sinceRestoreSec: Math.round(sinceRestoreMs / 1000),
      overshootKw: needed,
    });
    return true;
  }
  return false;
}

/** The candidate-walk summary a cycle's `OvershootStats` is built from. */
export type OvershootStatsInputs = {
  needed: number;
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
  skippedCandidateCount?: number;
  skippedCandidateReasons?: OvershootStats['skippedCandidateReasons'];
};

export function buildOvershootStats(params: OvershootStatsInputs): OvershootStats {
  const {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
    skippedCandidateCount = 0,
    skippedCandidateReasons = [],
  } = params;
  return {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
    allShedCandidatesExhausted: eligibleCandidateCount === 0,
    controlRecoverable: reducibleControlledKw > 0,
    // Counted here so "no candidates" is falsifiable: a cycle with zero eligible
    // candidates can now say how many controlled devices were considered and
    // which gate stopped each. Shed-candidacy skips have no other counter — the
    // capacity summary's blocked-device counters are all RESTORE-side holds.
    skippedCandidateCount,
    skippedCandidateReasons,
  };
}
