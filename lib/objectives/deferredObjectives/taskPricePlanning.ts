import type {
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { CoordinatedDeferredObjective, OrderedDeferredObjective } from './priorityAllocation';
import type { FrozenReadInputs } from './frozenHorizonPlan';
import type { TaskEvaluationReaders, TaskEvaluationSnapshot } from './taskEvaluationCoordinator';
import { taskReplanRequested, type TaskAllocationMode } from './taskPlanningTurns';
import {
  resolveDeadlineAwarePolicyHorizonReason, resolveKnownPriceCoverageEnd,
  type DeferredObjectivePolicyHorizonInputs, type DeferredObjectivePriorityReservation,
} from './policyHorizon';

export const buildTaskPolicyHorizonInputs = (
  snapshot: TaskEvaluationSnapshot,
  readers: TaskEvaluationReaders,
  task: CoordinatedDeferredObjective,
  higherPriorityReservations: readonly DeferredObjectivePriorityReservation[],
  allocation: TaskAllocationMode,
  frozenRead: FrozenReadInputs | null,
): DeferredObjectivePolicyHorizonInputs => {
  const { nowMs } = snapshot;
  const { deadlineAtMs } = task.objective;
  const serving = allocation === 'serve' || allocation === 'serve_idle';
  return {
    nowMs,
    deadlineAtMs,
    priceOptimizationEnabled: snapshot.priceOptimizationEnabled,
    priceHorizon: serving && frozenRead ? [] : readers.buildPriceHorizon(nowMs, deadlineAtMs),
    dailyBudgetSnapshot: snapshot.dailyBudgetSnapshot,
    powerLimits: snapshot.powerLimits,
    hasSolarProduction: snapshot.hasSolarProduction,
    exemptFromBudget: false,
    higherPriorityReservations,
    higherPriorityUnbookedPowerKw: task.higherPriorityUnbookedPowerKw,
  };
};

const hasExpandedCoverage = (
  latest: DeferredObjectiveActivePlanRevisionV1 | null | undefined,
  pricedUntilMs: number | null,
): boolean => latest?.partialPriceSchedule !== undefined
  && latest.computedFromPricesUpTo !== null
  && pricedUntilMs !== null && pricedUntilMs > latest.computedFromPricesUpTo;

export const hasNewTaskPrices = (
  task: OrderedDeferredObjective,
  snapshot: TaskEvaluationSnapshot,
  readPrices: TaskEvaluationReaders['buildPriceHorizon'],
): boolean => {
  const latest = snapshot.activePlans.plansByDeviceId[task.deviceId]?.latest;
  if (latest?.partialPriceSchedule === undefined) return false;
  const { nowMs } = snapshot;
  const { deadlineAtMs } = task.objective;
  const priceHorizon = readPrices(nowMs, deadlineAtMs);
  return hasExpandedCoverage(latest, resolveKnownPriceCoverageEnd({ nowMs, deadlineAtMs, priceHorizon }));
};

export const resolveTaskPricePlanning = (
  horizon: DeferredObjectivePolicyHorizonInputs,
  allocation: TaskAllocationMode,
  frozenRead: FrozenReadInputs | null,
  latest: DeferredObjectiveActivePlanRevisionV1 | null | undefined,
) => {
  const horizonReason = resolveDeadlineAwarePolicyHorizonReason(horizon);
  if (horizonReason !== null) return { horizonReason, replan: false };
  const pricedUntilMs = resolveKnownPriceCoverageEnd(horizon);
  // A shorter read may replace projections but cannot lose a priced floor
  // that is still in effect. The floor expires with its original interval.
  const losesPricedCommitment = pricedUntilMs !== null && pricedUntilMs < horizon.deadlineAtMs
    && frozenRead?.hours.some((hour) => hour.plannedKWh > 0 && hour.endsAtMs > pricedUntilMs);
  const expanded = frozenRead !== null && allocation === 'ordinary' && hasExpandedCoverage(latest, pricedUntilMs);
  const replan = !losesPricedCommitment
    && (taskReplanRequested(allocation, frozenRead !== null, horizon.nowMs) || expanded);
  return { horizonReason, replan };
};
