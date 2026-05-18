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
import { isObservedOff, isObservedOn } from '../observer/observedState';
import type { ShedAction } from './planTypes';
import {
  isReportedStep,
  normalizeSteppedLoadStepStateFromLegacyFields,
  resolveKnownEffectiveStepId,
} from './planSteppedLoadState';

type StepCapableDevice = Pick<
  PlanInputDevice | DevicePlanDevice,
  | 'controlModel'
  | 'steppedLoadProfile'
  | 'reportedStepId'
  | 'selectedStepId'
  | 'desiredStepId'
  | 'actualStepId'
  | 'assumedStepId'
  | 'actualStepSource'
  | 'measuredPowerKw'
  | 'stepPowerCalibration'
>;
type StepIdentityFields = Pick<
StepCapableDevice,
| 'reportedStepId'
| 'selectedStepId'
| 'desiredStepId'
| 'actualStepId'
| 'assumedStepId'
| 'actualStepSource'
>;
type StepSheddingCapableDevice = Pick<
  PlanInputDevice,
  | 'controlModel'
  | 'steppedLoadProfile'
  | 'stepCommandPending'
  | 'stepCommandStatus'
> & StepIdentityFields;

type StepTransitionCapableDevice = {
  controlModel?: StepCapableDevice['controlModel'];
  steppedLoadProfile?: StepCapableDevice['steppedLoadProfile'];
  reportedStepId?: string;
  selectedStepId?: StepCapableDevice['selectedStepId'];
  desiredStepId?: StepCapableDevice['desiredStepId'];
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: StepCapableDevice['actualStepSource'];
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
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'> & StepIdentityFields,
): string | undefined => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return undefined;
  return getSteppedLoadStep(profile, resolvePlannerEffectiveStepId(device))?.id ?? undefined;
};

/* eslint-disable complexity, sonarjs/cognitive-complexity */
export const resolveSteppedLoadTransition = (
  device: StepTransitionCapableDevice,
  plannedDesiredStepId = device.desiredStepId,
): SteppedLoadTransition | null => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;

  const stepState = normalizePlannerStepState(device);
  const selectedStep = getSteppedLoadStep(profile, resolveKnownEffectiveStepId(stepState));
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

  if (device.plannedState === 'keep' && isObservedOff(device)) {
    const commandStepId = lowestActiveStep?.id ?? desiredStep?.id;
    const stepPrepared = commandStepId !== undefined
      && selectedStep?.id === commandStepId
      && isReportedStep(stepState, commandStepId);
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
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'> & StepIdentityFields
  & { currentState?: string; plannedState?: string },
  options: { anyOtherDeviceLimited?: boolean } = {},
): string | undefined => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return device.desiredStepId;
  if (device.plannedState !== 'keep') return device.desiredStepId;

  const lowestActiveStep = getSteppedLoadLowestActiveStep(profile);
  const lowestActiveStepId = lowestActiveStep?.id;
  if (!lowestActiveStepId || !lowestActiveStep) return device.desiredStepId;

  if (isObservedOn(device)) {
    const baseStepId = device.desiredStepId && isSteppedLoadOffStep(profile, device.desiredStepId)
      ? lowestActiveStepId
      : device.desiredStepId;
    return clampToLowestActiveWhenOtherDevicesLimited({
      profile,
      stepId: baseStepId,
      lowestActiveStep,
      anyOtherDeviceLimited: options.anyOtherDeviceLimited === true,
    });
  }

  if (isObservedOff(device)) {
    return lowestActiveStepId;
  }

  const selectedStep = getSteppedLoadStep(profile, resolvePlannerEffectiveStepId(device));
  if (!selectedStep || selectedStep.planningPowerW <= 0) return lowestActiveStepId;
  return clampToLowestActiveWhenOtherDevicesLimited({
    profile,
    stepId: selectedStep.id,
    lowestActiveStep,
    anyOtherDeviceLimited: options.anyOtherDeviceLimited === true,
  });
};

// docs/technical.md:222 — "While any other managed device is still limited, stepped devices
// are capped at their lowest non-zero step." Symmetric to applyKeepInvariantShedBlock on the
// restore path: if a stepped device is currently above lowest-non-zero and any other device
// is being limited this cycle, clamp the keep desired step down so the executor issues a
// step-down command (e.g. medium -> low) instead of holding the higher step.
const clampToLowestActiveWhenOtherDevicesLimited = (params: {
  profile: SteppedLoadProfile;
  stepId: string | undefined;
  lowestActiveStep: SteppedLoadStep;
  anyOtherDeviceLimited: boolean;
}): string | undefined => {
  const { profile, stepId, lowestActiveStep, anyOtherDeviceLimited } = params;
  if (!anyOtherDeviceLimited || !stepId) return stepId;
  if (stepId === lowestActiveStep.id) return stepId;
  const step = getSteppedLoadStep(profile, stepId);
  if (!step || step.planningPowerW <= lowestActiveStep.planningPowerW) return stepId;
  return lowestActiveStep.id;
};

