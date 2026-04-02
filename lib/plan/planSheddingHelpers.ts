import type CapacityGuard from '../core/capacityGuard';
import type { Logger as PinoLogger } from '../logging/logger';
import type { PlanContext } from './planContext';
import {
  RECENT_RESTORE_OVERSHOOT_BYPASS_KW,
  RECENT_RESTORE_SHED_GRACE_MS,
} from './planConstants';
import type { PlanEngineState } from './planState';
import type { PlanInputDevice } from './planTypes';

const OVERSHOOT_ESCALATION_INTERVAL_MS = 30 * 1000;

export type BaseShedCandidate = PlanInputDevice & {
  priority: number;
  effectivePower: number;
  recentlyRestored: boolean;
  unconfirmedRelief: boolean;
};

export type BinaryShedCandidate = BaseShedCandidate & { kind: 'binary' };

export type SteppedShedCandidate = BaseShedCandidate & {
  kind: 'stepped';
  fromStepId: string;
  toStepId: string;
  preemptiveStepDown: boolean;
};

export type TemperatureShedCandidate = BaseShedCandidate & {
  kind: 'temperature';
  targetCapabilityId: string;
  shedTemperature: number;
};

export type ShedCandidate = BinaryShedCandidate | SteppedShedCandidate | TemperatureShedCandidate;

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
  structuredLog?.warn({
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

export function selectShedDevices(params: {
  candidates: ShedCandidate[];
  needed: number;
  reason: string;
  logDebug: (...args: unknown[]) => void;
}): {
  shedSet: Set<string>;
  shedReasons: Map<string, string>;
  steppedDesiredStepByDeviceId: Map<string, string>;
  temperatureShedTargets: Map<string, { temperature: number; capabilityId: string }>;
} {
  const {
    candidates,
    needed,
    reason,
    logDebug,
  } = params;
  const shedSet = new Set<string>();
  const shedReasons = new Map<string, string>();
  const steppedDesiredStepByDeviceId = new Map<string, string>();
  const temperatureShedTargets = new Map<string, { temperature: number; capabilityId: string }>();
  let remaining = needed;
  for (const nextCandidate of candidates) {
    if (remaining <= 0) break;
    if (nextCandidate.effectivePower <= 0) continue;
    shedSet.add(nextCandidate.id);
    shedReasons.set(nextCandidate.id, reason);
    if (nextCandidate.kind === 'stepped') {
      steppedDesiredStepByDeviceId.set(nextCandidate.id, nextCandidate.toStepId);
      logDebug(
        `Plan: stepping down ${nextCandidate.name} ${nextCandidate.fromStepId} -> ${nextCandidate.toStepId} `
        + `(~${nextCandidate.effectivePower.toFixed(2)}kW relief)`,
      );
      if (nextCandidate.preemptiveStepDown && !nextCandidate.unconfirmedRelief) break;
    }
    if (nextCandidate.kind === 'temperature') {
      temperatureShedTargets.set(nextCandidate.id, {
        temperature: nextCandidate.shedTemperature,
        capabilityId: nextCandidate.targetCapabilityId,
      });
      logDebug(
        `Plan: setting shed temperature ${nextCandidate.name} -> ${nextCandidate.shedTemperature} `
        + `(~${nextCandidate.effectivePower.toFixed(2)}kW relief)`,
      );
    }
    if (nextCandidate.unconfirmedRelief) continue;
    remaining -= nextCandidate.effectivePower;
  }
  return { shedSet, shedReasons, steppedDesiredStepByDeviceId, temperatureShedTargets };
}

export function resolveShedReason(limitSource: PlanContext['softLimitSource']): string {
  if (limitSource === 'daily') return 'shed due to daily budget';
  return 'shed due to capacity';
}

function shouldEscalateOvershoot(state: PlanEngineState, nowTs: number): boolean {
  if (typeof state.overshootStartedMs !== 'number') return false;
  if (nowTs - state.overshootStartedMs < OVERSHOOT_ESCALATION_INTERVAL_MS) return false;
  const lastAttemptMs = state.lastOvershootMitigationMs
    ?? state.lastOvershootEscalationMs
    ?? state.overshootStartedMs;
  return nowTs - lastAttemptMs >= OVERSHOOT_ESCALATION_INTERVAL_MS;
}
