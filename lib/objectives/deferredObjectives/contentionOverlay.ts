import { needsEveryHour, resolveCurrentHourBooking, resolveCurrentHourClaim } from './currentHourClaim';
import { bookBuckets } from './priceBand';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import type { DeferredObjectivePriorityReservation } from './policyHorizon';
import type { TaskEvaluation } from './taskEvaluation';

const CONTENTION_EPSILON_KWH = 0.001;

/**
 * Attribute a fresh allocation shortfall to higher-priority load, the bookings of
 * tasks above and the maximum steps reserved for devices above, only when
 * removing that load fits.
 */
export const resolveHigherPriorityContentionEvaluation = (params: {
  evaluation: TaskEvaluation;
  higherPriorityReservations: readonly DeferredObjectivePriorityReservation[];
  higherPriorityUnbookedPowerKw: number;
  buildWithoutReservations: () => TaskEvaluation;
}): TaskEvaluation => {
  const { evaluation } = params;
  if (evaluation.planning.kind === 'inactive') return evaluation;
  if (params.higherPriorityReservations.length === 0 && params.higherPriorityUnbookedPowerKw <= 0) return evaluation;
  const { plan } = evaluation.planning;
  if (plan.frozenRead || plan.unplannedUsefulEnergyKWh <= CONTENTION_EPSILON_KWH) return evaluation;
  const control = params.buildWithoutReservations();
  if (control.planning.kind === 'inactive'
    || control.planning.plan.unplannedUsefulEnergyKWh > CONTENTION_EPSILON_KWH) return evaluation;
  // Cause, bookings and claim change together, so the saved hours and the frozen
  // read agree with the fresh answer: short because of a higher-priority task, this
  // task needs every hour it can get.
  const floorShortfallCause = resolveFloorShortfallCause('limited_by_higher_priority_task');
  const plannedBuckets = bookBuckets(plan.plannedBuckets, needsEveryHour(floorShortfallCause));
  const currentBucket = plan.currentBucket && {
    ...plan.currentBucket,
    booked: plannedBuckets.find((bucket) => bucket.current)?.booked === true,
  };
  const currentHourClaim = resolveCurrentHourClaim({
    currentHourBooking: resolveCurrentHourBooking(currentBucket),
    facts: plan.currentHourFacts,
    floorShortfallCause,
  });
  return {
    ...evaluation,
    planning: { kind: 'allocated', plan: {
      ...plan,
      status: 'at_risk',
      statusDetail: 'limited_by_higher_priority_task',
      plannedBuckets,
      currentBucket,
      currentHourClaim,
    } },
  };
};
