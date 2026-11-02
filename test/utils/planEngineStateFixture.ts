import type { PendingBinaryCommand } from '../../lib/observer/pendingBinaryCommandTypes';
import { createPlanEngineState as createRealPlanEngineState, type PlanEngineState as RealPlanEngineState } from '../../lib/plan/planState';
import { ExecutionState, type PendingTargetCommandState } from '../../lib/executor/executionState';
import { ActuationRecord } from '../../lib/executor/actuationRecord';
import { PlanExecutionFeedback } from '../../lib/plan/planExecutionFeedback';
import { PlanExecutor as RealPlanExecutor, type PlanExecutorDeps } from '../../lib/executor/planExecutor';

export type PlanEngineState = RealPlanEngineState & {
  actuation: ActuationRecord;
  pendingBinaryCommands: Record<string, PendingBinaryCommand>;
  pendingTargetCommands: Record<string, PendingTargetCommandState>;
};
const executionByState = new WeakMap<RealPlanEngineState, ExecutionState>();
const noDeviceExternallyHeld = (): boolean => false;

export const createPlanEngineState = (
  nowTs = Date.now(),
  isExternalOffHeld: (deviceId: string) => boolean = noDeviceExternallyHeld,
): PlanEngineState => {
  const execution = new ExecutionState();
  const state = createRealPlanEngineState(nowTs, isExternalOffHeld, execution) as PlanEngineState;
  executionByState.set(state, execution);
  return state;
};

export const getTestExecutionState = (state: RealPlanEngineState): ExecutionState => {
  const execution = executionByState.get(state);
  if (!execution) throw new Error('Construct state through planEngineStateFixture');
  return execution;
};

/** Production-shaped construction while tests keep their explicit mutable state fixture. */
export const createTestPlanExecutor = (deps: PlanExecutorDeps, state: RealPlanEngineState): RealPlanExecutor => (
  new RealPlanExecutor(deps, getTestExecutionState(state), new PlanExecutionFeedback(state, deps.deviceDiagnostics))
);

/** Explicit mutation authority for integration specs seeding a production-composed engine. */
export const getTestExecutionFacts = (state: RealPlanEngineState): Pick<ExecutionState,
  'actuation' | 'pendingTargetCommands' | 'pendingBinaryCommands'> => {
  if (!(state.actuation instanceof ActuationRecord)) throw new Error('Expected execution-owned actuation history');
  return {
    actuation: state.actuation,
    pendingTargetCommands: state.pendingTargetCommands as Record<string, PendingTargetCommandState>,
    pendingBinaryCommands: state.pendingBinaryCommands as Record<string, PendingBinaryCommand>,
  };
};
