import { resolveCurrentHourClaim } from './currentHourClaim';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import type { DeferredObjectivePriorityReservation } from './policyHorizon';
import type { TaskEvaluation } from './taskEvaluation';

const CONTENTION_EPSILON_KWH = 0.001;

/** Attribute a fresh allocation shortfall to competing tasks only when removing them fits. */
export const resolveHigherPriorityContentionEvaluation = (params: {
  evaluation: TaskEvaluation;
  higherPriorityReservations: readonly DeferredObjectivePriorityReservation[];
  buildWithoutReservations: () => TaskEvaluation;
}): TaskEvaluation => {
  const { evaluation } = params;
  if (evaluation.planning.kind === 'inactive' || params.higherPriorityReservations.length === 0) return evaluation;
  const { plan } = evaluation.planning;
  if (plan.frozenRead || plan.unplannedUsefulEnergyKWh <= CONTENTION_EPSILON_KWH) return evaluation;
  const control = params.buildWithoutReservations();
  if (control.planning.kind === 'inactive'
    || control.planning.plan.unplannedUsefulEnergyKWh > CONTENTION_EPSILON_KWH) return evaluation;
  // Claim and allocation cause change together so frozen and fresh admission agree.
  const currentHourClaim = resolveCurrentHourClaim({
    currentBucketBookedKWh: plan.currentBucket?.plannedUsefulEnergyKWh ?? null,
    priceDeferralEligible: plan.priceDeferralEligible,
    coldStartReleaseEligible: plan.coldStartReleaseEligible === true,
    floorShortfallCause: resolveFloorShortfallCause('limited_by_higher_priority_task'),
  });
  return {
    ...evaluation,
    planning: { kind: 'allocated', plan: {
      ...plan, status: 'at_risk', statusDetail: 'limited_by_higher_priority_task', currentHourClaim,
    } },
  };
};
