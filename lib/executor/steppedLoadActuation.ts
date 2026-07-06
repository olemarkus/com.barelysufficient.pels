import { normalizeStepId } from '../utils/stepIds';

export type SteppedStepMaterialization =
  | { kind: 'materialized'; stepId: string; source: 'observed' | 'confirmed_command' }
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
  // Step of the last issued step command when device-side feedback confirmed
  // it (a flow report matching the commanded step). The projection populates
  // this only while the device is observed OFF — the restore-preparation
  // window where no observed step report can exist for a flow-backed stepper
  // (non-off flow reports are suppressed as observed evidence while off). It
  // is commanded-axis confirmation, never observed running-state.
  confirmedCommandStepId?: string;
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
  // A confirmed step command is restore-preparation evidence while the device
  // is off (the only time the projection supplies it): the device acknowledged
  // applying the requested step, it just cannot show it as an observed report
  // yet. An observed report for the requested step still wins above; an
  // observed off-step report merely predates the confirmed preparation.
  if (normalizeStepId(step.confirmedCommandStepId) === requestedStepId) {
    return { kind: 'materialized', stepId: requestedStepId, source: 'confirmed_command' };
  }
  if (normalizeStepId(step.fallbackStepId) === requestedStepId) {
    return { kind: 'not_materialized', reason: 'fallback_only' };
  }
  return { kind: 'not_materialized', reason: 'no_observed_match' };
}
