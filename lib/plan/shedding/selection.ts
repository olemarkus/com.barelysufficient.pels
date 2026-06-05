import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { PlanContext } from '../planContext';
import type { ShedCandidate } from './types';

export function selectShedDevices(params: {
  candidates: ShedCandidate[];
  needed: number;
  reason: DeviceReason;
  debugStructured?: StructuredDebugEmitter;
  shedAllCandidates?: boolean;
}): {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
} {
  const {
    candidates,
    needed,
    reason,
    debugStructured,
    shedAllCandidates = false,
  } = params;
  const shedSet = new Set<string>();
  const shedReasons = new Map<string, DeviceReason>();
  let remaining = needed;
  for (const nextCandidate of candidates) {
    if (shouldStopSelection({ shedAllCandidates, remaining })) break;
    if (nextCandidate.effectivePower <= 0) continue;
    shedSet.add(nextCandidate.id);
    shedReasons.set(nextCandidate.id, reason);
    logSelectedCandidate(nextCandidate, debugStructured);
    if (shouldStopAfterCandidate({ candidate: nextCandidate, shedAllCandidates })) break;
    if (nextCandidate.unconfirmedRelief) continue;
    remaining -= nextCandidate.effectivePower;
  }
  return { shedSet, shedReasons };
}

function shouldStopSelection(params: { shedAllCandidates: boolean; remaining: number }): boolean {
  return !params.shedAllCandidates && params.remaining <= 0;
}

function logSelectedCandidate(candidate: ShedCandidate, debugStructured?: StructuredDebugEmitter): void {
  if (!debugStructured) return;
  if (candidate.kind === 'stepped') {
    debugStructured({
      event: 'plan_shed_step_down',
      deviceId: candidate.id,
      deviceName: candidate.name,
      fromStepId: candidate.fromStepId,
      toStepId: candidate.toStepId,
      reliefKw: candidate.effectivePower,
    });
    return;
  }
  if (candidate.kind === 'temperature') {
    debugStructured({
      event: 'plan_shed_set_temperature',
      deviceId: candidate.id,
      deviceName: candidate.name,
      shedTemperature: candidate.shedTemperature,
      reliefKw: candidate.effectivePower,
    });
  }
}

function shouldStopAfterCandidate(params: { candidate: ShedCandidate; shedAllCandidates: boolean }): boolean {
  const { candidate, shedAllCandidates } = params;
  return candidate.kind === 'stepped'
    && !shedAllCandidates
    && candidate.preemptiveStepDown
    && !candidate.unconfirmedRelief;
}

export function resolveShedReason(limitSource: PlanContext['softLimitSource']): DeviceReason {
  if (limitSource === 'daily') return { code: PLAN_REASON_CODES.dailyBudget, detail: null };
  return { code: PLAN_REASON_CODES.capacity, detail: null };
}
