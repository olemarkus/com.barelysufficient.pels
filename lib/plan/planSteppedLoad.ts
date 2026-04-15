import {
  getSteppedLoadHighestStep,
  getSteppedLoadLowestActiveStep,
  getSteppedLoadNextLowerStep,
  getSteppedLoadNextHigherStep,
  getSteppedLoadOffStep,
  getSteppedLoadRestoreStep,
  getSteppedLoadStep,
  getSteppedLoadLowestStep,
  isSteppedLoadOffStep,
  resolveSteppedLoadPlanningPowerKw,
} from '../utils/deviceControlProfiles';
import type { SteppedLoadProfile, SteppedLoadStep } from '../utils/types';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';

type StepCapableDevice = Pick<
  PlanInputDevice | DevicePlanDevice,
  'controlModel' | 'steppedLoadProfile' | 'selectedStepId' | 'desiredStepId' | 'measuredPowerKw'
>;
type StepSheddingCapableDevice = Pick<
  PlanInputDevice,
  | 'controlModel'
  | 'steppedLoadProfile'
  | 'selectedStepId'
  | 'desiredStepId'
  | 'stepCommandPending'
  | 'stepCommandStatus'
>;

export const isSteppedLoadDevice = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'>,
): boolean => (
  device.controlModel === 'stepped_load' && device.steppedLoadProfile?.model === 'stepped_load'
);

const getSteppedLoadProfileForDevice = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'>,
): SteppedLoadProfile | null => (isSteppedLoadDevice(device) ? (device.steppedLoadProfile ?? null) : null);

export const resolveSteppedLoadCurrentState = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId'> & { currentOn: boolean },
): string => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) {
    return device.currentOn ? 'on' : 'off';
  }
  if (device.currentOn === false) return 'off';
  if (!device.selectedStepId) return 'unknown';
  return isSteppedLoadOffStep(profile, device.selectedStepId) ? 'off' : 'on';
};

export const resolveSteppedLoadInitialDesiredStepId = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId'>,
): string | undefined => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return undefined;
  return getSteppedLoadStep(profile, device.selectedStepId)?.id ?? undefined;
};

export const resolveSteppedKeepDesiredStepId = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId' | 'desiredStepId'>
  & { currentState?: string; plannedState?: string },
): string | undefined => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return device.desiredStepId;
  if (device.plannedState !== 'keep') return device.desiredStepId;

  const lowestActiveStepId = getSteppedLoadLowestActiveStep(profile)?.id;
  if (!lowestActiveStepId) return device.desiredStepId;

  if (device.currentState === 'on') {
    return device.desiredStepId && isSteppedLoadOffStep(profile, device.desiredStepId)
      ? lowestActiveStepId
      : device.desiredStepId;
  }

  if (device.currentState === 'off') {
    return lowestActiveStepId;
  }

  const selectedStep = getSteppedLoadStep(profile, device.selectedStepId);
  if (!selectedStep || selectedStep.planningPowerW <= 0) return lowestActiveStepId;
  return selectedStep.id;
};

export const getSteppedLoadNextRestoreStep = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId'> & { currentState?: string },
) => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;

  if (device.currentState === 'off') {
    return getSteppedLoadRestoreStep(profile);
  }

  const highestStepId = getSteppedLoadHighestStep(profile)?.id;
  return getSteppedLoadNextHigherStep({
    profile,
    stepId: device.selectedStepId,
    ceilingStepId: highestStepId,
  });
};

export const getSteppedLoadShedTargetStep = (params: {
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId'> & { currentState?: string };
  shedAction: 'turn_off' | 'set_step';
  currentDesiredStepId?: string;
}): ReturnType<typeof getSteppedLoadStep> => {
  const {
    device,
    shedAction,
    currentDesiredStepId,
  } = params;
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;
  const currentStep = getSteppedLoadStep(profile, currentDesiredStepId ?? device.selectedStepId);
  if (!currentStep) return null;

  const targetStep = shedAction === 'set_step'
    ? getSteppedLoadLowestActiveStep(profile) // set_step = lowest active step (never increases load)
    : getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile);
  if (!targetStep) return null;

  if (device.currentState === 'off') {
    return targetStep;
  }

  const lowestActiveStep = getSteppedLoadLowestActiveStep(profile);
  const nextLowerStep = lowestActiveStep
    ? getSteppedLoadNextLowerStep({
      profile,
      stepId: currentStep.id,
      floorStepId: lowestActiveStep.id,
    })
    : null;
  if (nextLowerStep) return nextLowerStep;

  return currentStep.planningPowerW <= targetStep.planningPowerW ? currentStep : targetStep;
};

