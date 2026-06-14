import {
  getSteppedLoadHighestStep,
  getSteppedLoadLowestActiveStep,
  getSteppedLoadNextLowerStep,
  getSteppedLoadNextHigherStep,
  getSteppedLoadOffStep,
  getSteppedLoadRestoreStep,
  getSteppedLoadStep,
  getSteppedLoadLowestStep,
  isSteppedDeviceAtActiveStep,
  isSteppedDeviceAtOffStep,
  isSteppedLoadOffStep,
  resolveSteppedLoadPlanningPowerKw,
} from '../utils/deviceControlProfiles';
import type {
  BinaryControlCapabilityId,
  SteppedLoadProfile,
  SteppedLoadStep,
} from '../../packages/contracts/src/types';
import { isBinaryPlanDevice } from './planBinaryDevice';
import type {
  DevicePlanDevice,
  PlanInputDevice,
  SteppedDiscriminantProbe,
  SteppedLoadKind,
  SteppedPlanDevice,
  SteppedPlanInputDevice,
} from './planTypes';
import type { ShedAction } from './planTypes';
import {
  isReportedStep,
  normalizeSteppedLoadStepStateFromLegacyFields,
  resolveKnownEffectiveStepId,
} from './planSteppedLoadState';

// The stepped discriminant is the presence of a valid `steppedLoadProfile`
// (`controlModel` is a producer-only setting on the snapshot, not a planner
// field), split across the discriminated-union variants, so it is no longer a
// common key of `PlanInputDevice | DevicePlanDevice` and cannot be `Pick`ed
// from the union. The step helpers below accept the `SteppedDiscriminantProbe`
// "might be stepped" shape (the profile as a plain optional); the
// `isSteppedLoadDevice` guard narrows it to the required shape before any
// profile read.
type StepCapableDevice = SteppedDiscriminantProbe & Pick<
  PlanInputDevice | DevicePlanDevice,
  | 'reportedStepId'
  | 'selectedStepId'
  | 'desiredStepId'
  | 'measuredPowerKw'
  | 'stepPowerCalibration'
>;
type StepIdentityFields = Pick<
StepCapableDevice,
| 'reportedStepId'
| 'selectedStepId'
| 'desiredStepId'
>;
type StepSheddingCapableDevice = SteppedDiscriminantProbe & Pick<
  PlanInputDevice,
  | 'stepCommandPending'
  | 'stepCommandStatus'
> & StepIdentityFields;