export const getSteppedLoadNextRestoreStep = (
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'> & StepIdentityFields
  & { currentState?: string },
) => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;

  if (isObservedOff(device)) {
    return getSteppedLoadRestoreStep(profile);
  }

  const highestStepId = getSteppedLoadHighestStep(profile)?.id;
  return getSteppedLoadNextHigherStep({
    profile,
    stepId: resolvePlannerEffectiveStepId(device),
    ceilingStepId: highestStepId,
  });
};

export const getSteppedLoadShedTargetStep = (params: {
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile'> & StepIdentityFields
  & { currentState?: string };
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
  const currentStep = getSteppedLoadStep(profile, currentDesiredStepId ?? resolvePlannerEffectiveStepId(device));
  if (!currentStep) return null;

  const targetStep = shedAction === 'set_step'
    ? getSteppedLoadLowestActiveStep(profile) // set_step = lowest active step (never increases load)
    : getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile);
  if (!targetStep) return null;

  if (isObservedOff(device)) {
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
  const selectedStep = getSteppedLoadStep(steppedProfile, resolvePlannerEffectiveStepId(device));
  if (!selectedStep) return null;
  const desiredStep = resolveUnconfirmedLowerDesiredStep({ device, steppedProfile, selectedStep });
  const staleLowerDesiredStep = hasStaleLowerDesiredStep({ device, steppedProfile, selectedStep });
  const clampedTargetStep = clampSteppedShedTarget(targetStep, desiredStep);
  if (!clampedTargetStep || clampedTargetStep.id === selectedStep.id) return null;
  return {
    steppedProfile,
    selectedStep,
    clampedTargetStep,
    hasUnconfirmedLowerDesiredStep: desiredStep !== null || staleLowerDesiredStep,
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

type ImmediateReliefDevice =
  & Pick<
    StepCapableDevice,
    'controlModel' | 'steppedLoadProfile' | 'measuredPowerKw' | 'stepPowerCalibration'
  >
  & StepIdentityFields;

export const resolveSteppedLoadImmediateReliefKw = (params: {
  device: ImmediateReliefDevice;
  fromStepId?: string;
  toStepId?: string;
}): number => {
  const { device, fromStepId: rawFromStepId, toStepId } = params;
  if (!isSteppedLoadDevice(device)) return 0;

  const effectiveFromStepId = rawFromStepId ?? resolvePlannerEffectiveStepId(device);
  const measured = typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)
    ? Math.max(0, device.measuredPowerKw)
    : 0;
  const fromConservativeKw = resolveStepDeliveryKw(device, effectiveFromStepId);
  const toConservativeKw = resolveStepAdmissionKw(device, toStepId);
  // Cap by measured so the relief estimate cannot exceed what the meter is
  // actually carrying right now; cap by calibrated delivery so transient
  // spikes do not over-state the steady-state benefit of the step-down.
  const fromContribution = Math.min(measured, fromConservativeKw);
  const toContribution = Math.min(measured, toConservativeKw);
  return Math.max(0, fromContribution - toContribution);
};

type RestoreDeltaDevice =
  & Pick<
    StepCapableDevice,
    'controlModel' | 'steppedLoadProfile' | 'measuredPowerKw' | 'stepPowerCalibration'
  >
  & { currentState?: string };

export const resolveSteppedLoadRestoreDeltaKw = (params: {
  device: RestoreDeltaDevice;
  fromStepId?: string;
  toStepId?: string;
}): number => {
  const { device, fromStepId, toStepId } = params;
  if (!isSteppedLoadDevice(device)) return 0;
  // From-side: observed-off ⇒ 0; otherwise use the conservative-low delivery
  // estimate for the current step so the restore delta does not under-count
  // the new commitment when the device is briefly drawing more than its
  // calibrated baseline.
  const measured = typeof device.measuredPowerKw === 'number'
    && Number.isFinite(device.measuredPowerKw)
    ? Math.max(0, device.measuredPowerKw)
    : null;
  const deliveryFromKw = resolveStepDeliveryKw(device, fromStepId);
  const currentDrawKw = resolveRestoreFromContribution({
    device,
    measured,
    deliveryFromKw,
  });
  const nextKw = resolveStepAdmissionKw(device, toStepId);
  return Math.max(0, nextKw - currentDrawKw);
};

function resolveRestoreFromContribution(params: {
  device: RestoreDeltaDevice;
  measured: number | null;
  deliveryFromKw: number;
}): number {
  // Only override with measured when it is *positive* — a zero or missing
  // reading is not evidence that the device is currently idle at this step
  // (it may be mid-cycle, throttled, or reporting stale data). In those
  // cases the calibrated delivery / nameplate estimate is the safer proxy
  // for "what this device contributes right now."
  const { device, measured, deliveryFromKw } = params;
  if (isObservedOff(device)) return 0;
  if (measured !== null && measured > 0) return Math.min(measured, deliveryFromKw);
  return deliveryFromKw;
}

// Per the "resolution belongs in producer" rule, the producer
// (`appInit.buildStepPowerCalibrationView`) has already bound each
// calibrated value to samples inside the configured step's power band. The
// plan layer trusts the view; helpers here only fall back to nameplate when
// no view entry is present.
function resolveStepAdmissionKw(
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'stepPowerCalibration'>,
  stepId: string | undefined,
): number {
  if (stepId === undefined) return resolveSteppedLoadPlanningKw(device, stepId);
  const calibrated = device.stepPowerCalibration?.[stepId]?.admissionPowerKw;
  if (typeof calibrated === 'number' && Number.isFinite(calibrated)) return calibrated;
  return resolveSteppedLoadPlanningKw(device, stepId);
}

function resolveStepDeliveryKw(
  device: Pick<StepCapableDevice, 'controlModel' | 'steppedLoadProfile' | 'stepPowerCalibration'>,
  stepId: string | undefined,
): number {
  if (stepId === undefined) return resolveSteppedLoadPlanningKw(device, stepId);
  const calibrated = device.stepPowerCalibration?.[stepId]?.deliveryPowerKw;
  if (typeof calibrated === 'number' && Number.isFinite(calibrated)) return calibrated;
  return resolveSteppedLoadPlanningKw(device, stepId);
}

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
  if (!device.stepCommandPending) return null;
  return desiredStep;
}

function hasStaleLowerDesiredStep(params: {
  device: StepSheddingCapableDevice;
  steppedProfile: SteppedLoadProfile;
  selectedStep: SteppedLoadStep;
}): boolean {
  const { device, steppedProfile, selectedStep } = params;
  if (device.stepCommandPending || device.stepCommandStatus !== 'stale') return false;
  const desiredStep = getSteppedLoadStep(steppedProfile, device.desiredStepId);
  if (!desiredStep) return false;
  if (desiredStep.id === selectedStep.id) return false;
  return desiredStep.planningPowerW < selectedStep.planningPowerW;
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
    // Fall back to calibrated delta when available, else nameplate delta —
    // both bound by zero so a calibrated "to" estimate that exceeds the
    // calibrated "from" estimate yields zero relief rather than a negative
    // contribution.
    const fromKw = resolveStepDeliveryKw(device, selectedStep.id);
    const toKw = resolveStepAdmissionKw(device, targetStep.id);
    const fallbackDelta = Math.max(0, fromKw - toKw);
    if (fallbackDelta > 0) return fallbackDelta;
    return Math.max(0, (selectedStep.planningPowerW - targetStep.planningPowerW) / 1000);
  }
  return measured;
}

