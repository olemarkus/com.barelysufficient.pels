import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveCurrentHourClaim, DeferredObjectiveCurrentHourFacts } from './types';

// Shortfall causes the task cannot climb or re-estimate its way out of. An hour it
// booked nothing into is then one it STILL NEEDS, and the claim resolves to
// `'unclaimed'` — the device stays in play. (Read the direction carefully: "keeps
// the hour" here means `'unclaimed'`, not `'released'`.)
//
//   `budget`        — the soft daily budget net of forecast background bound the
//                     floor. The hour was zeroed by a FORECAST, not by physics.
//   `time_capacity` — physical/time even with the budget cap lifted, which also
//                     covers `limited_by_higher_priority_task`.
//
// The other causes are deliberately absent, so an unbooked hour under them resolves
// to `'released'` and the device stands down. That absence is the whole precision of
// the rule:
//
//   `step_power` (`feasible_above_floor`) — the climbed-band probe already PROVED
//                 the booked hours finish the job once the executor climbs. This is
//                 the normal state of a stepped thermal task; treating it as "still
//                 needs every hour" would switch price optimisation off for most of
//                 them.
//   `estimate`    — the shortfall is entirely the producer's `k·SE` variance
//                 padding; the mean rate fits inside the booked hours.
//   `none`        — no shortfall at all.
//
// In all three the task CAN finish without the hour, which is exactly the condition
// for giving it up.
const CAUSES_THAT_KEEP_THE_HOUR: ReadonlySet<DeferredObjectiveActivePlanFloorShortfallCause> = new Set([
  'budget',
  'time_capacity',
]);

// A task that physically cannot finish (`time_capacity`: the `cannot_meet` status,
// or a shortfall a higher-priority task causes) never price-defers an hour it
// booked. Being ahead of this hour's milestone proves nothing when the milestones
// lead to a miss: the cheaper hours are already booked to their cap, so coasting
// moves no load into them and only widens the miss.
//
// Cold-start release is deliberately NOT blocked. It exists for exactly the case
// where the floor plan reports `cannot_meet` but a bang-bang thermostat's real
// element finishes inside the cheaper hours (prod 2026-05-31: the catch-up ran at
// full element through the two dearest hours). Its own probe proves that fit at
// the climbed step, so the floor's verdict is the false premise there
// (notes/deferred-load-objectives/execution-adaptation.md, work item 4).
//
// Deliberately narrower than `CAUSES_THAT_KEEP_THE_HOUR`: a `budget`-bound task
// still price-defers a booked hour (pinned by
// test/integration/smartTaskUnclaimedHourLifecycle.test.ts). Its shortfall is the
// soft daily budget's forecast, and a thermostat kept on in an expensive hour runs
// its full element there, not just the booked floor.
const CAUSES_THAT_BLOCK_PRICE_DEFERRAL: ReadonlySet<DeferredObjectiveActivePlanFloorShortfallCause> = new Set([
  'time_capacity',
]);

/**
 * What claim a smart task has on the CURRENT hour — the single producer-resolved
 * answer admission acts on (`admission.resolveDecision` maps it 1:1 onto a decision
 * kind, and `decorationController.resolveDeferredAvoidDeviceIds` reads that decision
 * rather than re-deriving).
 *
 * Every release rule lives here. The plan producers — `horizonPlanner`'s fresh
 * allocation and `frozenHorizonPlan`'s mid-hour read of the commitment — and the
 * higher-priority contention overlay supply facts (`DeferredObjectiveCurrentHourFacts`)
 * and the settled shortfall cause, never a release verdict, so no path can drift
 * into answering a different question.
 *
 * The three states, and why the middle one exists:
 *
 * - `claimed` — the hour carries booked energy and no release applies. Drive the
 *   device: floor-step target, deadline floor, and whatever rescue permissions the
 *   task holds.
 * - `released` — the task can finish without this hour: it booked nothing here,
 *   or it is ahead of this hour's milestone with a cheaper booked hour later (price
 *   deferral), or a cold-start thermostat's whole need fits the cheaper hours at
 *   its real element (cold-start release). Hold the device in its configured
 *   release posture.
 * - `unclaimed` — the task booked nothing here and cannot finish without it. It
 *   makes no claim on the hour and issues no stand-down; the device goes to the
 *   planner as managed and competes on its own priority, carrying none of the
 *   boost / budget-exemption / startup-reservation claims a claimed hour carries.
 *
 * An hour books 0 kWh for two unrelated reasons, and collapsing them is the defect
 * this replaced. Either the task can finish without it (surplus hour — the price
 * decision), or a ceiling left no room. Most often that ceiling is the soft daily
 * budget's forecast controlled share, which can legitimately be 0
 * (`policyHorizon.resolveMaxUsefulEnergyKWh`). A forecast is not a reason to stop a
 * task that is behind: the runtime recomputes the real daily pace from live usage
 * on every rebuild, so whether the device may run in an unclaimed hour belongs to
 * the planner's capacity/budget/priority decision, not to a plan-time stand-down.
 */
export const resolveCurrentHourClaim = (params: {
  // Energy the plan booked into the current hour; `null` when there is no current
  // bucket at all (an hour the commitment skipped, or an empty horizon).
  currentBucketBookedKWh: number | null;
  facts: DeferredObjectiveCurrentHourFacts;
  // The producer's verdict on what bound the floor schedule. Deliberately the
  // SETTLED, hour-boundary-paced signal rather than a live energy comparison: the
  // fresh path derives it from the status detail it just resolved, and the frozen
  // path replays the one the `:58` settle persisted onto the revision. Recomputing
  // it live from `energyNeededKWh` would put a control decision back on the
  // per-cycle clock the two-clock design removes — a device idling in a released
  // hour drifts (a tank cools, an EV reports a coarser SoC), so the answer would
  // cross back and forth mid-hour and the device would bang between released and
  // unclaimed with no cooldown able to damp it (a lifecycle release never stamps
  // `lastInstabilityMs`, so the 60-300 s restore back-off never engages).
  floorShortfallCause: DeferredObjectiveActivePlanFloorShortfallCause;
}): DeferredObjectiveCurrentHourClaim => {
  const { facts } = params;
  // Proves the whole remaining need fits the cheaper hours at the real element, so
  // it carries its own justification and outranks the booking and the cause.
  if (facts.coldStartFeasible) return 'released';
  const booked = params.currentBucketBookedKWh !== null && params.currentBucketBookedKWh > 0;
  if (!booked) return CAUSES_THAT_KEEP_THE_HOUR.has(params.floorShortfallCause) ? 'unclaimed' : 'released';
  // Price deferral: already ahead of this hour's milestone, and a later booked hour
  // is meaningfully cheaper, so that hour carries the load instead.
  const priceDeferral = facts.aheadOfHourMilestone && facts.cheaperHourAhead
    && !CAUSES_THAT_BLOCK_PRICE_DEFERRAL.has(params.floorShortfallCause);
  return priceDeferral ? 'released' : 'claimed';
};