type StepTransitionCapableDevice = {
  steppedLoadProfile?: StepCapableDevice['steppedLoadProfile'];
  reportedStepId?: string;
  selectedStepId?: StepCapableDevice['selectedStepId'];
  desiredStepId?: StepCapableDevice['desiredStepId'];
  currentState?: string;
  // Producer-resolved on/off truth (present iff binary). Read directly; for a
  // stepped device this folds the step-off axis, so it equals the old
  // `currentState === 'off'` decision the helpers used.
  currentOn?: boolean;
  binaryControl?: { on: boolean };
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

// Kind type-guard: "stepped load" is a yes/no capability = presence of a valid
// `steppedLoadProfile`. After a positive branch the consumer reads
// `steppedLoadProfile` as required (no `?.` / `!`). The predicate
// (`steppedLoadProfile?.model === 'stepped_load'`) proves exactly that narrowed
// shape, so the guard is sound. Dedicated overloads narrow the two flat plan
// device types to their named `Stepped*` slices; the generic overload preserves
// any other caller's variable type and intersects it with `SteppedLoadKind`.
export function isSteppedLoadDevice(device: DevicePlanDevice): device is SteppedPlanDevice;
export function isSteppedLoadDevice(device: PlanInputDevice): device is SteppedPlanInputDevice;
// Union overload for the dual-read fallback sites that hold a
// `PlanInputDevice | DevicePlanDevice` and cannot resolve one of the singles.
export function isSteppedLoadDevice(
  device: PlanInputDevice | DevicePlanDevice,
): device is SteppedPlanInputDevice | SteppedPlanDevice;
export function isSteppedLoadDevice<T extends SteppedDiscriminantProbe>(
  device: T,
): device is T & SteppedLoadKind;
export function isSteppedLoadDevice(
  device: SteppedDiscriminantProbe | PlanInputDevice | DevicePlanDevice,
): boolean {
  // `steppedLoadProfile` is only typed on the stepped variant of each device
  // union; widen to the probe shape to read it un-narrowed (the runtime field
  // is simply absent on the non-stepped variants, so `?.` is sound).
  return (device as SteppedDiscriminantProbe).steppedLoadProfile?.model === 'stepped_load';
}

type ObservedOnOffDevice = {
  controlCapabilityId?: BinaryControlCapabilityId;
  currentOn?: boolean;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
};

/**
 * Kind-aware "is this device observed off?" — the faithful successor of the
 * retired `isObservedOff`. On/off is a binary question for a binary device (read
 * the resolved `currentOn`, which already folds the stepped-off step for a
 * binary+stepped device) and a STEP question for a step-only stepper (no binary
 * handle, so no `currentOn`): parked at the off step ⇒ off. A device with neither
 * a binary handle nor a step (or at an unknown step) is not off.
 */
export const isPlanDeviceObservedOff = (device: ObservedOnOffDevice): boolean => (
  isBinaryPlanDevice(device)
    ? !device.currentOn
    : isSteppedDeviceAtOffStep(device)
);

/**
 * Kind-aware "is this device observed on?" — successor of the retired
 * `isObservedOn`. Binary devices read `currentOn === true`; a step-only stepper
 * is on iff parked at an active (non-off) step. Mirrors {@link isPlanDeviceObservedOff}:
 * an unknown/invalid step is neither off nor on.
 */
export const isPlanDeviceObservedOn = (device: ObservedOnOffDevice): boolean => (
  isBinaryPlanDevice(device)
    ? device.currentOn === true
    : isSteppedDeviceAtActiveStep(device)
);

const getSteppedLoadProfileForDevice = (
  device: SteppedDiscriminantProbe | PlanInputDevice | DevicePlanDevice,
): SteppedLoadProfile | null => {
  // All three input shapes carry `steppedLoadProfile` only on their stepped
  // variant; treat the value as the probe shape for the guard + read.
  const probe = device as SteppedDiscriminantProbe;
  return isSteppedLoadDevice(probe) ? (probe.steppedLoadProfile ?? null) : null;
};

export const resolveSteppedLoadInitialDesiredStepId = (
  device: Pick<StepCapableDevice, 'steppedLoadProfile'> & StepIdentityFields,
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

  if (device.plannedState === 'keep' && device.currentOn === false) {
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
  device: Pick<StepCapableDevice, 'steppedLoadProfile'> & StepIdentityFields & {
    controlCapabilityId?: BinaryControlCapabilityId;
    currentState?: string;
    currentOn?: boolean;
    plannedState?: string;
  },
  options: { anyOtherDeviceLimited?: boolean } = {},
): string | undefined => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return device.desiredStepId;
  if (device.plannedState !== 'keep') return device.desiredStepId;

  const lowestActiveStep = getSteppedLoadLowestActiveStep(profile);
  const lowestActiveStepId = lowestActiveStep?.id;
  if (!lowestActiveStepId || !lowestActiveStep) return device.desiredStepId;

  // On/off is kind-aware: a binary stepper reads `currentOn`, a step-only stepper
  // the step axis. A strict `currentOn === true/false` would skip BOTH branches
  // for a step-only device (no `currentOn`) and fall through to the reported-step
  // path below, abandoning an in-flight step-down toward `desiredStepId`.
  if (isPlanDeviceObservedOn(device)) {
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

  if (isPlanDeviceObservedOff(device)) {
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
  device: Pick<StepCapableDevice, 'steppedLoadProfile'> & StepIdentityFields
  & { currentState?: string; currentOn?: boolean },
) => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;

  // `currentOn === false` is a shortcut to the restore step; a step-only stepper
  // (no `currentOn`) skips it and falls to the next-higher path below. That stays
  // correct ONLY while the off step is the lowest step in the profile, so "next
  // higher from off" == the restore step (lowest active). A profile with extra
  // zero-power sub-steps below the first active step would break the equivalence.
  if (device.currentOn === false) {
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
  device: Pick<StepCapableDevice, 'steppedLoadProfile'> & StepIdentityFields
  & { currentState?: string; currentOn?: boolean };
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

  if (device.currentOn === false) {
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
  // Accepts a "might be stepped" probe OR a concrete plan device union; the
  // concrete arms avoid the weak-type "no overlapping property" error that a
  // bare `SteppedDiscriminantProbe` (single optional) would trigger for a
  // non-weak `PlanInputDevice` argument.
  device: SteppedDiscriminantProbe | PlanInputDevice | DevicePlanDevice,
  stepId?: string,
): number => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return 0;
  return resolveSteppedLoadPlanningPowerKw(profile, stepId) ?? 0;
};

type ImmediateReliefDevice =
  & Pick<
    StepCapableDevice,
    'steppedLoadProfile' | 'measuredPowerKw' | 'stepPowerCalibration'
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
    'steppedLoadProfile' | 'measuredPowerKw' | 'stepPowerCalibration'
  >
  & { currentState?: string; currentOn?: boolean };

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
  if (device.currentOn === false) return 0;
  if (measured !== null && measured > 0) return Math.min(measured, deliveryFromKw);
  return deliveryFromKw;
}

// Per the "resolution belongs in producer" rule, the producer
// (`appInit.buildStepPowerCalibrationView`) has already bound each
// calibrated value to samples inside the configured step's power band. The
// plan layer trusts the view; helpers here only fall back to nameplate when
// no view entry is present.
function resolveStepAdmissionKw(
  device: Pick<StepCapableDevice, 'steppedLoadProfile' | 'stepPowerCalibration'>,
  stepId: string | undefined,
): number {
  if (stepId === undefined) return resolveSteppedLoadPlanningKw(device, stepId);
  const calibrated = device.stepPowerCalibration?.[stepId]?.admissionPowerKw;
  if (typeof calibrated === 'number' && Number.isFinite(calibrated)) return calibrated;
  return resolveSteppedLoadPlanningKw(device, stepId);
}

function resolveStepDeliveryKw(
  device: Pick<StepCapableDevice, 'steppedLoadProfile' | 'stepPowerCalibration'>,
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
  device: SteppedDiscriminantProbe & Pick<PlanInputDevice, 'measuredPowerKw'> & StepIdentityFields;
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
