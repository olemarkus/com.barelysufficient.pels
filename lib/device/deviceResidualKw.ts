/**
 * Producer-seam home for `residualKw.shed` resolution (chunk 3 of the
 * planner-detype refactor).
 *
 * "Residual kW for shed" = the observable kW that the configured shed behavior
 * would remove if applied right now. This collapses the
 * `RemainingSheddableDevice` discriminated-union kind switch
 * (`'simple' | 'temperature' | 'stepped' | 'stepped_temperature'`) into a
 * single number on `PlanInputDevice.residualKw.shed`, computed at the producer
 * seam. Consumers in `lib/plan/planRemainingSheddableLoad.ts` keep their flat
 * plan-cycle gates (`controllable`, `isObservedOff`, `alreadyShed`,
 * daily-budget-without-cap-breach) and otherwise read this number directly.
 *
 * Layering note: this helper deliberately does NOT consult observed-off state.
 * The `isObservedOff(device) => 0` gate in `planRemainingSheddableLoad.ts` runs
 * before the consumer reads `residualKw.shed`, so the producer can stay free
 * of the `lib/observer/**` dependency (which would violate the
 * `no-device-to-peer-except-power` rule). Likewise the producer must not
 * depend on `lib/plan/**`, so the stepped-load logic is implemented here
 * using only the pure step-shape helpers in
 * `lib/utils/deviceControlProfiles.ts`. Caller-side step-state pre-resolution
 * (e.g. `resolveKnownEffectiveStepId` in `lib/plan/planSteppedLoadState.ts`)
 * is funnelled in via `hasKnownEffectiveStep`.
 *
 * Pure helpers: no side effects, no value dependencies on `lib/plan/**` or
 * `lib/observer/**`.
 */
import type {
  SteppedLoadProfile,
  SteppedLoadStep,
} from '../../packages/contracts/src/types';
import { isFiniteNumber } from '../utils/appTypeGuards';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadLowestStep,
  getSteppedLoadNextLowerStep,
  getSteppedLoadOffStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import { normalizeTargetCapabilityValue } from '../utils/targetCapabilities';

export type ResidualKwShedBehavior =
  | { action: 'turn_off' }
  | { action: 'set_step' }
  | { action: 'set_temperature'; temperature: number };

export type ResidualKwShedTemperatureTarget = {
  currentValue?: number;
  min?: number;
  max?: number;
  step?: number;
};

export type ResidualKwShedSteppedDevice = {
  profile: SteppedLoadProfile;
  selectedStepId?: string;
  /**
   * True when the caller resolved a known effective step ID for this device
   * via `resolveKnownEffectiveStepId` (any of reported / selected / actual /
   * assumed). Mirrors the guard inside
   * `resolveSteppedUnknownCurrentMeasuredShedding`: the unknown-current-
   * measured fallback only fires when no step state is known at all.
   */
  hasKnownEffectiveStep: boolean;
  measuredPowerKw?: number;
  hasBinaryControl?: boolean;
};

export type ResidualKwShedDeviceInput = {
  currentDrawKw: number;
  /**
   * Present when the device exposes a primary temperature target capability;
   * undefined for non-temperature devices. The producer compares
   * `currentValue` against the normalised shed target to decide whether the
   * `set_temperature` shed would actually move the setpoint.
   */
  temperatureTarget?: ResidualKwShedTemperatureTarget;
  /**
   * Present when the device is a stepped-load device; undefined for
   * non-stepped devices. Used by both `set_step` and `turn_off` shed actions
   * to decide whether the configured shed step is reachable from the current
   * step.
   */
  steppedLoad?: ResidualKwShedSteppedDevice;
};

/**
 * Resolve the residual kW saved by shedding this device right now.
 *
 * Returns 0 when the configured shed action would not actually move the
 * device — e.g. a `set_temperature` shed at a setpoint the device is already
 * at, or a stepped `turn_off` for a device already at its off step.
 *
 * Callers ARE responsible for the consumer-side flat gates (controllable,
 * observed-off, already-shed, daily-budget exemption) — those live in
 * `lib/plan/planRemainingSheddableLoad.ts` and run before this number is
 * read.
 */
export function resolveResidualKwShed(params: {
  device: ResidualKwShedDeviceInput;
  shedBehavior: ResidualKwShedBehavior;
}): number {
  const { device, shedBehavior } = params;
  if (!canStillShedResidual(device, shedBehavior)) return 0;
  const drawKw = device.currentDrawKw;
  if (!isFiniteNumber(drawKw) || drawKw <= 0) return 0;
  return drawKw;
}

