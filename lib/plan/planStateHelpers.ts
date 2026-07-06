import type { PlanEngineState } from './planState';

type PlanConvergenceState = Pick<
  PlanEngineState,
  | 'wasOvershoot'
  | 'pendingSheds'
  | 'pendingRestores'
  | 'pendingTargetCommands'
  | 'pendingBinaryCommands'
>;

export type PlanConvergenceOptions = {
  /**
   * Last plan snapshot proved nothing can be shed AND nothing further reduced
   * (`isPlanUnactionable` on the latest plan-capacity summary). Required so a
   * caller cannot silently fall back to the pre-fix semantics where any active
   * overshoot bypassed the scheduler's anti-storm guards.
   */
  unactionable: boolean;
};

const hasPendingPlanWork = (planState: PlanConvergenceState): boolean => (
  planState.pendingSheds.size > 0
  || planState.pendingRestores.size > 0
  || Object.keys(planState.pendingTargetCommands).length > 0
  || Object.keys(planState.pendingBinaryCommands).length > 0
);

/**
 * "Actively converging" lets the rebuild scheduler bypass its anti-storm guards
 * (unrecoverable-shortfall skip, unactionable throttle, tight-unactionable floor),
 * so it must only be true while a rebuild can still change something. Pending
 * in-flight commands always qualify. An active overshoot qualifies only while the
 * last plan proved something is still actionable: an unwinnable overshoot (all
 * managed devices shed, remaining draw unmanaged) otherwise keeps this flag true
 * for the whole clamp window, defeats every guard, and rebuilds ~1.6s of plan on
 * every power sample until Homey's cpuwarn watchdog kills the app.
 */
export function isPlanActivelyConverging(
  planState: PlanConvergenceState | null | undefined,
  options: PlanConvergenceOptions,
): boolean {
  if (!planState) return false;
  if (hasPendingPlanWork(planState)) return true;
  return planState.wasOvershoot && !options.unactionable;
}
