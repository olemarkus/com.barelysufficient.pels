/**
 * Producer-seam home for `residualKw.shed` resolution (chunk 3 of the
 * planner-detype refactor) and `residualKw.restore` resolution (chunk 4).
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
 * "Residual kW for restore" = the kW the consumer would add by restoring this
 * device. This collapses the `isSteppedLoadDevice + getSteppedLoadRestoreStep`
 * chain in `lib/plan/restore/accounting.ts`'s `resolveRestorePower` into a
 * single `{ kw, source }` pair on `PlanInputDevice.residualKw.restore`. The
 * preserved load-bearing asymmetry: stepped devices that are observed-on with
 * a positive `planningPowerKw` use the live planning kW (source `'planning'`);
 * stepped devices that are off or have no planning kW fall back to the
 * lowest-active step from the profile (source `'stepped'`); everything else
 * (including non-stepped) uses the highest-known observed power, defaulting to
 * EV / generic fallback (source `'fallback'`). The producer module does NOT
 * implement the observed-power highest-of math itself (that lives in
 * `lib/observer/observedPower.getRestoreDrawKw`); the wiring layer in
 * `setup/appInit/residualKwForPlanDevice.ts` calls the observer helper and
 * funnels the pre-resolved `{ kw, source }` in via `restoreFallback`.
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
 * is funnelled in via `hasKnownEffectiveStep`. For restore, the observer-
 * resolved `currentState !== 'off'` decision and the `getRestoreDrawKw`
 * fallback are likewise pre-resolved by the wiring layer.
 *
 * Pure helpers: no side effects, no value dependencies on `lib/plan/**` or
 * `lib/observer/**`.
 */
import type {
  RestorePowerSource,
  SteppedLoadProfile,
  SteppedLoadStep,
} from '../../packages/contracts/src/types';
import { isFiniteNumber } from '../utils/appTypeGuards';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadLowestStep,
  getSteppedLoadNextLowerStep,
  getSteppedLoadOffStep,
  getSteppedLoadRestoreStep,
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
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
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
    || steppedLoad.controlCapabilityId === undefined
    || !steppedLoad.selectedStepId
    || targetStep?.id !== steppedLoad.selectedStepId
  ) {
    return false;
  }
  const selectedStep = getSteppedLoadStep(steppedLoad.profile, steppedLoad.selectedStepId);
  return Boolean(selectedStep && !isSteppedLoadOffStep(steppedLoad.profile, selectedStep.id));
}

export type ResidualKwRestoreSteppedDevice = {
  profile: SteppedLoadProfile;
  /**
   * True when the device is observed as actively on (not at the off step,
   * not stale-off). Mirrors `dev.currentState !== 'off'` in the legacy
   * `resolveSteppedRestorePower` chain. Pre-resolved by the wiring layer
   * so the producer can stay free of `lib/observer/**`.
   */
  currentStateIsOff: boolean;
  /**
   * The device's live planning power in kW. Used as the restore draw for a
   * stepped device that is currently active (legacy `'planning'` source).
   * Unused when the device is observed-off or this value is <= 0.
   */
  planningPowerKw?: number;
};

export type ResidualKwRestoreDeviceInput = {
  steppedLoad?: ResidualKwRestoreSteppedDevice;
  /**
   * Pre-resolved binary/fallback restore draw from
   * `lib/observer/observedPower.getRestoreDrawKw`. Funnelled in from the
   * wiring layer so the producer module doesn't depend on the observer.
   * Used:
   *   - directly for non-stepped devices, and
   *   - as the fallback when a stepped device has no usable planning kW and
   *     no usable lowest-active step.
   */
  restoreFallback: { kw: number; source: RestorePowerSource };
};

/**
 * Resolve the residual kW the consumer would add by restoring this device.
 *
 * The legacy `resolveRestorePower` chain in
 * `lib/plan/restore/accounting.ts` had three resolution paths:
 *   1. Stepped device, observed-on with positive `planningPowerKw` →
 *      `{ kw: planningPowerKw, source: 'planning' }`.
 *   2. Stepped device, off (or no positive planning kW), with a non-zero
 *      lowest-active / restore step in the profile →
 *      `{ kw: restoreStep.planningPowerW / 1000, source: 'stepped' }`.
 *   3. Anything else (non-stepped, OR stepped without a usable step) →
 *      `getRestoreDrawKw(dev)` (highest of measured/expected/planning/
 *      configured, defaulting to EV / generic fallback).
 *
 * This producer preserves all three paths byte-for-byte. Paths 1+2 are owned
 * here; path 3 is delegated to the observer via the pre-resolved
 * `restoreFallback` funnelled in by the wiring adapter. The asymmetry that
 * stepped path 1 uses live `planningPowerKw` and path 2 uses the lowest-
 * active-step profile value is preserved because callers see a single
 * resolved `{ kw, source }` per device; debug-log call sites that read the
 * source label (`restore_admitted` / `restore_rejected` / etc.) keep their
 * existing six-value source vocabulary (`'measured' | 'expected' |
 * 'planning' | 'configured' | 'stepped' | 'fallback'`).
 */
export function resolveResidualKwRestore(
  input: ResidualKwRestoreDeviceInput,
): { kw: number; source: RestorePowerSource } {
  const stepped = resolveSteppedResidualKwRestore(input.steppedLoad);
  if (stepped !== null) return stepped;
  return input.restoreFallback;
}

function resolveSteppedResidualKwRestore(
  steppedLoad: ResidualKwRestoreSteppedDevice | undefined,
): { kw: number; source: RestorePowerSource } | null {
  if (!steppedLoad) return null;

  // Path 1: stepped device that is observed-on with a positive planning kW.
  // Mirrors the legacy `dev.currentState !== 'off' && planningPowerKw > 0`
  // branch — uses the live planning kW directly.
  if (
    !steppedLoad.currentStateIsOff
    && isFiniteNumber(steppedLoad.planningPowerKw)
    && steppedLoad.planningPowerKw > 0
  ) {
    return { kw: steppedLoad.planningPowerKw, source: 'planning' };
  }

  // Path 2: stepped device that is off (or has no positive planning kW),
  // with a non-zero lowest-active / restore step in the profile. Reuses the
  // pure step-shape helper directly; the legacy guard that requires the
  // resolved step's `planningPowerW > 0` is preserved here. A profile whose
  // restore step is at zero (or missing) falls through to the binary/
  // fallback path below.
  const restoreStep = getSteppedLoadRestoreStep(steppedLoad.profile);
  if (restoreStep && restoreStep.planningPowerW > 0) {
    return { kw: restoreStep.planningPowerW / 1000, source: 'stepped' };
  }

  return null;
}
