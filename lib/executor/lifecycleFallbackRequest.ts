import type {
  LifecycleFallbackDevice, LifecycleFallbackObservedState, LifecycleFallbackRequest,
} from './lifecycleFallbackDispatcher';
import { buildExecutableObservedDeviceState } from './executablePlanProjection';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

/** Resolved by the input owner; execution materializes it without choosing policy. */
export type LifecycleFallbackPosture =
  | { kind: 'binary_off' }
  | { kind: 'target'; temperature: number }
  | { kind: 'step'; profile: SteppedLoadProfile; stepId: string }
  | { kind: 'no_writable_axis' };

/**
 * What this seam can answer for one device. Kept as a per-device result rather
 * than an exception because the caller loops over every task's diagnostic
 * (`emitDeferredObjectiveLifecycleTransitions`) with no per-iteration guard: a
 * throw would abort that loop, skipping every later device's transition and the
 * status/hours buses behind it.
 */
export type LifecycleFallbackRequestResolution =
  | { state: 'resolved'; request: LifecycleFallbackRequest }
  | { state: 'no_writable_axis' };

export const buildLifecycleFallbackRequest = (
  device: LifecycleFallbackDevice,
  observedState: LifecycleFallbackObservedState,
  posture: LifecycleFallbackPosture,
): LifecycleFallbackRequestResolution => {
  if (posture.kind === 'no_writable_axis') return { state: 'no_writable_axis' };
  // The observed rung is resolved from the report, against the ladder the step
  // posture drives. The dispatcher's retries judge a fresh read by the same
  // ladder.
  const observed = buildExecutableObservedDeviceState(
    { ...device, ...observedState },
    posture.kind === 'step' ? posture.profile : undefined,
  );
  if (posture.kind === 'binary_off') return { state: 'resolved', request: { kind: 'binary_off', observed } };
  if (posture.kind === 'target') {
    return { state: 'resolved', request: { kind: 'target_fallback', observed, desired: posture.temperature } };
  }
  return {
    state: 'resolved',
    request: {
      kind: 'step_fallback',
      observed,
      targetStepId: posture.stepId,
      steppedLoad: buildSteppedIntent(device, posture),
    },
  };
};

const buildSteppedIntent = (
  device: LifecycleFallbackDevice,
  posture: Extract<LifecycleFallbackPosture, { kind: 'step' }>,
): Extract<LifecycleFallbackRequest, { kind: 'step_fallback' }>['steppedLoad'] => ({
  id: device.id,
  name: device.name,
  steppedLoadProfile: posture.profile,
  controlAdapter: device.controlAdapter,
  // The lifecycle fallback drives the device to its configured posture, and for
  // a step-axis device that posture IS `posture.stepId`, the rung a `step`
  // end state names through `desired.stepId`. It keeps its own discriminant
  // (the `step_fallback` request kind) rather than borrowing the capacity
  // path's — see `notes/state-management/deferred-objective-lifecycle-carveout.md`.
  plannedShedTarget: { kind: 'step' },
  desiredOn: false,
  desired: { stepId: posture.stepId, plannedStepId: posture.stepId },
  stepDirection: 'any',
  transition: null,
});
