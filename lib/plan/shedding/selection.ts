import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { PlanContext } from '../planContext';
import { chooseShedRung } from './steppedCandidates';
import type { ShedCandidate } from './types';

/**
 * Greedy pick over the ranked candidates: take them in order until the deficit
 * is covered, and take from each one only as much as is still open.
 *
 * The loop ends on ONE condition — `remaining <= 0` — and the relief of the
 * candidate just taken is banked before that condition is asked again. It used
 * to also stop right after a preemptive step-down, back when the chosen rung
 * only decided candidacy: a step-down worth a fraction of the deficit ended the
 * cycle with the breach still open and nothing else limited. Now that the rung
 * is sized here, a step-down that covers the deficit stops the loop by covering
 * it, and one that cannot must not stop anything.
 *
 * **How deep each stepped shed goes is decided here, not at candidate-build
 * time**, and it has to be: candidates are all priced against the cycle's
 * opening deficit, before anything has been spent. A rung fixed then over-shoots
 * by whatever the earlier picks already covered — with two stepped devices
 * eligible in one cycle, a 3 kW deficit was answered by a 2 kW cut plus a second
 * cut still sized for 3 kW, shedding 5 kW to close 3. So the candidate carries
 * its priced ladder and this loop asks `chooseShedRung` for the gentlest rung
 * that covers what is left when its turn comes.
 *
 * A candidate whose relief is still unconfirmed banks nothing: it is already
 * commanded and the watts have not moved yet, so counting them would cover the
 * deficit on a promise. Note what that means downstream — the next candidate is
 * then sized as though nothing had been done, which is the honest answer while
 * the watts have not moved, and deliberately errs toward covering the breach
 * rather than toward under-shedding it.
 *
 * Three parallel maps leave here, all keyed by device id and all decided by this
 * loop: membership (`shedSet`), why (`shedReasons`), and — for a stepped
 * step-down — WHERE the device is parked (`shedStepTargets`). The third is what
 * makes the credited rung the delivered rung: materialization commands the step
 * this map names, so the deficit selection just spent is the deficit the cycle
 * actually frees.
 */
export function selectShedDevices(params: {
  candidates: ShedCandidate[];
  needed: number;
  reason: DeviceReason;
  debugStructured?: StructuredDebugEmitter;
  shedAllCandidates?: boolean;
}): {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  shedStepTargets: Map<string, string>;
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
  const shedStepTargets = new Map<string, string>();
  let remaining = needed;
  for (const nextCandidate of candidates) {
    if (shouldStopSelection({ shedAllCandidates, remaining })) break;
    if (nextCandidate.effectivePower <= 0) continue;
    const spend = resolveCandidateSpend(nextCandidate, remaining);
    shedSet.add(nextCandidate.id);
    shedReasons.set(nextCandidate.id, reason);
    if (spend.toStepId !== undefined) shedStepTargets.set(nextCandidate.id, spend.toStepId);
    logSelectedCandidate(nextCandidate, spend, debugStructured);
    if (!nextCandidate.unconfirmedRelief) remaining -= spend.reliefKw;
  }
  return { shedSet, shedReasons, shedStepTargets };
}

/** What this candidate is taken FOR: how much it frees, and where it parks. */
type CandidateSpend = {
  reliefKw: number;
  /**
   * The step the shed leaves the device at, when a step is what it changes.
   * Absent for a binary or temperature candidate, and for the prepared-binary-off
   * stepped shape: that device is already parked at its shed target and its whole
   * relief is the binary off that follows, so naming its current step as the
   * destination would cancel the off the relief was priced on.
   */
  toStepId?: string;
};

function resolveCandidateSpend(candidate: ShedCandidate, remainingKw: number): CandidateSpend {
  if (candidate.kind !== 'stepped') return { reliefKw: candidate.effectivePower };
  const rung = chooseShedRung(candidate.rungs, remainingKw);
  if (!rung) return { reliefKw: candidate.effectivePower };
  return { reliefKw: rung.reliefKw, toStepId: rung.toStepId };
}

function shouldStopSelection(params: { shedAllCandidates: boolean; remaining: number }): boolean {
  return !params.shedAllCandidates && params.remaining <= 0;
}

function logSelectedCandidate(
  candidate: ShedCandidate,
  spend: CandidateSpend,
  debugStructured?: StructuredDebugEmitter,
): void {
  if (!debugStructured) return;
  if (candidate.kind === 'stepped') {
    debugStructured({
      event: 'plan_shed_step_down',
      deviceId: candidate.id,
      deviceName: candidate.name,
      fromStepId: candidate.fromStepId,
      // The step this shed actually commands: the chosen rung, or — with no
      // ladder to choose from — the device's own step, which the binary off
      // that follows then leaves.
      toStepId: spend.toStepId ?? candidate.fromStepId,
      reliefKw: spend.reliefKw,
    });
    return;
  }
  if (candidate.kind === 'temperature') {
    debugStructured({
      event: 'plan_shed_set_temperature',
      deviceId: candidate.id,
      deviceName: candidate.name,
      shedTemperature: candidate.shedTemperature,
      reliefKw: spend.reliefKw,
    });
  }
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
    return { code: PLAN_REASON_CODES.hourlyBudget };
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
    return { code: PLAN_REASON_CODES.dailyBudget };
  }
  return { code: PLAN_REASON_CODES.capacity };
}
