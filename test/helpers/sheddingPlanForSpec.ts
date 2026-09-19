import { buildSheddingPlan } from '../../lib/plan/shedding';
import type { PlanContext, MeasuredPower } from '../../lib/plan/planContext';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { SheddingDeps, SheddingOvershootInput, SheddingPlan } from '../../lib/plan/shedding/types';

/**
 * `buildSheddingPlan` for specs that are not about the soft-overshoot decision.
 * Production always hands it `PlanBuilder`'s decision; a spec that is not about
 * persistence or the shed grace takes the plain one — any deficit is real and
 * acted on at once — unless it passes its own.
 */
export const buildSheddingPlanForSpec = (
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshoot: SheddingOvershootInput = {
    actionable: power.headroomKw < 0,
    shedActionable: power.headroomKw < 0,
  },
): Promise<SheddingPlan> => buildSheddingPlan(context, power, state, deps, overshoot, Date.now());
