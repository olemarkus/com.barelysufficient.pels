import { resolveTaskCompletion } from './taskCompletion';
import type { TaskEvaluation } from './taskEvaluation';
import type {
  DeferredObjectiveDiagnostic, DeferredObjectiveStallClassificationReader,
} from './diagnosticTypes';

/**
 * Resolve completion from owner-observed progress and evidence for this obligation.
 * Allocation is independent: a task can complete before prices allow a schedule.
 * The caller's observed-task gate prevents a replacement inheriting the device's
 * previous classifier verdict.
 */
export const completionFromEvaluation = (
  evaluation: TaskEvaluation,
  getStallClassification: DeferredObjectiveStallClassificationReader,
  hasObservedTask: boolean,
): TaskEvaluation['completion'] => {
  const { progress } = evaluation;
  if (progress.kind === 'unobserved' || !hasObservedTask
    || evaluation.targetControl.kind !== 'temperature') return evaluation.completion;
  const evidence = getStallClassification(evaluation.deviceId);
  if (evidence === undefined) return evaluation.completion;
  return resolveTaskCompletion({
    currentValue: progress.value,
    requestedTarget: evaluation.requestedTarget,
    direction: progress.direction,
    thermalEvidence: { kind: 'accepted', evidence },
  });
};

/** Project the resolved completion into live reporting; never classify it again. */
export const reportTaskCompletionDiagnostic = (
  diagnostic: DeferredObjectiveDiagnostic,
): DeferredObjectiveDiagnostic => {
  const { completion } = diagnostic.evaluation;
  if (completion.kind === 'accepted_near_target') {
    return { ...diagnostic, trajectory: { kind: 'resolved', status: 'satisfied' },
      reasonCode: 'objective_stalled_near_target' };
  }
  if (completion.kind === 'target_reached') {
    return { ...diagnostic, trajectory: { kind: 'resolved', status: 'satisfied' } };
  }
  return diagnostic;
};
