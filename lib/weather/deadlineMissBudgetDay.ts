import type { DeferredObjectivePlanHistoryRecord } from '../../packages/contracts/src/deferredObjectivePlanHistory';
import type { WeatherDaySuppression } from '../../packages/contracts/src/weatherAdvisorTypes';
import { pickLastPlan, snapshotShowsBudgetExhausted } from '../../packages/shared-domain/src/deferredPlanHistoryShared';
import { asDeliveredEnergyKWh, asRemainingEnergyKWh } from '../../packages/shared-domain/src/energyQuantities';
import { getDateKeyInTimeZone } from '../utils/dateUtils';

/**
 * What a local day's deadline-bound smart-task misses proved about the daily
 * budget, for the weather day record that day rolls up into.
 *
 * Two fields, written together because two consumers want different things:
 *
 *   - `deadlineMissedToBudget` censors the day out of the energy-signature FIT.
 *     Excluding a day from the fit flattens the slope, and the days a home is
 *     held back on are its high-demand days, so this stays exactly as narrow as
 *     it has always been (`energySignature.ts`).
 *   - `deadlineMissDeniedKwh` feeds the budget-pressure LOOP, whose model is
 *     damage: energy the budget denied a task that then missed its deadline. A
 *     magnitude, present only when PELS could measure one.
 *
 * Both are gated on the same predicate today — the budget was the whole reason
 * the planner's floor fell short. A miss the budget only CONTRIBUTED to is
 * deliberately not counted; see the note in `notes/starvation/README.md`.
 *
 * Best-effort by design, and the direction of the error matters here. On a boot
 * that slept past midnight the weather catch-up can roll a day up before the
 * deferred-objective lifecycle clock (a bare 30 s interval with no leading tick)
 * has finalized a just-missed deadline, so that day can roll up with no miss on
 * it. That used to cost a fit exclusion, in the conservative direction. It now
 * also costs the day its damage evidence, and the day DECAYS the pressure term
 * instead — the very defect this signal exists to close, on the narrow set of
 * days a home rebooted across. The recorder's 30-entry global cap is a second
 * way a caught-up day can lose its misses. Accepted rather than fixed by
 * forcing a synchronous finalize ahead of the weather catch-up, which is
 * disproportionate boot-order risk for an advisory signal.
 */

/**
 * Energy the run never got: what it committed to needing, less what the executor
 * actually delivered — or `null` when PELS cannot state that.
 *
 * Both figures are ENTRY-level and anchored: `initialEnergyExpectedKWh` is
 * captured once and frozen, `deliveredKWh` is the run's cumulative total. The
 * revision snapshots cannot answer this — their `energyExpectedKWh` shrinks as
 * the run delivers and is frozen at the last revision the recorder wrote, which
 * settles at most hourly, so reading it would price a nearly-complete run at
 * almost its whole requirement. The contract says so at the field itself.
 *
 * EITHER figure being absent makes the answer unknowable, and unknowable is not
 * zero. An absent commitment means the run finalized without its profile ever
 * resolving; an absent delivery means the hourly feed was unavailable, or the
 * entry predates the field. Reading a missing delivery as "delivered nothing"
 * would charge a task that may have received almost all of its energy the whole
 * commitment — up to a full `MAX_STEP_KWH` of pressure on a budget PELS then
 * writes. The contract is explicit for the commitment and the same reasoning
 * covers delivery: decline the comparison, never substitute a stand-in.
 */
const unservedEnergyKWh = (entry: DeferredObjectivePlanHistoryRecord): number | null => {
  const committed = asRemainingEnergyKWh(entry.initialEnergyExpectedKWh);
  const delivered = asDeliveredEnergyKWh(entry.deliveredKWh);
  if (committed === null || delivered === null) return null;
  return Math.max(0, committed - delivered);
};

/**
 * Folds every deadline-bound miss whose deadline fell on `dateKey` into the
 * day's evidence. Takes the recorder's own finalized records — an absent
 * recorder passes none.
 *
 * The cause is read from ONE plan snapshot, chosen by `pickLastPlan`. A
 * per-field fallback across final and original would resurrect a stale positive
 * from the richer original plan on a run whose final revision saw no budget
 * bound at all.
 */
export function resolveDeadlineMissSuppression(
  entries: readonly DeferredObjectivePlanHistoryRecord[],
  dateKey: string,
  timeZone: string,
): Pick<WeatherDaySuppression, 'deadlineMissedToBudget' | 'deadlineMissDeniedKwh'> {
  let missed = false;
  let deniedKwh = 0;
  for (const entry of entries) {
    if (entry.outcome !== 'missed') continue;
    if (!snapshotShowsBudgetExhausted(pickLastPlan(entry))) continue;
    if (getDateKeyInTimeZone(new Date(entry.deadlineAtMs), timeZone) !== dateKey) continue;
    missed = true;
    deniedKwh += unservedEnergyKWh(entry) ?? 0;
  }
  if (!missed) return {};
  // The two fields answer to different consumers and are stamped independently.
  // `deadlineMissedToBudget` records that the miss happened, for the fit's day
  // exclusion. `deadlineMissDeniedKwh` is a MAGNITUDE for the pressure loop, so
  // it is stamped only when there is one: a day whose misses could none of them
  // be priced contributes no energy evidence and is left off, which lets the
  // loop decay through it exactly as it does for an unwitnessed day-close
  // verdict. Unprovable is not damage is already this module's rule; a miss PELS
  // could not measure is the same shape, and holding on it would stop the
  // integrator leaking — the leak is what lets auto-apply lower a budget again.
  return {
    deadlineMissedToBudget: true,
    ...(deniedKwh > 0 ? { deadlineMissDeniedKwh: deniedKwh } : {}),
  };
}
