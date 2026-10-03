import type { ObjectiveProgressDirection } from '../types';
import type { DeferredObjectiveHorizonPlan } from './types';
import type { TaskCompletion } from './taskCompletion';

/** Operational result. Reporting metadata cannot change these decisions. */
export type TaskEvaluation = {
  deviceId: string;
  deadlineAtMs: number;
  requestedTarget: number;
  progress: { kind: 'unobserved' } | { kind: 'known'; value: number; direction: ObjectiveProgressDirection };
  completion: TaskCompletion | { kind: 'inactive' };
  planning: { kind: 'inactive' } | { kind: 'allocated'; plan: DeferredObjectiveHorizonPlan };
  permissions: { budgetExempt: boolean; limitLowerPriority: boolean; pauseLowerPriority: boolean };
  targetControl: { kind: 'none' } | { kind: 'temperature'; value: number };
};

export const inactiveTaskEvaluation = (
  deviceId: string, deadlineAtMs: number, requestedTarget: number,
): TaskEvaluation => ({
  deviceId, deadlineAtMs, requestedTarget,
  progress: { kind: 'unobserved' }, completion: { kind: 'inactive' }, planning: { kind: 'inactive' },
  permissions: { budgetExempt: false, limitLowerPriority: false, pauseLowerPriority: false },
  targetControl: { kind: 'none' },
});

/** Commitment writers call this only for an allocated evaluation. */
export const allocatedTaskPlan = (evaluation: TaskEvaluation): DeferredObjectiveHorizonPlan => {
  if (evaluation.planning.kind !== 'allocated') throw new Error('Task has no allocation to commit');
  return evaluation.planning.plan;
};
