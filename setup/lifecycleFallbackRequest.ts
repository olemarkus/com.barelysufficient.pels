import type {
  LifecycleFallbackDevice,
  LifecycleFallbackObservedState,
  LifecycleFallbackRequest,
} from '../lib/executor/lifecycleFallbackDispatcher';
import { buildExecutableObservedDeviceState } from '../lib/executor/executablePlanProjection';
import { getCurrentDrawKw } from '../lib/observer/observedPower';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadOffStep,
} from '../lib/utils/deviceControlProfiles';
import type { SteppedLoadProfile } from '../packages/contracts/src/types';
import type { ShedBehavior } from '../lib/plan/planTypes';

/**
 * The resolved end state a lifecycle fallback drives to, with the descriptor the
 * write needs already picked. Producing this is the whole judgement in this
 * file, so it happens ONCE: downstream builders read the posture and never
 * re-ask an axis whether it is writable.
 *
 * `no_writable_axis` is a real device state, not a wiring bug — see
 * {@link resolveFallbackPosture}.
 */
type LifecycleFallbackPosture =
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

export const resolveLifecycleFallbackRequest = (params: {
  device: LifecycleFallbackDevice;
  observedState: LifecycleFallbackObservedState;
  configuredFallback: ShedBehavior;
  nowMs?: number;
}): LifecycleFallbackRequestResolution => {
  const {
    device, observedState, configuredFallback,
  } = params;
  const posture = resolveFallbackPosture(device, configuredFallback);
  if (posture.kind === 'no_writable_axis') return { state: 'no_writable_axis' };
  const steppedDescriptor = device.stepAxis.state === 'writable'
    ? { steppedLoadProfile: device.stepAxis.profile }
    : {};
  const observed = buildExecutableObservedDeviceState({
    ...device,
    ...steppedDescriptor,
    ...observedState,
    selectedStepId: observedState.reportedStepId,
    currentDrawKw: getCurrentDrawKw(observedState),
  });
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
      steppedLoad: buildSteppedIntent(device, posture, params.nowMs ?? Date.now()),
    },
  };
};

/**
 * Resolves the fallback posture, including the case where there is nothing to
 * drive.
 *
 * The step rung is the DEVICE's: its lowest active step, or its off step. A
 * configured step id used to sit above those two, but nothing ever wrote one —
 * `normalizeShedBehaviors` stores `set_step` as a bare `{ action }` — so that
 * branch could not be reached from settings.
 *
 * `no_writable_axis` is REACHABLE, and the reason is worth stating: the
 * lifecycle emitter's device list is `planService.getPlanDevices()`, which
 * filters on MANAGED status, not on axis presence. A target-only thermostat
 * whose owner switched temperature control off has no target axis (the flag),
 * no step axis (the producer strips the ladder with the same flag) and no binary
 * axis (no `onoff`) — three legitimate `unavailable`s and nothing to command.
 *
 * It is a returned result, never a throw and never a bare `null`. A throw
 * escapes the caller's un-guarded per-device loop and kills the rest of the
 * tick; `null` is what used to become `'unsupported'`, which the caller answered
 * by permanently disarming the owner's task with nothing logged. Named, the
 * caller can log it once and fall into its ordinary graced-retry arm.
 */
const resolveFallbackPosture = (
  device: LifecycleFallbackDevice,
  configured: ShedBehavior,
): LifecycleFallbackPosture => {
  if (device.targetAxis.state === 'writable' && configured.action === 'set_temperature') {
    return { kind: 'target', temperature: configured.temperature };
  }
  if (device.binaryAxis.state === 'writable') return { kind: 'binary_off' };
  if (device.stepAxis.state === 'writable') {
    const { profile } = device.stepAxis;
    const step = getSteppedLoadLowestActiveStep(profile) ?? getSteppedLoadOffStep(profile);
    if (step) return { kind: 'step', profile, stepId: step.id };
  }
  return { kind: 'no_writable_axis' };
};

const buildSteppedIntent = (
  device: LifecycleFallbackDevice,
  posture: Extract<LifecycleFallbackPosture, { kind: 'step' }>,
  nowMs: number,
): Extract<LifecycleFallbackRequest, { kind: 'step_fallback' }>['steppedLoad'] => ({
  id: device.id,
  name: device.name,
  steppedLoadProfile: posture.profile,
  communicationModel: device.communicationModel,
  controlAdapter: device.controlAdapter,
  // The lifecycle fallback drives the device to its configured posture, and for
  // a step-axis device that posture IS `posture.stepId`. It keeps its own
  // discriminant (the `behavior` the dispatcher carries) rather than borrowing
  // the capacity path's — see
  // `notes/state-management/deferred-objective-lifecycle-carveout.md`.
  plannedShedTarget: { kind: 'step', stepId: posture.stepId },
  desiredOn: false,
  desired: {},
  previousStepId: device.selectedStepId ?? device.previousStepId,
  transition: null,
  matchingRestoreAttempt: null,
  matchingCommandAttempt: resolveMatchingStepCommandAttempt(device, posture.stepId, nowMs),
  stepCommandRetryCount: device.stepCommandRetryCount ?? 0,
  nextStepCommandRetryAtMs: device.nextStepCommandRetryAtMs,
});

const resolveMatchingStepCommandAttempt = (
  device: LifecycleFallbackDevice,
  targetStepId: string,
  nowMs: number,
): Extract<
  Extract<LifecycleFallbackRequest, { kind: 'step_fallback' }>['steppedLoad'],
  object
>['matchingCommandAttempt'] => {
  // The app-side decorator owns the accepted command-axis state, so this setup
  // boundary classifies it before handing a trusted intent to the executor.
  // An opposing accepted command is deliberately NOT a matching dampener: the
  // lifecycle fallback supersedes it immediately and the accepted fallback
  // replaces the command-axis state through markSteppedLoadDesiredStepIssued.
  if (!device.desiredStepId || device.desiredStepId !== targetStepId) return null;
  if (device.stepCommandPending === true) {
    return { status: 'awaiting_confirmation', requestedStepId: targetStepId };
  }
  if (
    device.stepCommandStatus === 'stale'
    && typeof device.nextStepCommandRetryAtMs === 'number'
    && nowMs < device.nextStepCommandRetryAtMs
  ) {
    return { status: 'retry_backoff', requestedStepId: targetStepId };
  }
  return null;
};
