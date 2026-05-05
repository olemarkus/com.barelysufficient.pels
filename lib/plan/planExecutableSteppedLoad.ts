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
import {
  allowsSteppedLoadKeepInvariantRestore,
  isRestoreAdmissionHoldReason,
} from '../planContract/planDecisionSemantics';

type PlanDevice = DevicePlan['devices'][number];

export function buildExecutableSteppedLoadDevice(dev: PlanDevice): ExecutableSteppedLoadDevice | null {
  if (!isSteppedLoadDevice(dev) || !dev.steppedLoadProfile) return null;
  const current = {
    on: resolveEffectiveCurrentOn(dev),
    stepId: dev.selectedStepId,
    stepForShed: resolveCurrentStepForShed(dev),
    stepIsOffStep: dev.selectedStepId
      ? isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId)
      : false,
  };
  const plannedStepId = resolveSteppedKeepDesiredStepId(dev);
  const plannedTransition = resolveSteppedLoadTransition(dev, plannedStepId);
  const desired = resolveDesiredState({
    dev,
    current,
    plannedStepId,
    plannedTransition,
  });
  const transition = desiredMatchesTransition(desired, plannedTransition) ? plannedTransition : null;
  const stepActuation = resolveSteppedStepActuationState({
    step: toExecutableSteppedStepState(dev, desired.stepId),
  });
  const commandStepActuation = resolveSteppedStepActuationState({
    step: toExecutableSteppedStepState(dev, desired.stepId),
  });
  const matchingRestoreAttempt = desired.stepId !== undefined
    ? resolveSteppedRestoreAttemptState(dev, desired.stepId)
    : null;
  const matchingCommandAttempt = desired.stepId !== undefined
    ? resolveSteppedRestoreAttemptState(dev, desired.stepId)
    : null;
  const desiredIsNonOff = desired.stepId
    && !isSteppedLoadOffStep(dev.steppedLoadProfile, desired.stepId);
  return {
    id: dev.id,
    name: dev.name,
    steppedLoadProfile: dev.steppedLoadProfile,
    communicationModel: dev.communicationModel,
    controlAdapter: dev.controlAdapter,
    targetPowerConfig: dev.targetPowerConfig,
    shedAction: dev.shedAction,
    current,
    desired,
    previousStepId: dev.selectedStepId ?? dev.lastDesiredStepId,
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

const resolveDesiredState = (params: {
  dev: PlanDevice;
  current: ExecutableSteppedLoadDevice['current'];
  plannedStepId?: string;
  plannedTransition: ReturnType<typeof resolveSteppedLoadTransition>;
}): ExecutableSteppedLoadDevice['desired'] => {
  const {
    dev,
    current,
    plannedStepId,
    plannedTransition,
  } = params;
  if (shouldHoldCurrentState(dev)) {
    return {
      on: current.on,
      stepId: current.stepId,
      plannedStepId,
    };
  }
  const desiredStepId = resolveDesiredStepId({
    dev,
    current,
    plannedStepId,
    plannedTransition,
  });
  return {
    on: resolveDesiredOn({ dev, current, plannedTransition }),
    stepId: desiredStepId,
    plannedStepId,
  };
};

const resolveDesiredStepId = (params: {
  dev: PlanDevice;
  current: ExecutableSteppedLoadDevice['current'];
  plannedStepId?: string;
  plannedTransition: ReturnType<typeof resolveSteppedLoadTransition>;
}): string | undefined => {
  const {
    dev,
    current,
    plannedStepId,
    plannedTransition,
  } = params;
  const desiredStepId = plannedTransition?.commandStepId ?? plannedStepId;
  if (dev.plannedState !== 'shed' || !desiredStepId || !dev.steppedLoadProfile) return desiredStepId;

  const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, desiredStepId);
  const currentPowerW = current.stepForShed?.planningPowerW ?? 0;
  if (!desiredStep || desiredStep.planningPowerW <= currentPowerW) return desiredStepId;
  return current.stepId;
};

const desiredMatchesTransition = (
  desired: ExecutableSteppedLoadDevice['desired'],
  transition: ReturnType<typeof resolveSteppedLoadTransition>,
): boolean => {
  if (!transition) return false;
  if (desired.stepId !== transition.commandStepId) return false;
  return transition.binaryTarget === null || desired.on === transition.binaryTarget;
};

const resolveDesiredOn = (params: {
  dev: PlanDevice;
  current: ExecutableSteppedLoadDevice['current'];
  plannedTransition: ReturnType<typeof resolveSteppedLoadTransition>;
}): boolean | null => {
  const { dev, current, plannedTransition } = params;
  if (plannedTransition?.binaryTarget !== null && plannedTransition?.binaryTarget !== undefined) {
    return plannedTransition.binaryTarget;
  }
  if (dev.plannedState === 'shed' && current.stepIsOffStep) return false;
  return current.on;
};

const shouldHoldCurrentState = (dev: PlanDevice): boolean => (
  isRestoreAdmissionHoldReason(dev.reason)
  || (dev.plannedState === 'keep' && !allowsSteppedLoadKeepInvariantRestore(dev.reason))
);

const resolveCurrentStepForShed = (
  dev: PlanDevice,
): ExecutableSteppedLoadDevice['current']['stepForShed'] => {
  if (!dev.steppedLoadProfile) return undefined;
  if (!dev.selectedStepId) return resolveMeasuredCurrentStepForShed(dev);
  const currentStep = getSteppedLoadStep(dev.steppedLoadProfile, dev.selectedStepId);
  return currentStep ? {
    stepId: currentStep.id,
    planningPowerW: currentStep.planningPowerW,
  } : undefined;
};

const resolveMeasuredCurrentStepForShed = (
  dev: PlanDevice,
): ExecutableSteppedLoadDevice['current']['stepForShed'] => {
  if (dev.plannedState !== 'shed' || dev.shedAction !== 'set_step') return undefined;
  if (typeof dev.measuredPowerKw !== 'number' || !Number.isFinite(dev.measuredPowerKw) || dev.measuredPowerKw <= 0) {
    return undefined;
  }
  return {
    stepId: 'unknown',
    planningPowerW: Math.round(dev.measuredPowerKw * 1000),
  };
};
