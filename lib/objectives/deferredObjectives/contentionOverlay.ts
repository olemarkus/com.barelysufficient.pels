import { resolveCurrentHourClaim } from './currentHourClaim';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import type { DeferredObjectivePriorityReservation } from './policyHorizon';

const CONTENTION_EPSILON_KWH = 0.001;

/**
 * Re-attribute a lower-priority task's shortfall to CONTENTION when the only
 * reason it is short is the physical and energy claims the tasks ahead of it
 * already made.
 *
 * The test is a control run: re-solve the same task with the higher-priority
 * reservations removed. If it then fits, the reservations are what cost it the
 * schedule, and the reported status becomes `at_risk` /
 * `limited_by_higher_priority_task` instead of whatever the squeezed allocation
 * produced on its own. A frozen-served plan is left alone — it carries no new
 * allocation to attribute.
 *
 * The overlay owns the whole diagnostic it rewrites, `currentHourClaim` included.
 * That is load-bearing rather than incidental: the claim is a function of the
 * shortfall cause, and this is the one place a cause is re-attributed after the
 * plan resolved it.
 */
export const resolveHigherPriorityContentionStatus = (params: {
  diagnostic: DeferredObjectiveDiagnostic;
  higherPriorityReservations: readonly DeferredObjectivePriorityReservation[];
  buildWithoutReservations: () => DeferredObjectiveDiagnostic;
}): DeferredObjectiveDiagnostic => {
  const plan = params.diagnostic.horizonPlan;
  if (
    params.higherPriorityReservations.length === 0
    || !plan
    || plan.frozenRead
    || plan.unplannedUsefulEnergyKWh <= CONTENTION_EPSILON_KWH
  ) return params.diagnostic;
  const control = params.buildWithoutReservations();
  if ((control.horizonPlan?.unplannedUsefulEnergyKWh ?? Number.POSITIVE_INFINITY) > CONTENTION_EPSILON_KWH) {
    return params.diagnostic;
  }
  const horizonPlan = {
    ...plan,
    status: 'at_risk' as const,
    statusDetail: 'limited_by_higher_priority_task' as const,
    // Re-resolve, do NOT inherit. `currentHourClaim` was resolved in
    // `buildPlanFromAllocation` from the PRE-override detail, while the recorder
    // derives the persisted `floorShortfallCause` from the POST-override
    // `reasonCode` (`activePlanRevisionBuild`). Carrying the old claim forward
    // therefore splits the two producers apart on exactly this path: a squeezed but
    // climbable task resolves `feasible_above_floor` → `released` on the fresh
    // cycle, while the revision that same cycle persists says `time_capacity`,
    // which the frozen read replays as `unclaimed`. The device would be stood down
    // across the `:58` settle and restored mid-hour, once an hour, for as long as
    // the contention lasts — the very divergence one shared resolver exists to make
    // impossible.
    currentHourClaim: resolveCurrentHourClaim({
      currentBucketBookedKWh: plan.currentBucket?.plannedUsefulEnergyKWh ?? null,
      priceDeferralEligible: plan.priceDeferralEligible,
      coldStartReleaseEligible: plan.coldStartReleaseEligible === true,
      floorShortfallCause: resolveFloorShortfallCause('limited_by_higher_priority_task'),
    }),
  };
  return {
    ...params.diagnostic,
    trajectory: { kind: 'resolved', status: 'at_risk' },
    reasonCode: 'limited_by_higher_priority_task',
    horizonPlan,
  };
};
