import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanContext } from '../planContext';
import type { ShedCandidate } from './types';

export function selectShedDevices(params: {
  candidates: ShedCandidate[];
  needed: number;
  reason: DeviceReason;
  logDebug: (...args: unknown[]) => void;
  shedAllCandidates?: boolean;
}): {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
} {
  const {
    candidates,
    needed,
    reason,
    logDebug,
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
    logSelectedCandidate(nextCandidate, logDebug);
    if (shouldStopAfterCandidate({ candidate: nextCandidate, shedAllCandidates })) break;
    if (nextCandidate.unconfirmedRelief) continue;
    remaining -= nextCandidate.effectivePower;
  }
  return { shedSet, shedReasons };
}

function shouldStopSelection(params: { shedAllCandidates: boolean; remaining: number }): boolean {
  return !params.shedAllCandidates && params.remaining <= 0;
}

function logSelectedCandidate(candidate: ShedCandidate, logDebug: (...args: unknown[]) => void): void {
  if (candidate.kind === 'stepped') {
    logDebug(
      `Plan: stepping down ${candidate.name} ${candidate.fromStepId} -> ${candidate.toStepId} `
      + `(~${candidate.effectivePower.toFixed(2)}kW relief)`,
    );
    return;
  }
  if (candidate.kind === 'temperature') {
    logDebug(
      `Plan: setting shed temperature ${candidate.name} -> ${candidate.shedTemperature} `
      + `(~${candidate.effectivePower.toFixed(2)}kW relief)`,
    );
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
