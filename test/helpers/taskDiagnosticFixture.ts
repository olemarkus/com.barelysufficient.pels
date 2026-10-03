import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { inactiveTaskEvaluation, type TaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluation';
import { resolveTaskCompletion } from '../../lib/objectives/deferredObjectives/taskCompletion';

type WithoutEvaluation<T> = T extends unknown ? Omit<T, 'evaluation' | 'completion'> : never;
type Fixture = WithoutEvaluation<DeferredObjectiveDiagnostic>;

/** Resolve synthetic fixture inputs once; production decisions never read these reports. */
export const withTaskDiagnosticFixture = <T extends Fixture>(diagnostic: T): T & {
  evaluation: TaskEvaluation;
  completion: DeferredObjectiveDiagnostic['completion'];
} => {
  const evaluation = inactiveTaskEvaluation(diagnostic.deviceId, diagnostic.deadlineAtMs ?? 0, diagnostic.targetValue);
  const progressValid = diagnostic.currentValue !== null && diagnostic.progressDirection !== 'unknown'
    && !['objective_invalid_session', 'objective_missing_temperature', 'objective_progress_stale'].includes(diagnostic.reasonCode);
  if (progressValid && diagnostic.currentValue !== null && diagnostic.progressDirection !== 'unknown') {
    evaluation.progress = { kind: 'known', value: diagnostic.currentValue, direction: diagnostic.progressDirection };
    evaluation.completion = resolveTaskCompletion({ currentValue: diagnostic.currentValue,
      requestedTarget: diagnostic.targetValue, direction: diagnostic.progressDirection, thermalEvidence: { kind: 'none' } });
  }
  if (diagnostic.horizonPlan && diagnostic.trajectory.kind === 'resolved' && diagnostic.trajectory.status !== 'invalid') {
    evaluation.planning = { kind: 'allocated', plan: diagnostic.horizonPlan };
  }
  evaluation.permissions = { budgetExempt: diagnostic.budgetExemptApplied === true,
    limitLowerPriority: diagnostic.limitLowerPriorityApplied === true, pauseLowerPriority: diagnostic.pauseLowerPriorityApplied === true };
  evaluation.targetControl = diagnostic.objectiveKind === 'temperature'
    ? { kind: 'temperature', value: diagnostic.targetTemperatureC } : { kind: 'none' };
  return { ...diagnostic, evaluation, completion: evaluation.completion };
};
