import type { DevicePlan } from '../../lib/plan/planTypes';
import type { ExecutionPlan } from '../../lib/planContract/executionPlan';

/**
 * The plan each execution plan was projected from, for the mock executor in
 * `planEngineMock.ts`. The real executor reads observations from the observer;
 * a `PlanService` spec states them on its plan devices instead, so the mock
 * answers from the plan the projection ran on. A spec routes the real
 * `buildExecutionPlan` through `recordExecutionPlanSource` with `vi.mock`.
 */
const sources = new WeakMap<ExecutionPlan, DevicePlan>();

export const recordExecutionPlanSource = (executionPlan: ExecutionPlan, plan: DevicePlan): ExecutionPlan => {
  sources.set(executionPlan, plan);
  return executionPlan;
};

export const resolveExecutionPlanSource = (executionPlan: ExecutionPlan): DevicePlan => {
  const plan = sources.get(executionPlan);
  if (!plan) throw new Error('Execution plan was not projected through recordExecutionPlanSource');
  return plan;
};
