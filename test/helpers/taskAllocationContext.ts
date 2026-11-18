import type { DeferredObjectiveActivePlansV2 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  withTaskAllocationContexts, type OrderedDeferredObjective,
} from '../../lib/objectives/deferredObjectives/priorityAllocation';

/** Seed a fixture revision with the same stable context the coordinator records. */
export const fixturePlanningTurnContext = (
  prefix: readonly OrderedDeferredObjective[], plans: DeferredObjectiveActivePlansV2,
): string => {
  const last = withTaskAllocationContexts(prefix, plans).at(-1);
  if (last === undefined) throw new Error('Expected a task prefix for the fixture revision');
  return last.planningContextSignature;
};
