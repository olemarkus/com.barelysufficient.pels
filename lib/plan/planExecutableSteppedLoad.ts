import type { ExecutableSteppedLoadDevice } from '../executor/executablePlan';
import {
  resolveSteppedStepActuationState,
  type ExecutableSteppedStepState,
} from '../executor/steppedLoadActuation';
import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import type { DevicePlan } from './planTypes';
import {
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadTransition,
} from './planSteppedLoad';
import { resolveSteppedRestoreAttemptState } from './planSteppedRestorePending';

type PlanDevice = DevicePlan['devices'][number];

export function buildExecutableSteppedLoadDevice(dev: PlanDevice): ExecutableSteppedLoadDevice | null {
  if (!isSteppedLoadDevice(dev) || !dev.steppedLoadProfile) return null;
  const requestedStepId = resolveSteppedKeepDesiredStepId(dev);
  const transition = resolveSteppedLoadTransition(dev, requestedStepId);
  const commandStepId = transition?.commandStepId ?? requestedStepId;
  const stepActuation = resolveSteppedStepActuationState({
    step: toExecutableSteppedStepState(dev, requestedStepId),
  });
  const commandStepActuation = resolveSteppedStepActuationState({
    step: toExecutableSteppedStepState(dev, commandStepId),
  });
  const matchingRestoreAttempt = requestedStepId !== undefined
    ? resolveSteppedRestoreAttemptState(dev, requestedStepId)
    : null;
  const matchingCommandAttempt = commandStepId !== undefined
    ? resolveSteppedRestoreAttemptState(dev, commandStepId)
    : null;
  const desiredIsNonOff = requestedStepId
    && !isSteppedLoadOffStep(dev.steppedLoadProfile, requestedStepId);
  return {
    id: dev.id,
    name: dev.name,
    plannedState: dev.plannedState,
    reason: dev.reason,
    steppedLoadProfile: dev.steppedLoadProfile,
    communicationModel: dev.communicationModel,
    controlAdapter: dev.controlAdapter,
    shedAction: dev.shedAction,
    effectiveCurrentOn: resolveEffectiveCurrentOn(dev),
    requestedStepId,
    commandStepId,
    previousStepId: dev.selectedStepId ?? dev.lastDesiredStepId,
    currentStepId: dev.selectedStepId,
    currentStepForShed: resolveCurrentStepForShed(dev),
    currentStepIsOffStep: dev.selectedStepId
      ? isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId)
      : false,
    transition,
    stepActuation,
    commandStepActuation,
    matchingRestoreAttempt,
    matchingCommandAttempt,
    stepNeedsAdjustment: Boolean(desiredIsNonOff && stepActuation.materialization.kind !== 'materialized'),
    stepCommandRetryCount: dev.stepCommandRetryCount ?? 0,
    nextStepCommandRetryAtMs: dev.nextStepCommandRetryAtMs,
  };
}

const toExecutableSteppedStepState = (dev: PlanDevice, requestedStepId?: string): ExecutableSteppedStepState => {
  const observedStepId = dev.actualStepSource === 'reported' && dev.actualStepId
    ? dev.actualStepId
    : dev.reportedStepId;
  return {
    requestedStepId,
    observedStep: observedStepId ? { kind: 'reported', stepId: observedStepId } : { kind: 'unknown' },
    fallbackStepId: dev.assumedStepId,
  };
};

const resolveCurrentStepForShed = (
  dev: PlanDevice,
): ExecutableSteppedLoadDevice['currentStepForShed'] => {
  if (!dev.steppedLoadProfile || !dev.selectedStepId) return undefined;
  const currentStep = getSteppedLoadStep(dev.steppedLoadProfile, dev.selectedStepId);
  return currentStep ? {
    stepId: currentStep.id,
    planningPowerW: currentStep.planningPowerW,
  } : undefined;
};
