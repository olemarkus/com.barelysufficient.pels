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
 * gate: no controlled load left to act on. With no plan yet (`null`) nothing has
 * been proved, so nothing is unactionable or unrecoverable — a first rebuild is
 * never held. That is decided here, once.
 *
 * The summary is the plan AS BUILT: between builds it does not see a device a
 * restore has since turned on. An observation of a device that can change the
 * actionable load (`PlanService.canDeviceChangeActionableLoad`) clears the
 * throttle's latch so the next reading still decides, but the 15 s execution
 * floor (`TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS`) may space that decision.
 * That is the throttle's deliberate CPU-versus-capacity trade: the hard cap is
 * an average over the selected capacity period (60 or 15 minutes), so a
 * re-shed held for those seconds costs a small share of the period's
 * allowance, four times larger on a 15-minute period.
 */
export function resolvePlanRebuildPosture(
  summary: PlanCapacityStateSummary | null,
  planState: PlanConvergenceState,
): PlanRebuildPosture {
  // An unwinnable overshoot must not count as "converging": convergence bypasses
  // the throttle's anti-storm gates, and that bypass is what let a persistent
  // 0-allowance shortfall rebuild ~1.6 s of plan on every power sample until the
  // cpuwarn watchdog killed the app. In-flight commands still win inside the helper.
  const unactionable = summary !== null && isPlanUnactionable(summary);
  return {
    planConvergenceActive: isPlanActivelyConverging(planState, { unactionable }),
    unactionable,
    shortfallUnrecoverable: summary !== null && !summary.remainingActionableControlledLoad,
  };
}
