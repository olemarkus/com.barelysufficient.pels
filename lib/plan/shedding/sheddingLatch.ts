import type { MeasuredPower, PlanContext } from '../planContext';
import { resolveSheddingClearThresholdKw } from '../powerLimitMath';
import type { PlanEngineState } from '../planState';
import type { SheddingOvershootInput } from './types';

/**
 * The shedding latch this build leaves behind (`PlanEngineState.sheddingActive`).
 *
 * Engaged while the house is in an overshoot and something is limited or needs
 * to be. The exhausted hour keeps it engaged on its own: with the hour's kWh
 * spent nothing may restore, even when the measured house is idle and there is
 * nothing left to shed. This used to ride on the context forcing the headroom
 * to -1; it is the flag now (owner ruling 2026-09-02).
 *
 * `actionable`, not `shedActionable`: the latch answers "is the house in an
 * overshoot", which a deferred shed does not change. See
 * `SheddingOvershootInput` for what tying it to the shed choice cost.
 *
 * Released only once headroom clears `SHEDDING_CLEAR_THRESHOLD_KW`, so a plan
 * hovering at the threshold cannot flap it. The release decision is made once,
 * here: it used to be evaluated twice on the same input — once by the planner,
 * then again inside the guard's `releaseShedding` — which is why the caller had
 * to re-read the guard to learn whether its own request had been refused.
 */
export function resolveSheddingLatch(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  overshoot: SheddingOvershootInput,
  shedSet: ReadonlySet<string>,
): boolean {
  const hourlyBudgetExhausted = state.capacityPeriodSpentFor(context);
  const inOvershoot = overshoot.actionable || hourlyBudgetExhausted;
  const remainsOverLimit = power.headroomKw !== null && power.headroomKw < 0;
  if (inOvershoot && (shedSet.size > 0 || hourlyBudgetExhausted || remainsOverLimit)) return true;
  const clearThresholdKw = resolveSheddingClearThresholdKw(context);
  return power.headroomKw === null || power.headroomKw >= clearThresholdKw ? false : state.sheddingActive;
}
