// Producer of the `Resolved…` view of an active plan that consumers receive (the
// live-task chart, the deadlines list card, the smart-tasks widget): the plan's
// progress direction resolved from its latest revision, an energy task's energy
// delivered so far, and the run's live trajectory. See `ResolvedDeferredObjectiveActivePlanV1`.

import type {
  DeferredObjectiveActivePlanTrajectory,
  DeferredObjectiveActivePlanV1,
  DeliveredEnergyReader,
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../contracts/src/deferredObjectiveActivePlans';

export const toResolvedActivePlan = (
  plan: DeferredObjectiveActivePlanV1,
  readDeliveredEnergy: DeliveredEnergyReader,
  trajectory: DeferredObjectiveActivePlanTrajectory | null,
): ResolvedDeferredObjectiveActivePlanV1 => {
  const base = {
    ...plan,
    progressDirection: plan.latest === null
      ? 'unknown' as const
      : plan.latest.progressDirection ?? 'increasing',
    // A plan with no open run carries no trajectory.
    ...(trajectory === null ? {} : trajectory),
  };
  return plan.objectiveKind === 'energy'
    ? { ...base, objectiveKind: 'energy', deliveredKWh: readDeliveredEnergy(plan.deviceId, plan.deadlineAtMs) }
    : { ...base, objectiveKind: plan.objectiveKind };
};

/**
 * The kWh-per-unit rate the plan was built with: the latest revision's
 * recorded rate, else the learned mean on the plan's provenance, which the
 * recorder carries forward across a revision that resolved no rate source.
 * Null when the plan holds no usable positive rate: an energy task's rate is
 * exact, so it records none. Never the live profile's mean, which can differ
 * from what the plan was sized with.
 */
export const resolvePlanKwhPerUnit = (plan: ResolvedDeferredObjectiveActivePlanV1): number | null => {
  const rate = plan.latest?.rateMean ?? plan.kwhPerUnitProvenance?.kWhPerUnit ?? null;
  return rate !== null && Number.isFinite(rate) && rate > 0 ? rate : null;
};
