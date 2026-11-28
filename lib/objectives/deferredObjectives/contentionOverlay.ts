import { needsEveryHour, resolveCurrentHourBooking, resolveCurrentHourClaim } from './currentHourClaim';
import { bookBuckets } from './priceBand';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import type { DeferredObjectivePriorityReservation } from './policyHorizon';
import type { TaskEvaluation } from './taskEvaluation';
import { remainingUnscheduledEnergyKWh, servePartialPriceSchedule } from './partialPriceSchedule';

const CONTENTION_EPSILON_KWH = 0.001;

/**
 * Attribute a fresh allocation shortfall to higher-priority load, the bookings of
 * tasks above and the maximum steps reserved for devices above, only when
 * removing that load fits.
 */
export const resolveHigherPriorityContentionEvaluation = (
  evaluation: TaskEvaluation,
  higherPriorityReservations: readonly DeferredObjectivePriorityReservation[],
  higherPriorityUnbookedPowerKw: number,
  buildWithoutReservations: () => TaskEvaluation,
): TaskEvaluation => {
  if (evaluation.planning.kind !== 'allocated') return evaluation;
  if (higherPriorityReservations.length === 0 && higherPriorityUnbookedPowerKw <= 0) return evaluation;
  const { plan } = evaluation.planning;
  if (plan.frozenRead || remainingUnscheduledEnergyKWh(plan) <= CONTENTION_EPSILON_KWH) return evaluation;
  const control = buildWithoutReservations();
  if (control.planning.kind !== 'allocated'
    || remainingUnscheduledEnergyKWh(control.planning.plan) > CONTENTION_EPSILON_KWH) return evaluation;
  // Cause, bookings and claim change together, so the saved hours and the frozen
  // read agree with the fresh answer: short because of a higher-priority task, this
  // task needs every hour it can get.
  const floorShortfallCause = resolveFloorShortfallCause('limited_by_higher_priority_task');
  const plannedBuckets = bookBuckets(plan.plannedBuckets, needsEveryHour(floorShortfallCause));
  const currentBucket = plan.currentBucket && {
    ...plan.currentBucket,
    booked: plannedBuckets.find((bucket) => bucket.current)?.booked === true,
  };
  const currentHourClaim = resolveCurrentHourClaim(
    resolveCurrentHourBooking(currentBucket),
    plan.currentHourFacts,
    floorShortfallCause,
  );
  const adjusted = {
    ...plan,
    status: 'at_risk' as const,
    statusDetail: 'limited_by_higher_priority_task' as const,
    plannedBuckets,
    currentBucket,
    currentHourClaim,
  };
  return {
    ...evaluation,
    planning: { kind: 'allocated', plan: plan.partialPriceSchedule === undefined
      ? adjusted : servePartialPriceSchedule(adjusted, plan.partialPriceSchedule) },
  };
};
