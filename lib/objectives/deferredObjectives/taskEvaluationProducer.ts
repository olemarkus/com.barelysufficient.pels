import type { DeferredObjectiveSettingsEntry } from '../../../packages/contracts/src/deferredObjectiveSettings';
import { resolveObjectiveTargetValue } from '../../../packages/shared-domain/src/deferredObjectiveValues';
import type { DeferredObjectiveProgressResolution } from './diagnosticProgress';
import type { DeferredObjectiveHorizonPlan } from './types';
import { resolveTaskCompletion } from './taskCompletion';
import { inactiveTaskEvaluation, type TaskEvaluation } from './taskEvaluation';

type KnownProgress = Extract<DeferredObjectiveProgressResolution, { reasonCode: null }>;

export const taskPermissionsForObjective = (
  objective: DeferredObjectiveSettingsEntry,
): TaskEvaluation['permissions'] => ({
  budgetExempt: objective.rescue?.exemptFromBudget === 'always',
  limitLowerPriority: objective.rescue?.limitLowerPriorityDevices === 'always',
  pauseLowerPriority: objective.rescue?.pauseLowerPriorityDevices === 'always',
});

/** Preserve trusted owner progress when policy cannot allocate a task. */
export const buildUnallocatedTaskEvaluation = (
  deviceId: string,
  objective: DeferredObjectiveSettingsEntry,
  progress: DeferredObjectiveProgressResolution,
): TaskEvaluation => {
  const requestedTarget = resolveObjectiveTargetValue(objective);
  const inactive: TaskEvaluation = {
    ...inactiveTaskEvaluation(deviceId, objective.deadlineAtMs, requestedTarget),
    permissions: taskPermissionsForObjective(objective),
    targetControl: objective.kind === 'temperature'
      ? { kind: 'temperature', value: objective.targetTemperatureC }
      : { kind: 'none' },
  };
  if (progress.reasonCode !== null) return inactive;
  return {
    ...inactive,
    progress: { kind: 'known', value: progress.currentValue, direction: progress.progressDirection },
    completion: resolveTaskCompletion({ currentValue: progress.currentValue, requestedTarget,
      direction: progress.progressDirection, thermalEvidence: { kind: 'none' } }),
  };
};

/** The allocation and owner inputs produce all operational facts together. */
export const buildAllocatedTaskEvaluation = (
  deviceId: string,
  objective: DeferredObjectiveSettingsEntry,
  progress: KnownProgress,
  plan: DeferredObjectiveHorizonPlan,
): TaskEvaluation => ({
  ...buildUnallocatedTaskEvaluation(deviceId, objective, progress),
  planning: { kind: 'allocated', plan },
});
