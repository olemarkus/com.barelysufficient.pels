import type { PlanEngineState } from './planState';

type PlanConvergenceState = Pick<
  PlanEngineState,
  | 'wasOvershoot'
  | 'pendingSheds'
  | 'pendingRestores'
  | 'pendingTargetCommands'
  | 'pendingBinaryCommands'
>;

const hasPendingPlanWork = (planState: PlanConvergenceState): boolean => (
  planState.pendingSheds.size > 0
  || planState.pendingRestores.size > 0
  || Object.keys(planState.pendingTargetCommands).length > 0
  || Object.keys(planState.pendingBinaryCommands).length > 0
);

export function isPlanActivelyConverging(
  planState: PlanConvergenceState | null | undefined,
): boolean {
  if (!planState) return false;
  if (planState.wasOvershoot) return true;
  return hasPendingPlanWork(planState);
}
