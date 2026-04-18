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
import { resolveEffectiveCurrentOn } from './planCurrentState';
import type { ShedAction } from './planTypes';

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

type StepTransitionCapableDevice = {
  controlModel?: StepCapableDevice['controlModel'];
  steppedLoadProfile?: StepCapableDevice['steppedLoadProfile'];
  selectedStepId?: StepCapableDevice['selectedStepId'];
  desiredStepId?: StepCapableDevice['desiredStepId'];
  assumedStepId?: string;
  currentState?: string;
  currentOn?: boolean;
  controlCapabilityId?: DevicePlanDevice['controlCapabilityId'];
  plannedState?: string;
  shedAction?: ShedAction;
};

export type SteppedLoadEffectiveTransition =
  | 'full_shed_to_off'
  | 'restore_from_off_at_low'
  | 'step_down_while_on'
  | 'step_up_while_on'
  | 'steady';

export type SteppedLoadPreparationPurpose = 'prepare_for_off' | 'prepare_for_on' | null;

export type SteppedLoadTransitionPhase = 'step_preparation' | 'binary_transition' | 'settled';

export type SteppedLoadTransition = {
  effectiveTransition: SteppedLoadEffectiveTransition;
  stepPreparationPurpose: SteppedLoadPreparationPurpose;
  binaryTarget: boolean | null;
  commandStepId: string | undefined;
  plannedDesiredStepId: string | undefined;
  transitionPhase: SteppedLoadTransitionPhase;
};

export const isSteppedLoadDevice = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'>,
): boolean => (
  device.controlModel === 'stepped_load' && device.steppedLoadProfile?.model === 'stepped_load'
);

const getSteppedLoadProfileForDevice = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'>,
): SteppedLoadProfile | null => (isSteppedLoadDevice(device) ? (device.steppedLoadProfile ?? null) : null);

export const resolveSteppedLoadInitialDesiredStepId = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId'>,
): string | undefined => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return undefined;
  return getSteppedLoadStep(profile, device.selectedStepId)?.id ?? undefined;
};

/* eslint-disable complexity, sonarjs/cognitive-complexity */
export const resolveSteppedLoadTransition = (
  device: StepTransitionCapableDevice,
  plannedDesiredStepId = device.desiredStepId,
): SteppedLoadTransition | null => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;

  const currentOn = resolveEffectiveCurrentOn(device);
  const selectedStep = getSteppedLoadStep(profile, device.selectedStepId);
  const desiredStep = getSteppedLoadStep(profile, plannedDesiredStepId);
  const lowestActiveStep = getSteppedLoadLowestActiveStep(profile);
  if (device.plannedState === 'shed' && device.shedAction === 'turn_off') {
    const commandStepId = lowestActiveStep?.id ?? desiredStep?.id ?? plannedDesiredStepId;
    const stepPrepared = commandStepId !== undefined && selectedStep?.id === commandStepId;
    return {
      effectiveTransition: 'full_shed_to_off',
      stepPreparationPurpose: commandStepId ? 'prepare_for_off' : null,
      binaryTarget: false,
      commandStepId,
      plannedDesiredStepId,
      transitionPhase: stepPrepared ? 'binary_transition' : 'step_preparation',
    };
  }

  if (device.plannedState === 'keep' && currentOn === false) {
    const commandStepId = lowestActiveStep?.id ?? desiredStep?.id;
    const stepPrepared = commandStepId !== undefined
      && selectedStep?.id === commandStepId
      && device.assumedStepId !== commandStepId;
    return {
      effectiveTransition: 'restore_from_off_at_low',
      stepPreparationPurpose: commandStepId ? 'prepare_for_on' : null,
      binaryTarget: true,
      commandStepId,
      plannedDesiredStepId,
      transitionPhase: stepPrepared ? 'binary_transition' : 'step_preparation',
    };
  }

  const commandStepId = desiredStep?.id;
  if (!selectedStep || !desiredStep || commandStepId === undefined || commandStepId === selectedStep.id) {
    return {
      effectiveTransition: 'steady',
      stepPreparationPurpose: null,
      binaryTarget: null,
      commandStepId,
      plannedDesiredStepId,
      transitionPhase: 'settled',
    };
  }

  return {
    effectiveTransition: desiredStep.planningPowerW < selectedStep.planningPowerW
      ? 'step_down_while_on'
      : 'step_up_while_on',
    stepPreparationPurpose: null,
    binaryTarget: null,
    commandStepId,
    plannedDesiredStepId,
    transitionPhase: 'settled',
  };
};
/* eslint-enable complexity, sonarjs/cognitive-complexity */

export const resolveSteppedKeepDesiredStepId = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'selectedStepId' | 'desiredStepId'>
  & { currentState?: string; plannedState?: string },
): string | undefined => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return device.desiredStepId;
  if (device.plannedState !== 'keep') return device.desiredStepId;

  const lowestActiveStepId = getSteppedLoadLowestActiveStep(profile)?.id;
  if (!lowestActiveStepId) return device.desiredStepId;

  const effectiveCurrentOn = resolveEffectiveCurrentOn(device);

  if (effectiveCurrentOn === true) {
    return device.desiredStepId && isSteppedLoadOffStep(profile, device.desiredStepId)
      ? lowestActiveStepId
      : device.desiredStepId;
  }

  if (effectiveCurrentOn === false) {
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

  if (resolveEffectiveCurrentOn(device) === false) {
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

  if (resolveEffectiveCurrentOn(device) === false) {
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
  const currentPlanningKw = resolveEffectiveCurrentOn(device) === false
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