export const resolveSteppedUnknownCurrentMeasuredShedding = (params: {
  device: Pick<PlanInputDevice, 'controlModel' | 'steppedLoadProfile' | 'measuredPowerKw'> & StepIdentityFields;
  shedAction: 'turn_off' | 'set_step';
}): {
  targetStep: SteppedLoadStep;
  effectivePowerKw: number;
} | null => {
  const { device, shedAction } = params;
  if (!isSteppedLoadDevice(device) || resolvePlannerEffectiveStepId(device)) return null;
  const steppedProfile = getSteppedLoadProfileForDevice(device);
  if (!steppedProfile) return null;
  const measuredPowerKw = typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)
    ? Math.max(0, device.measuredPowerKw)
    : 0;
  if (measuredPowerKw <= 0) return null;

  const targetStep = shedAction === 'set_step'
    ? getSteppedLoadLowestActiveStep(steppedProfile)
    : (getSteppedLoadOffStep(steppedProfile) ?? getSteppedLoadLowestStep(steppedProfile));
  if (!targetStep) return null;

  const targetPlanningKw = targetStep.planningPowerW / 1000;
  const effectivePowerKw = shedAction === 'set_step'
    ? Math.max(0, measuredPowerKw - targetPlanningKw)
    : measuredPowerKw;
  if (effectivePowerKw <= 0) return null;

  return {
    targetStep,
    effectivePowerKw,
  };
};

function normalizePlannerStepState(device: StepIdentityFields) {
  return normalizeSteppedLoadStepStateFromLegacyFields({
    fields: device,
    selectedStepFallbackIsPlanningAssumption: true,
  });
}

function resolvePlannerEffectiveStepId(device: Parameters<typeof normalizePlannerStepState>[0]): string | undefined {
  return resolveKnownEffectiveStepId(normalizePlannerStepState(device));
}