function canStillShedResidual(
  device: ResidualKwShedDeviceInput,
  shedBehavior: ResidualKwShedBehavior,
): boolean {
  if (shedBehavior.action === 'set_temperature') {
    return canStillShedTemperature(device.temperatureTarget, shedBehavior.temperature);
  }
  if (!device.steppedLoad) return true;
  return canStillShedSteppedResidual({
    steppedLoad: device.steppedLoad,
    shedAction: shedBehavior.action === 'set_step' ? 'set_step' : 'turn_off',
  });
}

function canStillShedTemperature(
  target: ResidualKwShedTemperatureTarget | undefined,
  shedTemperature: number,
): boolean {
  if (!target) return false;
  if (!isFiniteNumber(target.currentValue)) return true;
  const normalizedShedTemperature = normalizeTargetCapabilityValue({
    target,
    value: shedTemperature,
  });
  return target.currentValue !== normalizedShedTemperature;
}

function canStillShedSteppedResidual(params: {
  steppedLoad: ResidualKwShedSteppedDevice;
  shedAction: 'turn_off' | 'set_step';
}): boolean {
  const { steppedLoad, shedAction } = params;
  if (!steppedLoad.selectedStepId) {
    return canShedFromUnknownCurrentStep(steppedLoad, shedAction);
  }
  const targetStep = resolveSteppedShedTargetStepResidual({
    profile: steppedLoad.profile,
    currentStepId: steppedLoad.selectedStepId,
    shedAction,
  });
  if (targetStep && targetStep.id !== steppedLoad.selectedStepId) return true;
  return canFinishSteppedTurnOffWithBinaryResidual({
    steppedLoad,
    shedAction,
    targetStep,
  });
}

function canShedFromUnknownCurrentStep(
  steppedLoad: ResidualKwShedSteppedDevice,
  shedAction: 'turn_off' | 'set_step',
): boolean {
  // Mirrors `resolveSteppedUnknownCurrentMeasuredShedding` in
  // `lib/plan/planSteppedLoad.ts`: when no step state is known at all and
  // the device is drawing measurable power, treat the shed as reachable iff
  // the configured target step exists and would not be at-or-above the
  // current draw (set_step) / would actually turn off (turn_off).
  if (steppedLoad.hasKnownEffectiveStep) return false;
  const measuredPowerKw = isFiniteNumber(steppedLoad.measuredPowerKw)
    ? Math.max(0, steppedLoad.measuredPowerKw)
    : 0;
  if (measuredPowerKw <= 0) return false;
  const targetStep = shedAction === 'set_step'
    ? getSteppedLoadLowestActiveStep(steppedLoad.profile)
    : getSteppedLoadOffStep(steppedLoad.profile) ?? getSteppedLoadLowestStep(steppedLoad.profile);
  if (!targetStep) return false;
  const targetPlanningKw = targetStep.planningPowerW / 1000;
  const effectivePowerKw = shedAction === 'set_step'
    ? Math.max(0, measuredPowerKw - targetPlanningKw)
    : measuredPowerKw;
  return effectivePowerKw > 0;
}

/**
 * Structural counterpart of `getSteppedLoadShedTargetStep` in
 * `lib/plan/planSteppedLoad.ts`, minus the `isObservedOff(device)` branch.
 * The observed-off case is covered by the consumer-side flat gate in
 * `planRemainingSheddableLoad.ts`, so this producer-side resolver can stay
 * free of the `lib/observer/**` dependency.
 */
function resolveSteppedShedTargetStepResidual(params: {
  profile: SteppedLoadProfile;
  currentStepId: string;
  shedAction: 'turn_off' | 'set_step';
}): SteppedLoadStep | null {
  const { profile, currentStepId, shedAction } = params;
  const currentStep = getSteppedLoadStep(profile, currentStepId);
  if (!currentStep) return null;
  const targetStep = shedAction === 'set_step'
    ? getSteppedLoadLowestActiveStep(profile)
    : getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile);
  if (!targetStep) return null;
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
}

function canFinishSteppedTurnOffWithBinaryResidual(params: {
  steppedLoad: ResidualKwShedSteppedDevice;
  shedAction: 'turn_off' | 'set_step';
  targetStep: SteppedLoadStep | null;
}): boolean {
  const { steppedLoad, shedAction, targetStep } = params;
  if (
    shedAction !== 'turn_off'
    || steppedLoad.hasBinaryControl === false
    || !steppedLoad.selectedStepId
    || targetStep?.id !== steppedLoad.selectedStepId
  ) {
    return false;
  }
  const selectedStep = getSteppedLoadStep(steppedLoad.profile, steppedLoad.selectedStepId);
  return Boolean(selectedStep && !isSteppedLoadOffStep(steppedLoad.profile, selectedStep.id));
}
