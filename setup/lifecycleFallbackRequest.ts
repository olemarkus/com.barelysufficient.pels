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
  getSteppedLoadStep,
} from '../lib/utils/deviceControlProfiles';

type ConfiguredFallback = {
  action: 'turn_off' | 'set_temperature' | 'set_step';
  temperature: number | null;
  stepId: string | null;
};

export const resolveLifecycleFallbackRequest = (params: {
  device: LifecycleFallbackDevice;
  observedState: LifecycleFallbackObservedState;
  configuredFallback: ConfiguredFallback;
  nowMs?: number;
}): LifecycleFallbackRequest | null => {
  const {
    device, observedState, configuredFallback,
  } = params;
  const behavior = resolveBehavior(device, configuredFallback);
  if (!behavior) return null;
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
  if (behavior.action === 'turn_off') return { kind: 'binary_off', observed };
  if (behavior.action === 'set_temperature' && behavior.temperature !== null) {
    return { kind: 'target_fallback', observed, desired: behavior.temperature };
  }
  const targetStepId = resolveShedStepId(device, behavior);
  const steppedLoad = targetStepId
    ? buildSteppedIntent(device, targetStepId, params.nowMs ?? Date.now())
    : null;
  return targetStepId && steppedLoad
    ? { kind: 'step_fallback', observed, targetStepId, steppedLoad }
    : null;
};

const resolveBehavior = (
  device: LifecycleFallbackDevice,
  configured: ConfiguredFallback,
): ConfiguredFallback | null => {
  if (
    device.targetAxis.state === 'writable'
    && configured.action === 'set_temperature'
    && configured.temperature !== null
  ) {
    return configured;
  }
  if (device.binaryAxis.state === 'writable') {
    return { action: 'turn_off', temperature: null, stepId: null };
  }
  if (device.stepAxis.state === 'writable') {
    return { action: 'set_step', temperature: null, stepId: configured.stepId };
  }
  return null;
};

const resolveShedStepId = (
  device: LifecycleFallbackDevice,
  behavior: ConfiguredFallback,
): string | null => {
  if (behavior.action !== 'set_step' || device.stepAxis.state !== 'writable') return null;
  const profile = device.stepAxis.profile;
  const preferred = behavior.stepId ? getSteppedLoadStep(profile, behavior.stepId) : null;
  return (
    preferred
    ?? getSteppedLoadLowestActiveStep(profile)
    ?? getSteppedLoadOffStep(profile)
  )?.id ?? null;
};

const buildSteppedIntent = (
  device: LifecycleFallbackDevice,
  targetStepId: string,
  nowMs: number,
): Extract<LifecycleFallbackRequest, { kind: 'step_fallback' }>['steppedLoad'] | null => {
  if (device.stepAxis.state !== 'writable') return null;
  return {
    id: device.id,
    name: device.name,
    purpose: 'shed',
    steppedLoadProfile: device.stepAxis.profile,
    communicationModel: device.communicationModel,
    controlAdapter: device.controlAdapter,
    // The lifecycle fallback drives the device to its configured posture, and for
    // a step-axis device that posture IS `targetStepId`. It keeps its own
    // discriminant (the `behavior` the dispatcher carries) rather than borrowing
    // the capacity path's — see
    // `notes/state-management/deferred-objective-lifecycle-carveout.md`.
    plannedShedTarget: { kind: 'step', stepId: targetStepId },
    desired: { on: false },
    previousStepId: device.selectedStepId ?? device.previousStepId,
    transition: null,
    matchingRestoreAttempt: null,
    matchingCommandAttempt: resolveMatchingStepCommandAttempt(device, targetStepId, nowMs),
    stepCommandRetryCount: device.stepCommandRetryCount ?? 0,
    nextStepCommandRetryAtMs: device.nextStepCommandRetryAtMs,
  };
};

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
