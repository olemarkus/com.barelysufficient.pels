import { isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import type { DevicePlan } from '../plan/planTypes';
import {
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadTransition,
} from '../plan/planSteppedLoad';
import { resolveSteppedRestoreAttemptState } from '../plan/planSteppedRestorePending';
import { resolveEffectiveCurrentOn } from '../plan/planCurrentState';
import {
  allowsSteppedLoadKeepInvariantRestore,
  isRestoreAdmissionHoldReason,
} from '../planContract/planDecisionSemantics';
import {
  resolveSteppedStepActuationState,
  type ExecutableSteppedStepState,
} from './steppedLoadActuation';
import type {
  ExecutableObservedDeviceState,
  ExecutableObservedSteppedLoadState,
  ExecutableSteppedLoadCurrentFallback,
  ExecutableSteppedLoadCurrentState,
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
} from './executablePlan';
import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';

type PlanDevice = DevicePlan['devices'][number];

export function buildExecutableSteppedLoadIntent(dev: PlanDevice): ExecutableSteppedLoadIntent | null {
  if (!isSteppedLoadDevice(dev)) return null;
  if (shouldHoldCurrentState(dev)) return null;
  const planningCurrent = {
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
    current: planningCurrent,
    plannedStepId,
    plannedTransition,
  });
  if (isUnderspecifiedSetStepShedIntent(dev, desired)) return null;
  const transition = desiredMatchesTransition(desired, plannedTransition) ? plannedTransition : null;
  const matchingRestoreAttempt = desired.stepId !== undefined
    ? resolveSteppedRestoreAttemptState(dev, desired.stepId)
    : null;
  const matchingCommandAttempt = desired.stepId !== undefined
    ? resolveSteppedRestoreAttemptState(dev, desired.stepId)
    : null;
  return {
    id: dev.id,
    name: dev.name,
    purpose: dev.plannedState === 'shed' ? 'shed' : 'keep',
    steppedLoadProfile: dev.steppedLoadProfile,
    communicationModel: dev.communicationModel,
    controlAdapter: dev.controlAdapter,
    shedAction: dev.shedAction,
    desired,
    previousStepId: dev.selectedStepId ?? dev.lastDesiredStepId,
    transition,
    matchingRestoreAttempt,
    matchingCommandAttempt,
    stepCommandRetryCount: dev.stepCommandRetryCount ?? 0,
    nextStepCommandRetryAtMs: dev.nextStepCommandRetryAtMs,
  };
}

/**
 * Producer-resolved current fallback from the plan device. Used by the
 * device-projection only when the device has no observation this cycle; the
 * resolution (effective on + effective step) lives here, in the producer layer,
 * so the executor never re-derives a planning fallback.
 */
export function resolveSteppedLoadCurrentFallback(
  dev: PlanDevice,
): ExecutableSteppedLoadCurrentFallback | undefined {
  if (!isSteppedLoadDevice(dev)) return undefined;
  return {
    on: resolveEffectiveCurrentOn(dev),
    stepId: dev.selectedStepId,
  };
}

export function buildExecutableSteppedLoadDevice(
  intent: ExecutableSteppedLoadIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
  currentFallback?: ExecutableSteppedLoadCurrentFallback,
): ExecutableSteppedLoadDevice | null {
  if (!intent) return null;
  const current = buildCurrentState(intent, observed, currentFallback);
  const stepActuation = resolveSteppedStepActuationState({
    step: toExecutableSteppedStepState(observed?.steppedLoad, intent.desired.stepId),
  });
  const commandStepActuation = resolveSteppedStepActuationState({
    step: toExecutableSteppedStepState(observed?.steppedLoad, intent.desired.stepId),
  });
  const desiredIsNonOff = intent.desired.stepId
    && !isSteppedLoadOffStep(intent.steppedLoadProfile, intent.desired.stepId);
  return {
    ...intent,
    current,
    previousStepId: current.stepId ?? intent.previousStepId,
    stepActuation,
    commandStepActuation,
    stepNeedsAdjustment: Boolean(desiredIsNonOff && stepActuation.materialization.kind !== 'materialized'),
  };
}

const buildCurrentState = (
  intent: ExecutableSteppedLoadIntent,
  observedDevice: ExecutableObservedDeviceState | undefined,
  currentFallback: ExecutableSteppedLoadCurrentFallback | undefined,
): ExecutableSteppedLoadCurrentState => {
  const observed = observedDevice?.steppedLoad;
  // Current state is producer-resolved: from the observation when present, else
  // from the plan-device fallback the observed-state producer supplies for a
  // device absent from this cycle's snapshot. The intent carries desired-only
  // state and never contributes current state here.
  const stepId = observed?.stepId ?? currentFallback?.stepId;
  return {
    on: observed?.on
      ?? (observedDevice ? isBinaryOnOrUnknown(observedDevice) : (currentFallback?.on ?? null)),
    stepId,
    stepForShed: resolveObservedStepForShed(intent, observed, stepId),
    stepIsOffStep: stepId
      ? isSteppedLoadOffStep(intent.steppedLoadProfile, stepId)
      : false,
  };
};

const toExecutableSteppedStepState = (
  observed: ExecutableObservedSteppedLoadState | null | undefined,
  requestedStepId?: string,
): ExecutableSteppedStepState => {
  const observedStepId = observed?.reportedStepId;
  // The effective `stepId` is the planning fallback only when there is no
  // reported step; when a report exists `stepId` mirrors it and is not a
  // separate fallback.
  const fallbackStepId = observedStepId ? undefined : observed?.stepId;
  return {
    requestedStepId,
    observedStep: observedStepId ? { kind: 'reported', stepId: observedStepId } : { kind: 'unknown' },
    fallbackStepId,
  };
};

const isUnderspecifiedSetStepShedIntent = (
  dev: PlanDevice,
  desired: ExecutableSteppedLoadDevice['desired'],
): boolean => (
  dev.plannedState === 'shed'
  && dev.shedAction === 'set_step'
  && desired.stepId === undefined
);

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
  if (dev.plannedState !== 'shed' || !desiredStepId || !isSteppedLoadDevice(dev)) return desiredStepId;

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
  Boolean(dev.reason && isRestoreAdmissionHoldReason(dev.reason))
  || Boolean(dev.reason && dev.plannedState === 'keep' && !allowsSteppedLoadKeepInvariantRestore(dev.reason))
);

const resolveCurrentStepForShed = (
  dev: PlanDevice,
): ExecutableSteppedLoadDevice['current']['stepForShed'] => {
  if (!isSteppedLoadDevice(dev)) return undefined;
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

const resolveObservedStepForShed = (
  intent: ExecutableSteppedLoadIntent,
  observed: ExecutableObservedSteppedLoadState | null | undefined,
  stepId: string | undefined,
): ExecutableSteppedLoadCurrentState['stepForShed'] => {
  if (stepId) {
    const currentStep = getSteppedLoadStep(intent.steppedLoadProfile, stepId);
    return currentStep ? {
      stepId: currentStep.id,
      planningPowerW: currentStep.planningPowerW,
    } : undefined;
  }
  if (intent.shedAction !== 'set_step') return undefined;
  if (
    typeof observed?.measuredPowerKw !== 'number'
    || !Number.isFinite(observed.measuredPowerKw)
    || observed.measuredPowerKw <= 0
  ) {
    return undefined;
  }
  return {
    stepId: 'unknown',
    planningPowerW: Math.round(observed.measuredPowerKw * 1000),
  };
};
