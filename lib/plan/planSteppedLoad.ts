import {
  getSteppedLoadHighestStep,
  getSteppedLoadNextHigherStep,
  getSteppedLoadOffStep,
  getSteppedLoadStep,
  getSteppedLoadLowestStep,
  isSteppedLoadOffStep,
  resolveSteppedLoadPlanningPowerKw,
} from '../utils/deviceControlProfiles';
import type { SteppedLoadProfile } from '../utils/types';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';

type StepCapableDevice = Pick<
  PlanInputDevice | DevicePlanDevice,
  'controlModel' | 'steppedLoadProfile' | 'selectedStepId' | 'desiredStepId' | 'measuredPowerKw'
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
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId'>,
): string | null => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;
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

export const getSteppedLoadNextRestoreStep = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId'>,
) => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;
  const highestStepId = getSteppedLoadHighestStep(profile)?.id;
  return getSteppedLoadNextHigherStep({
    profile,
    stepId: device.selectedStepId,
    ceilingStepId: highestStepId,
  });
};

export const getSteppedLoadShedTargetStep = (params: {
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId'>;
  shedAction: 'turn_off' | 'set_step';
  shedStepId?: string | null;
  currentDesiredStepId?: string;
}): ReturnType<typeof getSteppedLoadStep> => {
  const {
    device,
    shedAction,
    shedStepId,
    currentDesiredStepId,
  } = params;
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;
  const currentStep = getSteppedLoadStep(profile, currentDesiredStepId ?? device.selectedStepId);
  if (!currentStep) return null;

  const targetStep = shedAction === 'set_step'
    ? getSteppedLoadStep(profile, shedStepId ?? undefined)
    : getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile);
  if (!targetStep) return null;

  return currentStep.planningPowerW <= targetStep.planningPowerW ? currentStep : targetStep;
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
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'measuredPowerKw'>;
  fromStepId?: string;
  toStepId?: string;
}): number => {
  const { device, fromStepId, toStepId } = params;
  if (!getSteppedLoadProfileForDevice(device)) return 0;
  const measured = typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)
    ? Math.max(0, device.measuredPowerKw)
    : 0;
  const fromContribution = Math.min(measured, resolveSteppedLoadPlanningKw(device, fromStepId));
  const toContribution = Math.min(measured, resolveSteppedLoadPlanningKw(device, toStepId));
  return Math.max(0, fromContribution - toContribution);
};

export const resolveSteppedLoadRestoreDeltaKw = (params: {
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'>;
  fromStepId?: string;
  toStepId?: string;
}): number => {
  const { device, fromStepId, toStepId } = params;
  if (!isSteppedLoadDevice(device)) return 0;
  const currentPlanningKw = resolveSteppedLoadPlanningKw(device, fromStepId);
  const nextPlanningKw = resolveSteppedLoadPlanningKw(device, toStepId);
  return Math.max(0, nextPlanningKw - currentPlanningKw);
};
