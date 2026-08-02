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

export function resolveShedReason(
  limitSource: PlanContext['softLimitSource'],
  capacityBreached: boolean,
  hourlyBudgetExhausted = false,
): DeviceReason {
  // The exhausted hour outranks both soft-limit sources: the hour's kWh is
  // spent, so no freed power (capacity-side or budget-side) admits anything
  // before the hour rolls over. Its own reason code renders time-based copy on
  // the card instead of a kW gap, which would be dishonest here.
  if (hourlyBudgetExhausted) {
    return { code: PLAN_REASON_CODES.hourlyBudget, detail: null };
  }
  // `daily` is only the BINDING soft limit — when capacity is breached too, total
  // is over both and capacity is the constraint actually doing the work. Naming
  // the daily budget there is wrong for every device in the cycle, and doubly so
  // for a budget-exempt one, which reaches this point ONLY because the breach
  // overrode its exemption (`shedding/candidates.ts`). It also mis-buckets the
  // overview into the releasable side and offers a "Let it run now" rescue that
  // cannot help: releasing a budget exemption does not create capacity headroom
  // (the same reasoning `planDiagnostics.ts` applies to capacity-bound holds).
  if (limitSource === 'daily' && !capacityBreached) {
    return { code: PLAN_REASON_CODES.dailyBudget, detail: null };
  }
  return { code: PLAN_REASON_CODES.capacity, detail: null };
}
