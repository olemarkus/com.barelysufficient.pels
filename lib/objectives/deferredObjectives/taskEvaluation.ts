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
  /** This interval can use available power without making a task promise. */
  usesAvailablePower?: true;
  /**
   * `learning`: a temperature task whose device has no learned energy per degree
   * yet. Nothing can be allocated, so the task heats toward its target on free
   * capacity, which is also what produces the readings the rate is learned from.
   * Once the rate is known the task is allocated as usual.
   *
   * `awaiting_plan`: queued allocation work. A new task leaves normal control
   * intact. An incompatible commitment suspends task requests while its replacement is queued.
   *
   * `awaiting_prices`: prices do not yet reach the deadline, so nothing can be
   * allocated. The task holds its device until the latest start that still
   * meets the deadline, then runs it on free capacity (`withAwaitingPricesPlanning`).
   */
  planning:
    | { kind: 'inactive' }
    | { kind: 'learning' }
    | { kind: 'awaiting_plan'; device: 'replanning' | 'unchanged' }
    | { kind: 'awaiting_prices'; device: 'held' | 'running' }
    | { kind: 'allocated'; plan: DeferredObjectiveHorizonPlan };
  permissions: { budgetExempt: boolean; limitLowerPriority: boolean; pauseLowerPriority: boolean };
  targetControl: { kind: 'none' } | { kind: 'temperature'; value: number };
};

/** A task holds no rescue permission: unset, or its obligation is met. */
export const NO_TASK_PERMISSIONS: TaskEvaluation['permissions'] = {
  budgetExempt: false, limitLowerPriority: false, pauseLowerPriority: false,
};

export const inactiveTaskEvaluation = (
  deviceId: string, deadlineAtMs: number, requestedTarget: number,
): TaskEvaluation => ({
  deviceId, deadlineAtMs, requestedTarget,
  progress: { kind: 'unobserved' }, completion: { kind: 'inactive' }, planning: { kind: 'inactive' },
  permissions: NO_TASK_PERMISSIONS,
  targetControl: { kind: 'none' },
});

/** Commitment writers call this only for an allocated evaluation. */
export const allocatedTaskPlan = (evaluation: TaskEvaluation): DeferredObjectiveHorizonPlan => {
  if (evaluation.planning.kind !== 'allocated') throw new Error('Task has no allocation to commit');
  return evaluation.planning.plan;
};
