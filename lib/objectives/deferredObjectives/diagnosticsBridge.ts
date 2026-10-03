import { buildDeferredObjectiveTaskResults } from './taskEvaluationCoordinator';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import type { TaskEvaluation } from './taskEvaluation';

export type { BuildPriceHorizon, DeferredObjectiveDiagnostic } from './diagnosticTypes';
export { progressCurrentValue } from './diagnosticFields';
export { reportStalledTasksAsSatisfied, resolveTaskCompletionDiagnostic }
  from './completionDiagnostic';
export { emitDeferredObjectiveDiagnostics, type DeferredObjectiveAnnounce } from './diagnosticAnnounce';

/** Reporting consumes task results; operational decisions were already established. */
export const buildDeferredObjectiveDiagnostics = (
  params: Parameters<typeof buildDeferredObjectiveTaskResults>[0],
): DeferredObjectiveDiagnostic[] => buildDeferredObjectiveTaskResults(params).map((result) => result.diagnostic);

export const buildDeferredObjectiveEvaluations = (
  params: Parameters<typeof buildDeferredObjectiveTaskResults>[0],
): TaskEvaluation[] => buildDeferredObjectiveTaskResults(params).map((result) => result.evaluation);
