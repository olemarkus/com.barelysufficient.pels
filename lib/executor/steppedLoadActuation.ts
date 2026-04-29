import { normalizeStepId } from '../utils/stepIds';

export type SteppedStepMaterialization =
  | { kind: 'materialized'; stepId: string; source: 'observed' }
  | { kind: 'not_materialized'; reason: 'no_requested_step' | 'no_observed_match' | 'fallback_only' };

export type SteppedStepActuationState =
  | { kind: 'none'; requestedStepId: undefined; materialization: SteppedStepMaterialization }
  | { kind: 'requested'; requestedStepId: string; materialization: SteppedStepMaterialization };

export type ExecutableSteppedObservedStep =
  | { kind: 'reported'; stepId: string }
  | { kind: 'unknown' };

export type ExecutableSteppedStepState = {
  requestedStepId?: string;
  observedStep: ExecutableSteppedObservedStep;
  fallbackStepId?: string;
};

export function resolveSteppedStepActuationState(params: {
  step: ExecutableSteppedStepState;
}): SteppedStepActuationState {
  const requestedStepId = normalizeStepId(params.step.requestedStepId);
  if (!requestedStepId) {
    return {
      kind: 'none',
      requestedStepId: undefined,
      materialization: { kind: 'not_materialized', reason: 'no_requested_step' },
    };
  }
  return {
    kind: 'requested',
    requestedStepId,
    materialization: resolveRequestedStepMaterialization(params.step, requestedStepId),
  };
}

export function isRequestedStepMaterialized(state: SteppedStepActuationState): boolean {
  return state.materialization.kind === 'materialized';
}

function resolveRequestedStepMaterialization(
  step: ExecutableSteppedStepState,
  requestedStepId: string,
): SteppedStepMaterialization {
  const observedStepId = step.observedStep.kind === 'reported'
    ? normalizeStepId(step.observedStep.stepId)
    : undefined;
  if (observedStepId === requestedStepId) {
    return { kind: 'materialized', stepId: requestedStepId, source: 'observed' };
  }
  if (normalizeStepId(step.fallbackStepId) === requestedStepId) {
    return { kind: 'not_materialized', reason: 'fallback_only' };
  }
  return { kind: 'not_materialized', reason: 'no_observed_match' };
}
