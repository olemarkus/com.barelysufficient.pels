import type { DeferredObjectiveActivePlansV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { StallEvidence } from '../../../packages/contracts/src/idleClassification';
import { resolveTaskCompletion, type TaskCompletion } from './taskCompletion';
import type { TaskEvaluation } from './taskEvaluation';
import {
  type DeferredObjectiveDiagnostic, type DeferredObjectiveStallClassificationReader,
} from './diagnosticTypes';

// True once the active-plan recorder has committed a `latest` revision for this
// exact (device, deadline) run. Used to suppress stall resolution on a
// first-seen task: the idle classifier ticks AFTER plan emission and is keyed by
// device only, so on a brand-new objective's first cycle `getStallClassification`
// returns the PREVIOUS cycle's verdict — which belongs to whatever ran on that
// device before. Resolving on that stale value would flash a brand-new deadline
// as `satisfied` (and could write a first revision / fire a Flow) until the
// classifier re-ticks. Mirrors the postmortem's "skip stall promotion on
// first-seen records" guard (planHistory `observeDiagnostic`). Inlined rather
// than reusing `findPlanForRecord` to avoid a diagnosticsBridge↔planHistory
// import cycle.
export const hasEstablishedActivePlan = (
  activePlans: DeferredObjectiveActivePlansV1 | null | undefined,
  deviceId: string,
  deadlineAtMs: number | null,
): boolean => {
  if (deadlineAtMs === null) return false;
  const plan = activePlans?.plansByDeviceId[deviceId];
  return plan?.deadlineAtMs === deadlineAtMs && plan?.latest != null;
};

/** Resolve completion at the diagnostic boundary; the core receives known values only. */
export const completionFromDiagnostic = (
  diagnostic: DeferredObjectiveDiagnostic,
  evidence: StallEvidence | undefined,
  hasEstablishedPlan: boolean,
): TaskCompletion | { kind: 'inactive' } => completionFromEvaluation(
  diagnostic.evaluation, evidence, hasEstablishedPlan,
);

export const completionFromEvaluation = (
  evaluation: TaskEvaluation,
  evidence: StallEvidence | undefined,
  hasEstablishedPlan: boolean,
): TaskCompletion | { kind: 'inactive' } => {
  const { progress } = evaluation;
  if (progress.kind === 'unobserved') return { kind: 'inactive' };
  const thermalEvidence = hasEstablishedPlan
    && evaluation.targetControl.kind === 'temperature' && evidence !== undefined
    ? { kind: 'accepted' as const, evidence }
    : { kind: 'none' as const };
  return resolveTaskCompletion({
    currentValue: progress.value,
    requestedTarget: evaluation.requestedTarget,
    direction: progress.direction,
    thermalEvidence,
  });
};

/**
 * Resolve the user-facing `status` (NOT `horizonPlan.status`, which stays the
 * raw trajectory verdict) of every task stalled at its target to `satisfied`,
 * so the status chip, notifications and Flows agree with the postmortem
 * recorder (which already promotes such runs to `satisfied(stalled)`).
 *
 * The lifecycle emitter applies it; the decoration / actuation path must not,
 * because admission reads a `satisfied` task as `inactive` — only
 * `horizonPlan.status` (untouched) drives commitment.
 */
export const reportStalledTasksAsSatisfied = (
  diagnostics: readonly DeferredObjectiveDiagnostic[],
  getStallClassification: DeferredObjectiveStallClassificationReader,
  activePlans: DeferredObjectiveActivePlansV1 | null,
): DeferredObjectiveDiagnostic[] => diagnostics.map((diagnostic) => resolveTaskCompletionDiagnostic(
  diagnostic,
  getStallClassification(diagnostic.deviceId),
  hasEstablishedActivePlan(activePlans, diagnostic.deviceId, diagnostic.deadlineAtMs),
));

/** Resolve observer completion once for live status and recorded outcomes. */
export const resolveTaskCompletionDiagnostic = (
  diagnostic: DeferredObjectiveDiagnostic,
  evidence: StallEvidence | undefined,
  hasEstablishedPlan: boolean,
): DeferredObjectiveDiagnostic => {
  const completion = completionFromDiagnostic(diagnostic, evidence, hasEstablishedPlan);
  const resolved = { ...diagnostic, completion, evaluation: { ...diagnostic.evaluation, completion } };
  if (completion.kind === 'accepted_near_target') {
    return { ...resolved, trajectory: { kind: 'resolved', status: 'satisfied' },
      reasonCode: 'objective_stalled_near_target' };
  }
  if (completion.kind === 'target_reached') {
    return { ...resolved, trajectory: { kind: 'resolved', status: 'satisfied' } };
  }
  return resolved;
};
