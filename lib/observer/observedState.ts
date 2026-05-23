/**
 * Observer-owned observed-state resolution. Plan-facing consumers read two
 * flat booleans — `isObservedOff` and `isObservedOn` — derived per capability:
 *
 *  - **binary-only device:** the answer is the binary on/off.
 *  - **step-only device:** the answer is whether the selected step draws power.
 *  - **binary + step device:** the AND of the two — confirmed on means binary
 *    on AND step at an active (non-off) step; confirmed off means binary off
 *    OR step at the off step.
 *  - **no capability (target-only / not_applicable):** neither helper returns
 *    true. The planner does not make binary intent for such devices.
 *
 * Stale observations collapse to "neither confirmed off nor confirmed on" so
 * downstream planning conservatively treats the device as on (mirrors the
 * stale-off rule from slice 2's `getCurrentDrawKw`).
 */
import { getSteppedLoadStep, isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import type { DeviceControlModel, SteppedLoadProfile } from '../../packages/contracts/src/types';

export type ObservedCurrentStateInput = {
  currentOn: boolean;
  hasBinaryControl?: boolean;
  observationStale?: boolean;
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
};

export type CurrentStateInput = Partial<ObservedCurrentStateInput> & {
  currentState?: string;
};

type StepCurrentStateInput = Pick<
  ObservedCurrentStateInput,
  'controlModel' | 'steppedLoadProfile' | 'selectedStepId' | 'hasBinaryControl'
> & { currentOn: boolean };

const hasBinaryCapability = (device: Pick<CurrentStateInput, 'hasBinaryControl'>): boolean => (
  device.hasBinaryControl !== false
);

const hasSteppedCapability = (
  device: Pick<CurrentStateInput, 'controlModel' | 'steppedLoadProfile'>,
): boolean => (
  device.controlModel === 'stepped_load' && device.steppedLoadProfile?.model === 'stepped_load'
);

function stepIsAtOff(
  device: Pick<CurrentStateInput, 'steppedLoadProfile' | 'selectedStepId'>,
): boolean {
  if (!device.steppedLoadProfile || !device.selectedStepId) return false;
  const step = getSteppedLoadStep(device.steppedLoadProfile, device.selectedStepId);
  if (!step) return false;
  return isSteppedLoadOffStep(device.steppedLoadProfile, step.id);
}

function stepIsAtActive(
  device: Pick<CurrentStateInput, 'steppedLoadProfile' | 'selectedStepId'>,
): boolean {
  if (!device.steppedLoadProfile || !device.selectedStepId) return false;
  const step = getSteppedLoadStep(device.steppedLoadProfile, device.selectedStepId);
  if (!step) return false;
  return !isSteppedLoadOffStep(device.steppedLoadProfile, step.id);
}

/**
 * String projection of the resolved observed state. Used by reason rendering
 * and as a precomputed cache on `DevicePlanDevice`. The boolean helpers do not
 * rely on this projection — they recompute from primitives — so the two stay
 * in sync by construction.
 */
export function resolveObservedSteppedLoadCurrentState(
  device: StepCurrentStateInput,
): string {
  const profile = hasSteppedCapability(device) ? device.steppedLoadProfile ?? null : null;
  if (!profile) {
    return device.currentOn ? 'on' : 'off';
  }
  // Only short-circuit on binary off when the device actually has a binary
  // capability — a defaulted `currentOn: false` on a step-only device must not
  // mask the step state.
  if (hasBinaryCapability(device) && device.currentOn === false) return 'off';
  if (!device.selectedStepId) return 'unknown';
  const selectedStep = getSteppedLoadStep(profile, device.selectedStepId);
  if (!selectedStep) return 'unknown';
  return isSteppedLoadOffStep(profile, selectedStep.id) ? 'off' : 'on';
}

/**
 * Lookup helper: prefer a precomputed `currentState` string when present (the
 * common case for `DevicePlanDevice` consumers, which carry the projection
 * already), else compute from the underlying observation inputs.
 */
export function resolveObservedCurrentStateValue(device: CurrentStateInput): string {
  if (typeof device.currentState === 'string') return device.currentState;
  if (typeof device.currentOn === 'boolean') {
    return resolveObservedCurrentState(device as ObservedCurrentStateInput);
  }
  return 'unknown';
}

export function resolveObservedCurrentState(
  device: ObservedCurrentStateInput,
): string {
  if (device.observationStale === true) {
    return hasBinaryCapability(device) ? 'unknown' : 'not_applicable';
  }
  if (hasSteppedCapability(device) && device.steppedLoadProfile) {
    const steppedState = resolveObservedSteppedLoadCurrentState({
      controlModel: 'stepped_load',
      steppedLoadProfile: device.steppedLoadProfile,
      selectedStepId: device.selectedStepId,
      currentOn: device.currentOn,
      hasBinaryControl: device.hasBinaryControl,
    });
    if (steppedState !== 'unknown') return steppedState;
  }
  if (!hasBinaryCapability(device)) {
    return 'not_applicable';
  }
  return device.currentOn ? 'on' : 'off';
}

/**
 * True iff observation confirms the device is currently off via any of its
 * controllable capabilities. Stale observations return false (planner
 * conservatively treats them as not-confirmed-off). Devices with no
 * controllable capability return false — the planner makes no binary intent
 * for them and routes shed/restore through the target/temperature paths.
 */
export function isObservedOff(device: CurrentStateInput): boolean {
  if (device.observationStale === true) return false;

  // Trust a precomputed `currentState` string when present — DevicePlanDevice
  // consumers carry the projection from `resolveObservedCurrentState` and rely
  // on it as the canonical answer. The projection is computed from the same
  // per-capability rules used below.
  if (typeof device.currentState === 'string') {
    return device.currentState === 'off';
  }

  const binary = hasBinaryCapability(device);
  const stepped = hasSteppedCapability(device);
  if (!binary && !stepped) return false;

  if (binary && device.currentOn === false) return true;
  if (stepped && stepIsAtOff(device)) return true;
  return false;
}

/**
 * True iff observation confirms the device is currently on via every
 * controllable capability the device exposes. Stale observations return false.
 * Devices with no controllable capability return false.
 */
export function isObservedOn(device: CurrentStateInput): boolean {
  if (device.observationStale === true) return false;

  if (typeof device.currentState === 'string') {
    return device.currentState === 'on';
  }

  const binary = hasBinaryCapability(device);
  const stepped = hasSteppedCapability(device);
  if (!binary && !stepped) return false;

  if (binary && device.currentOn !== true) return false;
  if (stepped && !stepIsAtActive(device)) return false;
  return true;
}
