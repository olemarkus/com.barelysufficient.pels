import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanContext } from '../planContext';
import type { ShedCandidate } from './types';

export function selectShedDevices(params: {
  candidates: ShedCandidate[];
  needed: number;
  reason: DeviceReason;
  logDebug: (...args: unknown[]) => void;
}): {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
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
  const shedReasons = new Map<string, DeviceReason>();
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

export function resolveShedReason(limitSource: PlanContext['softLimitSource']): DeviceReason {
  if (limitSource === 'daily') return { code: PLAN_REASON_CODES.dailyBudget, detail: null };
  return { code: PLAN_REASON_CODES.capacity, detail: null };
}
