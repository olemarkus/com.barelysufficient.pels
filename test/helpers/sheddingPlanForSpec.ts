import { buildSheddingPlan } from '../../lib/plan/shedding';
import type { PlanContext, MeasuredPower } from '../../lib/plan/planContext';
import type { PlanEngineState } from '../utils/planEngineStateFixture';
import type { SheddingDeps, SheddingOvershootInput, SheddingPlan } from '../../lib/plan/shedding/types';
import { NO_STORAGE_RELIEF } from '../../lib/plan/battery/storageRelief';

export type SheddingFixtureDeps = SheddingDeps & { shortfallThresholdKw: number | null };

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
  deps: SheddingFixtureDeps,
  overshoot: SheddingOvershootInput = {
    actionable: power.headroom.kind === 'on' && power.headroom.kw < 0,
    shedActionable: power.headroom.kind === 'on' && power.headroom.kw < 0,
  },
): Promise<SheddingPlan> => {
  const { shortfallThresholdKw, ...runtimeDeps } = deps;
  const resolvedContext: PlanContext = context.capacity.kind === 'on' && shortfallThresholdKw !== null
    ? { ...context, capacity: { ...context.capacity, shortfallThresholdKw } } : context;
  return buildSheddingPlan(resolvedContext, power, state, runtimeDeps, overshoot, NO_STORAGE_RELIEF);
};
