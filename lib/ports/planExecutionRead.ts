import type { ActuationHistoryRead } from './actuationHistory';
import type { PendingTargetCommandRead } from './pendingTargetCommand';
import type { PendingBinaryCommandRead } from './pendingBinaryCommand';

/** Read authority execution grants the planner over command facts, never mutation authority. */
export type PlanExecutionRead = {
  readonly actuation: ActuationHistoryRead;
  readonly pendingTargetCommands: Readonly<Record<string, PendingTargetCommandRead>>;
  readonly pendingBinaryCommands: Readonly<Record<string, PendingBinaryCommandRead>>;
};
