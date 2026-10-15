import {
  buildDeferredObjectiveTaskResults,
  type TaskEvaluationLane,
  type TaskEvaluationReaders,
  type TaskEvaluationSnapshot,
} from './taskEvaluationCoordinator';

export {
  buildTaskEvaluationSnapshot,
  LIVE_LANE,
  type TaskEvaluationLane,
  type TaskEvaluationReaders,
  type TaskEvaluationSnapshot,
  type TaskEvaluationSource,
} from './taskEvaluationCoordinator';
import type { PriorityAllocationTracker } from './priorityAllocation';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import type { TaskEvaluation } from './taskEvaluation';

export type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
export { progressCurrentValue } from './diagnosticFields';
export { reportTaskCompletionDiagnostic }
  from './completionDiagnostic';
export { emitDeferredObjectiveDiagnostics, type DeferredObjectiveAnnounce } from './diagnosticAnnounce';

/** Reporting consumes task results; operational decisions were already established. */
export const buildDeferredObjectiveDiagnostics = (
  snapshot: TaskEvaluationSnapshot,
  readers: TaskEvaluationReaders,
  tracker: PriorityAllocationTracker,
  lane: TaskEvaluationLane,
): DeferredObjectiveDiagnostic[] => buildDeferredObjectiveTaskResults(snapshot, readers, tracker, lane)
  .map((result) => result.diagnostic);

export const buildDeferredObjectiveEvaluations = (
  snapshot: TaskEvaluationSnapshot,
  readers: TaskEvaluationReaders,
  tracker: PriorityAllocationTracker,
  lane: TaskEvaluationLane,
): TaskEvaluation[] => buildDeferredObjectiveTaskResults(snapshot, readers, tracker, lane)
  .map((result) => result.evaluation);