export const resolveSteppedLoadSheddingTarget = (params: {
  device: StepSheddingCapableDevice;
  targetStep: SteppedLoadStep | null;
}): {
  steppedProfile: SteppedLoadProfile;
  selectedStep: SteppedLoadStep;
  clampedTargetStep: SteppedLoadStep;
  hasUnconfirmedLowerDesiredStep: boolean;
} | null => {
  const { device, targetStep } = params;
  const steppedProfile = getSteppedLoadProfileForDevice(device);
  if (!steppedProfile) return null;
  const selectedStep = getSteppedLoadStep(steppedProfile, device.selectedStepId);
  if (!selectedStep) return null;
  const desiredStep = resolveUnconfirmedLowerDesiredStep({ device, steppedProfile, selectedStep });
  const clampedTargetStep = clampSteppedShedTarget(targetStep, desiredStep);
  if (!clampedTargetStep || clampedTargetStep.id === selectedStep.id) return null;
  return {
    steppedProfile,
    selectedStep,
    clampedTargetStep,
    hasUnconfirmedLowerDesiredStep: desiredStep !== null,
  };
};

export const resolveSteppedLoadPlanningKw = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'>,
  stepId?: string,
): number => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return 0;
  return resolveSteppedLoadPlanningPowerKw(profile, stepId) ?? 0;
};

export const resolveSteppedLoadImmediateReliefKw = (params: {
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'measuredPowerKw' | 'selectedStepId'>;
  fromStepId?: string;
  toStepId?: string;
}): number => {
  const { device, fromStepId: rawFromStepId, toStepId } = params;
  if (!isSteppedLoadDevice(device)) return 0;

  const effectiveFromStepId = rawFromStepId ?? device.selectedStepId;
  const measured = typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)
    ? Math.max(0, device.measuredPowerKw)
    : 0;
  const fromContribution = Math.min(measured, resolveSteppedLoadPlanningKw(device, effectiveFromStepId));
  const toContribution = Math.min(measured, resolveSteppedLoadPlanningKw(device, toStepId));
  return Math.max(0, fromContribution - toContribution);
};

export const resolveSteppedLoadRestoreDeltaKw = (params: {
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'> & { currentState?: string };
  fromStepId?: string;
  toStepId?: string;
}): number => {
  const { device, fromStepId, toStepId } = params;
  if (!isSteppedLoadDevice(device)) return 0;
  const currentPlanningKw = device.currentState === 'off'
    ? 0
    : resolveSteppedLoadPlanningKw(device, fromStepId);
  const nextPlanningKw = resolveSteppedLoadPlanningKw(device, toStepId);
  return Math.max(0, nextPlanningKw - currentPlanningKw);
};

function resolveUnconfirmedLowerDesiredStep(params: {
  device: StepSheddingCapableDevice;
  steppedProfile: SteppedLoadProfile;
  selectedStep: SteppedLoadStep;
}): SteppedLoadStep | null {
  const { device, steppedProfile, selectedStep } = params;
  const desiredStep = getSteppedLoadStep(steppedProfile, device.desiredStepId);
  if (!desiredStep) return null;
  if (desiredStep.id === selectedStep.id) return null;
  if (desiredStep.planningPowerW >= selectedStep.planningPowerW) return null;
  if (!device.stepCommandPending && device.stepCommandStatus !== 'stale') return null;
  return desiredStep;
}

function clampSteppedShedTarget(
  targetStep: SteppedLoadStep | null,
  desiredStep: SteppedLoadStep | null,
): SteppedLoadStep | null {
  if (!targetStep) return null;
  if (!desiredStep) return targetStep;
  return desiredStep.planningPowerW <= targetStep.planningPowerW ? desiredStep : targetStep;
}

export function resolveSteppedCandidatePower(
  device: StepCapableDevice,
  selectedStep: { id: string; planningPowerW: number },
  targetStep: { id: string; planningPowerW: number },
): number {
  const measured = resolveSteppedLoadImmediateReliefKw({
    device,
    fromStepId: selectedStep.id,
    toStepId: targetStep.id,
  });
  if (measured > 0) return measured;
  const hasMeasuredPower = typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw);
  if (!hasMeasuredPower) {
    return Math.max(0, (selectedStep.planningPowerW - targetStep.planningPowerW) / 1000);
  }
  return measured;
}
