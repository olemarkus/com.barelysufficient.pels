import { vi } from 'vitest';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { ExecutorCommandContext } from '../../lib/executor/executorCommandContext';
import type { ExecutableSteppedLoadCommandSession } from '../../lib/executor/executablePlan';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createBinaryCommandClaim } from '../../lib/executor/binaryCommandClaim';
import { createSteppedCommandClaim } from '../../lib/executor/steppedCommandClaim';
import { createTargetCommandClaim } from '../../lib/executor/targetCommandClaim';

/**
 * The command session of a device that was already commanded a step: no unknown
 * step to seed and nothing pending.
 */
export const PRIOR_STEP_COMMAND_SESSION: ExecutableSteppedLoadCommandSession = {
  hasPriorStepCommand: true,
  stepCommandPending: false,
};

/**
 * An ordinary-lane `ExecutorCommandContext` over `state`, for specs that drive
 * the executor's command functions directly. Every read answers "nothing
 * observed", the actuator issues nothing, and the recorders are spies; a spec
 * overrides exactly what its scenario needs.
 */
export const createTestExecutorCommandContext = (
  state: PlanEngineState,
  overrides: Partial<ExecutorCommandContext> = {},
): ExecutorCommandContext => ({
  owner: 'ordinary',
  state,
  targetCommands: state,
  actuator: {
    canTurnOnDevice: () => true,
    apply: async () => ({ requested: false }),
    resolveTemperatureTarget: (_deviceId, desired) => desired,
  },
  pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
  getObservedState: () => undefined,
  readDevice: () => undefined,
  getCapacityDryRun: () => false,
  getOperatingMode: () => 'Home',
  getShedBehavior: () => ({ action: 'turn_off' }),
  getSteppedLoadCommandSession: () => ({ hasPriorStepCommand: false, stepCommandPending: false }),
  markSteppedLoadDesiredStepIssued: vi.fn(),
  syncLivePlanStateAfterTargetActuation: vi.fn(),
  binaryCommandClaim: createBinaryCommandClaim(),
  steppedCommandClaim: createSteppedCommandClaim(),
  targetCommandClaim: createTargetCommandClaim(),
  lifecycleFallback: { isActive: () => false, getOwnedTargetPending: () => undefined },
  isAuthorityCurrent: () => true,
  recordShedActuation: vi.fn(),
  recordReleaseShedActuation: vi.fn(),
  recordRestoreActuation: vi.fn(),
  recordActivationAttemptStarted: vi.fn(),
  ...overrides,
});
