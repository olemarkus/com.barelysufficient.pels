import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import { getDebugEmitter } from '../../logging/logger';
import type { PlanContext } from '../planContext';
import { chooseShedRung } from './steppedCandidates';
import { resolveStorageSpend } from './storageCandidate';
import type { LoadShedCandidate, ShedCandidate, StorageSetpoint, StorageShedCandidate } from './types';
import type { ShedRelief } from '../planState';
import { permitsDemandRelief, type ShedPressure } from './pressure';

const debug = getDebugEmitter('plan', 'plan');

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
 * A candidate whose relief is still unconfirmed banks nothing: it was commanded
 * by an earlier decision and the watts have not moved yet, so counting them here
 * would cover the deficit on a promise nobody is tracking. The next candidate is
 * then sized as though nothing had been done, which errs toward covering the
 * breach rather than under-shedding it. That is the right answer for a promise
 * older than the pending-relief window; a decision taken inside it is credited
 * before selection runs (`pendingRelief.ts`) and never reaches this loop as an
 * unconfirmed candidate to be re-sized.
 *
 * Five parallel maps leave here, all keyed by device id and all decided by this
 * loop: membership (`shedSet`), why (`shedReasons`), — for a stepped step-down —
 * WHERE the device is parked (`shedStepTargets`), the setpoint a home battery
 * is held at (`storageSetpoints`), and how much relief each banked
 * (`reliefByDevice`). The third and fourth name the requested electrical relief:
 * materialization commands their step or battery setpoint. Temperature restrictions
 * have no promised electrical target and bank nothing under urgent pressure.
 * The last is what the next cycle credits while
 * the meter has not caught up; for a battery only its stopped charge, which its
 * own reading shows falling (its discharge is the storage term's credit).
 *
 * A battery is spent like any candidate at its place in the order, but never
 * joins `shedSet`: the executor never sees a shed for it.
 */
export function selectShedDevices(
  candidates: ShedCandidate[],
  needed: number,
  reason: DeviceReason,
  shedAllCandidates: boolean,
  pressure: ShedPressure,
): ShedSelection {
  const selection: ShedSelection = {
    shedSet: new Set<string>(),
    shedReasons: new Map<string, DeviceReason>(),
    shedStepTargets: new Map<string, string>(),
    storageSetpoints: new Map<string, StorageSetpoint>(),
    reliefByDevice: new Map<string, ShedRelief>(),
  };
  let remaining = needed;
  for (const nextCandidate of candidates) {
    if (shouldStopSelection(shedAllCandidates, remaining)) break;
    if (nextCandidate.effectivePower <= 0) continue;
    if (nextCandidate.kind === 'storage') {
      remaining -= spendStorageCandidate(nextCandidate, remaining, selection);
      continue;
    }
    const spend = resolveCandidateSpend(nextCandidate, remaining, pressure);
    selection.shedSet.add(nextCandidate.id);
    selection.shedReasons.set(nextCandidate.id, reason);
    if (spend.toStepId !== undefined) selection.shedStepTargets.set(nextCandidate.id, spend.toStepId);
    logSelectedCandidate(nextCandidate, spend);
    const relief: ShedRelief = {
      kind: nextCandidate.kind === 'temperature' ? 'demand' : 'electrical',
      creditedKw: nextCandidate.unconfirmedRelief ? 0 : spend.reliefKw,
    };
    selection.reliefByDevice.set(nextCandidate.id, relief);
    remaining -= relief.creditedKw;
  }
  return selection;
}

/** One selection's decision — see `selectShedDevices` for what each map carries. */
export type ShedSelection = {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  shedStepTargets: Map<string, string>;
  storageSetpoints: Map<string, StorageSetpoint>;
  reliefByDevice: Map<string, ShedRelief>;
};

/**
 * Spend a battery for what is still open: its setpoint joins
 * `storageSetpoints`, or nothing when it could not visibly answer what is left.
 * An unconfirmed battery PELS already holds is held where it is: asking a
 * battery that does not follow for more would be one more write per reading
 * for relief nobody tracks.
 */
function spendStorageCandidate(
  candidate: StorageShedCandidate,
  remainingKw: number,
  selection: ShedSelection,
): number {
  const banked = !candidate.unconfirmedRelief;
  if (!banked && candidate.hold.kind === 'limit') {
    selection.storageSetpoints.set(candidate.id, {
      setpointW: candidate.hold.setpointW, banked, storage: candidate.storage,
    });
    selection.reliefByDevice.set(candidate.id, { kind: 'electrical', creditedKw: 0 });
    return 0;
  }
  const spend = resolveStorageSpend(candidate, remainingKw);
  if (spend === null) return 0;
  selection.storageSetpoints.set(candidate.id, { setpointW: spend.setpointW, banked, storage: candidate.storage });
  selection.reliefByDevice.set(candidate.id, { kind: 'electrical', creditedKw: banked ? spend.chargeReliefKw : 0 });
  debug({
    event: 'plan_shed_storage_limit',
    deviceId: candidate.id,
    deviceName: candidate.name,
    fromSignedW: candidate.baseW,
    setpointW: spend.setpointW,
    reliefKw: spend.reliefKw,
    chargeReliefKw: spend.chargeReliefKw,
    banked,
  });
  return banked ? spend.reliefKw : 0;
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

function resolveCandidateSpend(
  candidate: LoadShedCandidate, remainingKw: number, pressure: ShedPressure,
): CandidateSpend {
  // A temperature target requests less demand, not an electrical ceiling. Under
  // urgent pressure it is still requested in order, but cannot cover the deficit.
  if (candidate.kind === 'temperature' && !permitsDemandRelief(pressure)) return { reliefKw: 0 };
  if (candidate.kind !== 'stepped') return { reliefKw: candidate.effectivePower };
  const rung = chooseShedRung(candidate.rungs, remainingKw);
  if (!rung) return { reliefKw: candidate.effectivePower };
  return { reliefKw: rung.reliefKw, toStepId: rung.toStepId };
}

function shouldStopSelection(shedAllCandidates: boolean, remaining: number): boolean {
  return !shedAllCandidates && remaining <= 0;
}

function logSelectedCandidate(
  candidate: LoadShedCandidate,
  spend: CandidateSpend,
): void {
  if (candidate.kind === 'stepped') {
    debug({
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
    debug({
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
  physicalLimitBreached: boolean,
  hourlyBudgetExhausted = false,
): DeviceReason {
  // The exhausted hour outranks both soft-limit sources: the hour's kWh is
  // spent, so no freed power (capacity-side or budget-side) admits anything
  // before the hour rolls over. Its own reason code renders time-based copy on
  // the card instead of a kW gap, which would be dishonest here.
  if (limitSource === 'grid') return { code: PLAN_REASON_CODES.gridImport };
  if (hourlyBudgetExhausted) {
    return { code: PLAN_REASON_CODES.hourlyBudget };
  }
  // `daily` is only the BINDING soft limit — when a physical limit (capacity or
  // grid, `MeasuredPower.physicalLimitBreached`) is breached too, total is over
  // both and that limit is the constraint actually doing the work. Naming
  // the daily budget there is wrong for every device in the cycle, and doubly so
  // for a budget-exempt one, which reaches this point ONLY because the breach
  // overrode its exemption (`shedding/candidates.ts`). It also mis-buckets the
  // overview into the releasable side and offers a "Let it run now" rescue that
  // cannot help: releasing a budget exemption does not create capacity headroom
  // (the same reasoning `planDiagnostics.ts` applies to capacity-bound holds).
  if (limitSource === 'daily' && !physicalLimitBreached) {
    return { code: PLAN_REASON_CODES.dailyBudget };
  }
  return { code: PLAN_REASON_CODES.capacity };
}
