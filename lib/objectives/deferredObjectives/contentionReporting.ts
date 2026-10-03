import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import type { TaskEvaluation } from './taskEvaluation';

/** Project the resolved operational contention verdict into reporting fields. */
export const reportHigherPriorityContention = (
  diagnostic: DeferredObjectiveDiagnostic,
  evaluation: TaskEvaluation,
): DeferredObjectiveDiagnostic => {
  if (evaluation === diagnostic.evaluation) return diagnostic;
  if (evaluation.planning.kind === 'inactive') return { ...diagnostic, evaluation };
  const { plan } = evaluation.planning;
  return {
    ...diagnostic, evaluation, completion: evaluation.completion,
    trajectory: { kind: 'resolved', status: plan.status },
    reasonCode: plan.statusDetail,
    horizonPlan: plan,
    budgetExemptApplied: evaluation.permissions.budgetExempt
      && evaluation.planning.kind === 'allocated' && evaluation.planning.plan.currentHourClaim === 'claimed',
  };
};
