import type { PlanCapacityStateSummary } from '../power/capacityStateSummary';
import { isPlanUnactionable } from './planLogging';
import { isPlanActivelyConverging, type PlanConvergenceState } from './planStateHelpers';
import type { PlanRebuildPosture } from './rebuildScheduler/rebuildSignal';

/**
 * What the last plan says about whether rebuilding can change anything — the
 * three bits `PlanRebuildThrottle.onSample` gates on, resolved here, once, from
 * the plan's own summary and state. The wiring forwards the object; it does not
 * classify the summary itself (`setup/AGENTS.md` § "No domain logic").
 *
 * `shortfallUnrecoverable` is the plan's half of the unrecoverable-shortfall
 * gate: no controlled load left to act on. A summary that could not say
 * (`null`, no plan yet) is not unrecoverable — a first rebuild is never held.
 */
export function resolvePlanRebuildPosture(
  summary: PlanCapacityStateSummary,
  planState: PlanConvergenceState | null | undefined,
): PlanRebuildPosture {
  // An unwinnable overshoot must not count as "converging": convergence bypasses
  // the throttle's anti-storm gates, and that bypass is what let a persistent
  // 0-allowance shortfall rebuild ~1.6 s of plan on every power sample until the
  // cpuwarn watchdog killed the app. In-flight commands still win inside the helper.
  const unactionable = isPlanUnactionable(summary);
  return {
    planConvergenceActive: isPlanActivelyConverging(planState, { unactionable }),
    unactionable,
    shortfallUnrecoverable: summary.remainingActionableControlledLoad === false,
  };
}
