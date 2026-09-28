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
