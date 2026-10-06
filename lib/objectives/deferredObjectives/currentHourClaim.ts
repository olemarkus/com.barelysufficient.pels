import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveCurrentHourClaim, DeferredObjectiveCurrentHourFacts } from './types';

// Shortfall causes that mean the task cannot finish within its plan: it needs every
// hour it can get. The planner books every hour for such a task (`bookBuckets`), and
// the claim reads the settled cause too, so a commitment saved before that rule, or
// an hour outside it, is not given up.
//
//   `budget`        — the soft daily budget net of forecast background bound the
//                     floor. The hour was zeroed by a FORECAST, not by physics.
//   `time_capacity` — physical/time even with the budget cap lifted, which also
//                     covers `limited_by_higher_priority_task`.
//
// The other causes are deliberately absent. `step_power` (`feasible_above_floor`)
// means the climbed-band probe already PROVED the booked hours finish the job once
// the executor climbs — the normal state of a stepped thermal task, so treating it
// as "needs every hour" would switch price optimisation off for most of them.
// `estimate` is a shortfall made entirely of the `k·SE` variance padding. `none` is
// no shortfall. In all three the task CAN finish without an unbooked hour.
const CAUSES_THAT_NEED_EVERY_HOUR: ReadonlySet<DeferredObjectiveActivePlanFloorShortfallCause> = new Set([
  'budget',
  'time_capacity',
]);

export const needsEveryHour = (cause: DeferredObjectiveActivePlanFloorShortfallCause): boolean => (
  CAUSES_THAT_NEED_EVERY_HOUR.has(cause)
);

// How the plan books the current hour: not at all, booked with nothing promised (the
// forecast left no room), or booked with energy. One reading for every producer, so
// the fresh plan, the frozen read and the contention overlay cannot disagree.
export type CurrentHourBooking = 'unbooked' | 'booked_without_energy' | 'booked_with_energy';

export const resolveCurrentHourBooking = (
  currentBucket: { booked: boolean; plannedUsefulEnergyKWh: number } | null,
): CurrentHourBooking => {
  if (currentBucket === null || !currentBucket.booked) return 'unbooked';
  return currentBucket.plannedUsefulEnergyKWh > 0 ? 'booked_with_energy' : 'booked_without_energy';
};

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
// Deliberately narrower than `CAUSES_THAT_NEED_EVERY_HOUR`: a `budget`-bound task
// still price-defers a booked hour (pinned by
// test/integration/smartTaskHourBookingLifecycle.test.ts). Its shortfall is the
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
 * - `claimed` — the task books this hour and no release applies. Drive the device
 *   with the deadline floor and whatever rescue permissions the task holds. A hour
 *   booked at 0 kWh (wanted on price, but the forecast left no room) is claimed the
 *   same way: it promises nothing, and the planner gives the device whatever
 *   capacity is actually free.
 * - `released` — the task can finish without this hour: it is not booked, or the
 *   hour carries energy and the device is ahead of its milestone with a cheaper hour
 *   carrying energy later (price deferral), or a cold-start thermostat's whole need fits the cheaper hours at its
 *   real element (cold-start release). Hold the device in its configured release
 *   posture.
 */
export const resolveCurrentHourClaim = (params: {
  currentHourBooking: CurrentHourBooking;
  facts: DeferredObjectiveCurrentHourFacts;
  // The producer's verdict on what bound the floor schedule. Deliberately the
  // SETTLED, hour-boundary-paced signal rather than a live energy comparison: the
  // fresh path derives it from the status detail it just resolved, and the frozen
  // path replays the one the `:58` settle persisted onto the revision. Recomputing
  // it live from `energyNeededKWh` would put a control decision back on the
  // per-cycle clock the two-clock design removes — a device idling in a released
  // hour drifts (a tank cools, an EV reports a coarser SoC), so the answer would
  // cross back and forth mid-hour and the device would bang between released and
  // claimed with no cooldown able to damp it (a lifecycle release never stamps
  // `lastInstabilityMs`, so the 60-300 s restore back-off never engages).
  floorShortfallCause: DeferredObjectiveActivePlanFloorShortfallCause;
}): DeferredObjectiveCurrentHourClaim => {
  const { facts, floorShortfallCause } = params;
  // Proves the whole remaining need fits the cheaper hours at the real element, so
  // it carries its own justification and outranks the booking and the cause.
  if (facts.coldStartFeasible) return 'released';
  const booking = params.currentHourBooking;
  if (booking === 'unbooked' && !needsEveryHour(floorShortfallCause)) return 'released';
  // Price deferral: already ahead of this hour's milestone, and a later hour carrying
  // energy is meaningfully cheaper, so that hour carries the load instead. Only an
  // hour with energy can be deferred: a booking without energy promises nothing to
  // move, and its milestone does not advance, so "ahead" would be true by
  // construction and switch the device off in exactly the hour it was booked to run.
  const priceDeferral = booking === 'booked_with_energy'
    && facts.aheadOfHourMilestone && facts.cheaperHourAhead
    && !CAUSES_THAT_BLOCK_PRICE_DEFERRAL.has(floorShortfallCause);
  return priceDeferral ? 'released' : 'claimed';
};
