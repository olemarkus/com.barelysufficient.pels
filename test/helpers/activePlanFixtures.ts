import type {
  DeferredObjectiveActivePlanTrajectory,
  DeferredObjectiveActivePlanV1,
  DeliveredEnergyReader,
  ResolvedDeferredObjectiveActivePlanV1,
  ResolvedDeferredObjectiveActivePlansV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';
import { toResolvedActivePlan } from '../../packages/shared-domain/src/deferredActivePlanResolvedView';

/**
 * A stored plan as a test writes it, optionally with the live trajectory the
 * UI assembler stitches on from the plan-history recorder. Resolved by
 * `resolveActivePlanFixture` exactly as the assembler resolves a plan.
 */
export type ActivePlanFixture = DeferredObjectiveActivePlanV1 & Partial<DeferredObjectiveActivePlanTrajectory>;

/** No energy delivered yet: the delivery count for a run it has not opened. */
export const nothingDelivered: DeliveredEnergyReader = () => 0;

export const resolveActivePlanFixture = (
  fixture: ActivePlanFixture,
  readDeliveredEnergy: DeliveredEnergyReader = nothingDelivered,
): ResolvedDeferredObjectiveActivePlanV1 => {
  const { startProgressValue, progressSamples, ...plan } = fixture;
  const trajectory = startProgressValue === undefined && progressSamples === undefined
    ? null
    : { startProgressValue: startProgressValue ?? null, progressSamples: progressSamples ?? [] };
  return toResolvedActivePlan(plan, readDeliveredEnergy, trajectory);
};

export const resolveActivePlanFixtures = (
  plansByDeviceId: Record<string, ActivePlanFixture>,
  readDeliveredEnergy: DeliveredEnergyReader = nothingDelivered,
): ResolvedDeferredObjectiveActivePlansV1 => ({
  version: 1,
  plansByDeviceId: Object.fromEntries(
    Object.entries(plansByDeviceId).map(([deviceId, plan]) => [
      deviceId,
      resolveActivePlanFixture(plan, readDeliveredEnergy),
    ]),
  ),
});
