import type CapacityGuard from '../../power/capacityGuard';
import type { Logger as PinoLogger } from '../../logging/logger';
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import {
  RECENT_RESTORE_OVERSHOOT_BYPASS_KW,
  RECENT_RESTORE_SHED_GRACE_MS,
} from '../planConstants';
import type { OvershootStats } from './types';

const OVERSHOOT_ESCALATION_INTERVAL_MS = 30 * 1000;

export function resolveSameMeasurementSheddingDecision(params: {
  state: PlanEngineState;
  measurementTs: number | null;
  nowTs: number;
  allowEscalation?: boolean;
}): { skip: boolean; escalatedSameSample: boolean } {
  const { state, measurementTs, nowTs, allowEscalation = true } = params;
  const alreadyShedThisSample = measurementTs !== null
    && measurementTs === state.lastShedPlanMeasurementTs;
  if (!alreadyShedThisSample) {
    return { skip: false, escalatedSameSample: false };
  }
  if (!allowEscalation) {
    return { skip: true, escalatedSameSample: false };
  }
  const escalatedSameSample = shouldEscalateOvershoot(state, nowTs);
  return {
    skip: !escalatedSameSample,
    escalatedSameSample,
  };
}

export function emitOvershootEscalationBlocked(params: {
  structuredLog?: PinoLogger;
  capacityGuard?: CapacityGuard;
  neededKw: number;
  remainingCandidates: number;
  measurementTs: number | null;
  nowTs: number;
}): void {
  const {
    structuredLog,
    capacityGuard,
    neededKw,
    remainingCandidates,
    measurementTs,
    nowTs,
  } = params;
  structuredLog?.info({
    event: 'capacity_overshoot_escalation_blocked',
    incidentId: capacityGuard?.getCurrentIncidentId() ?? undefined,
    reasonCode: 'no_candidates',
    neededKw,
    remainingCandidates,
    measurementAgeMs: measurementTs === null ? null : Math.max(0, nowTs - measurementTs),
  });
}

export function resolveRecentRestoreState(params: {
  device: Pick<PlanInputDevice, 'id' | 'name'>;
  state: PlanEngineState;
  nowTs: number;
  needed: number;
  logDebug: (...args: unknown[]) => void;
}): boolean {
  const {
    device,
    state,
    nowTs,
    needed,
    logDebug,
  } = params;
  const lastRestore = state.lastDeviceRestoreMs[device.id];
  if (!lastRestore) return false;
  const sinceRestoreMs = nowTs - lastRestore;
  const recentlyRestored = sinceRestoreMs < RECENT_RESTORE_SHED_GRACE_MS;
  const overshootSevere = needed > RECENT_RESTORE_OVERSHOOT_BYPASS_KW;
  if (recentlyRestored && !overshootSevere) {
    logDebug(
      `Plan: deprioritizing ${device.name} for shedding `
      + `(recently restored ${Math.round(sinceRestoreMs / 1000)}s ago, `
      + `overshoot ${needed.toFixed(2)}kW)`,
    );
    return true;
  }
  return false;
}

export function buildOvershootStats(params: {
  needed: number;
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
}): OvershootStats {
  const {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
  } = params;
  return {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
    allShedCandidatesExhausted: eligibleCandidateCount === 0,
    controlRecoverable: reducibleControlledKw > 0,
  };
}

function shouldEscalateOvershoot(state: PlanEngineState, nowTs: number): boolean {
  if (typeof state.overshootStartedMs !== 'number') return false;
  if (nowTs - state.overshootStartedMs < OVERSHOOT_ESCALATION_INTERVAL_MS) return false;
  const lastAttemptMs = state.lastOvershootMitigationMs
    ?? state.lastOvershootEscalationMs
    ?? state.overshootStartedMs;
  return nowTs - lastAttemptMs >= OVERSHOOT_ESCALATION_INTERVAL_MS;
}
