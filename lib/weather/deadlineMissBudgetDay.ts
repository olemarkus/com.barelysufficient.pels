import type { DeferredObjectivePlanHistoryRecord } from '../../packages/contracts/src/deferredObjectivePlanHistory';
import type { WeatherDaySuppression } from '../../packages/contracts/src/weatherAdvisorTypes';
import { asDeliveredEnergyKWh, asRemainingEnergyKWh } from '../../packages/shared-domain/src/energyQuantities';
import { getDateKeyInTimeZone } from '../../packages/shared-domain/src/utils/dateUtils';

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
 * Both require recorded delivery evidence naming budget as the primary blocker
 * with no other attributing contributor. Legacy and mixed-cause misses cannot
 * establish budget-only damage; see `notes/starvation/README.md`.
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
 * zero. An absent commitment means PELS never knew what the run needed (the
 * contract lists why, at `initialEnergyExpectedKWh`); an absent delivery means
 * the hourly feed was unavailable, or the
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
 * The longest single `control_pending` stretch that still reads as PELS settling
 * its own decision rather than a stuck one. `control_pending` covers restore and
 * shed cooldowns, meter settling, throttled or queued restores and startup holds,
 * but also `no_decision`, unobserved actuator axes and convergence that never
 * completes (`lib/plan/taskDeliveryControl.ts`, `deliveryEvidence.ts`). The
 * planner's own settle windows top out at 5 minutes: the restore cooldown's
 * backoff cap (`RESTORE_COOLDOWN_MAX_MS`), the post-shed restore backoff
 * (`RECENT_SHED_RESTORE_BACKOFF_MS`) and the startup restore block (60 s) in
 * `lib/plan/planConstants.ts`. A stretch longer than that is not a settle, so it
 * is a competing cause. Restated here because `lib/weather` may not import
 * `lib/plan`.
 */
const MAX_SETTLE_INTERVAL_MS = 5 * 60 * 1000;
/** Settles may repeat; this bounds how much of a run they may cover in total. */
const MAX_SETTLE_TOTAL_MS = 15 * 60 * 1000;
/**
 * The recorder's interval window: mirrors `MAX_DELIVERY_INTERVALS` in
 * `lib/objectives/deferredObjectives/deliveryEvidence.ts`, which `lib/weather`
 * may not import. Keep both in sync.
 */
const DELIVERY_INTERVAL_WINDOW = 120;

/**
 * Whether the run's `control_pending` evidence is provably transient, so the
 * contributor neither establishes nor rules out budget attribution. Nearly
 * every run passes through a settle tick, and treating each as a competing
 * cause made budget-only evidence unreachable in practice.
 *
 * Conservative in both directions it can be wrong:
 *   - A listed `control_pending` contributor with no recorded interval cannot be
 *     shown to be short, so it disqualifies.
 *   - Any recorded interval longer than a settle disqualifies, as does a total
 *     beyond `MAX_SETTLE_TOTAL_MS`. Contiguous ticks merge into one interval
 *     (`appendInterval`), so a stuck command shows up as one long interval.
 *
 * Retained intervals are what this can see. The recorder keeps only the newest
 * `DELIVERY_INTERVAL_WINDOW` intervals, so a full list may have dropped a long
 * `control_pending` stretch: it cannot prove the settles were short and
 * disqualifies.
 */
const hasOnlySettleControlPending = (
  explanation: Extract<DeferredObjectivePlanHistoryRecord['deliveryExplanation'], { kind: 'recorded' }>,
): boolean => {
  if (!explanation.contributors.includes('control_pending')) return true;
  if (explanation.intervals.length >= DELIVERY_INTERVAL_WINDOW) return false;
  const settles = explanation.intervals.filter((interval) => interval.cause === 'control_pending');
  if (settles.length === 0) return false;
  let totalMs = 0;
  for (const interval of settles) {
    const durationMs = interval.toMs - interval.fromMs;
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_SETTLE_INTERVAL_MS) return false;
    totalMs += durationMs;
  }
  return totalMs <= MAX_SETTLE_TOTAL_MS;
};

const isBudgetOrSettleCause = (cause: string): boolean => cause === 'budget_limited' || cause === 'control_pending';

/**
 * Budget is the primary blocker and every other recorded contributor is either
 * budget or a provably short settle. Interval causes are checked as well as the
 * contributor list: both are persisted, and a cause present in either one is
 * evidence. `legacy_unrecorded` is deliberately never
 * excused: a run that crossed the upgrade has an unrecorded stretch whose cause
 * may have been capacity or the device, and no recorded cause cannot establish
 * budget alone.
 */
const isBudgetOnlyMiss = (entry: DeferredObjectivePlanHistoryRecord): boolean => {
  const explanation = entry.deliveryExplanation;
  return explanation.kind === 'recorded'
    && explanation.primary.kind === 'blocked'
    && explanation.primary.cause === 'budget_limited'
    && explanation.contributors.every(isBudgetOrSettleCause)
    && explanation.intervals.every((interval) => isBudgetOrSettleCause(interval.cause))
    && hasOnlySettleControlPending(explanation);
};

/**
 * Folds every deadline-bound miss whose deadline fell on `dateKey` into the
 * day's evidence. Takes the recorder's own finalized records — an absent
 * recorder passes none.
 *
 * The recorder owns delivery attribution. Plan-time feasibility snapshots do
 * not prove that budget control denied delivery, so neither current nor legacy
 * snapshots participate in this decision.
 */
export function resolveDeadlineMissSuppression(
  entries: readonly DeferredObjectivePlanHistoryRecord[],
  dateKey: string,
  timeZone: string,
): Pick<WeatherDaySuppression, 'deadlineMissedToBudget' | 'deadlineMissDeniedKwh'> {
  let missed = false;
  let deniedKwh = 0;
  for (const entry of entries) {
    if (entry.outcome !== 'missed' || !isBudgetOnlyMiss(entry)) continue;
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
