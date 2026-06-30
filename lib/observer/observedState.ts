/**
 * Observer-owned observed-state resolution.
 *
 * The on/off truth is a single strict boolean, `currentOn`, resolved by
 * `resolveCurrentOn` and stamped on the binary plan kinds by the producer.
 * Consumers narrow via `isBinaryPlanDevice` and read `currentOn` directly — the
 * on/off question is meaningful ONLY for binary devices, so there is no
 * kind-agnostic wrapper (the retired `isObservedOff`/`isObservedOn`).
 *
 *  - **binary / binary+stepped device:** `currentOn` is the resolved on-state —
 *    confirmed-off when the binary axis reads off OR the stepped axis is parked
 *    at its off step; otherwise on. A stale observation keeps its last value
 *    (no staleness gate; Homey reports on change, so stale-off stays off).
 *  - **non-binary (target-only) device:** carries no `currentOn`; the planner
 *    makes no binary intent for it and routes through the target/temperature
 *    paths.
 *
 * `resolveObservedCurrentState` produces the SEPARATE four-valued `currentState`
 * label (`on`/`off`/`unknown`/`not_applicable`) for reason/UI rendering only —
 * it must never be consulted as the on/off truth. The producer never emits
 * 'unknown' from staleness — that label is reserved for the STRUCTURAL stepped
 * "step not known" case; a stale binary read resolves to its latched on/off.
 */
import { getSteppedLoadStep, isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import type {
  BinaryControlCapabilityId,
  DeviceControlModel,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';

export type ObservedCurrentStateInput = {
  // Present iff binary control; absence is the old fabricated `currentOn: true`.
  binaryControl?: { on: boolean };
  controlCapabilityId?: BinaryControlCapabilityId;
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
};

export type CurrentStateInput = Partial<ObservedCurrentStateInput> & {
  currentState?: string;
};

type StepCurrentStateInput = Pick<
  ObservedCurrentStateInput,
  'steppedLoadProfile' | 'selectedStepId' | 'controlCapabilityId'
> & { binaryControl?: { on: boolean } };

const hasBinaryCapability = (device: Pick<CurrentStateInput, 'controlCapabilityId'>): boolean => (
  device.controlCapabilityId !== undefined
);

// "Stepped load" is a yes/no capability = presence of a valid
// `steppedLoadProfile`; `controlModel` is a producer-only setting carried on the
// snapshot and is no longer part of the discriminant.
const hasSteppedCapability = (
  device: Pick<CurrentStateInput, 'steppedLoadProfile'>,
): boolean => (
  device.steppedLoadProfile?.model === 'stepped_load'
);

function stepIsAtOff(
  device: Pick<CurrentStateInput, 'steppedLoadProfile' | 'selectedStepId'>,
): boolean {
  if (!device.steppedLoadProfile || !device.selectedStepId) return false;
  const step = getSteppedLoadStep(device.steppedLoadProfile, device.selectedStepId);
  if (!step) return false;
  return isSteppedLoadOffStep(device.steppedLoadProfile, step.id);
}

/**
 * Producer resolution of a binary device's strict-boolean on-state — the single
 * public on/off truth, carried as `currentOn` on the binary plan kinds
 * (`BinaryPlanInputKind` / `BinaryControlKind`).
 *
 * A binary device (one with binary control) is NEVER "unknown": its on-state is
 * the latched observed value the transport already resolved to a concrete
 * boolean. Confirmed-off when the binary axis reads off OR the stepped axis is
 * parked at its off step; otherwise on ("may draw, stays sheddable"). There is
 * no staleness gate — a stale observation keeps its last value (Homey reports
 * capabilities only on change, so stale-off stays off).
 *
 * The four-valued `currentState` string (`resolveObservedCurrentState`) is a
 * SEPARATE producer concern for reason/UI rendering; it carries 'unknown' /
 * 'not_applicable' for labelling and MUST NOT be consulted as the on/off truth.
 *
 * Precondition: the device has binary control. Non-binary devices have no on/off
 * truth and never carry `currentOn` — consumers narrow through `isBinaryPlanDevice`
 * first and read `currentOn` directly in that specialised branch.
 */
export function resolveCurrentOn(
  device: Pick<ObservedCurrentStateInput, 'binaryControl' | 'steppedLoadProfile' | 'selectedStepId'>,
): boolean {
  const binaryOff = device.binaryControl?.on === false;
  const steppedOff = hasSteppedCapability(device) && stepIsAtOff(device);
  return !(binaryOff || steppedOff);
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
    return (device.binaryControl?.on ?? true) ? 'on' : 'off';
  }
  // Only short-circuit on binary off when the device actually has a binary
  // capability — a defaulted `currentOn: false` on a step-only device must not
  // mask the step state.
  if (hasBinaryCapability(device) && device.binaryControl?.on === false) return 'off';
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
  // Every real device formerly carried a concrete `currentOn` boolean (a
  // non-binary device defaulted to the fabricated `true`), so this always
  // resolved through `resolveObservedCurrentState`. With `binaryControl` absent
  // for non-binary devices, the fabricated default is applied inside the helper.
  return resolveObservedCurrentState(device as ObservedCurrentStateInput);
}

export function resolveObservedCurrentState(
  device: ObservedCurrentStateInput,
): string {
  // The producer resolves the CONCRETE latched label — it never emits 'unknown'
  // from staleness (the plan has no right to distrust observer data, and a stale
  // binary read is still the latched bit: Homey reports capabilities on change).
  // The only 'unknown' here is the STRUCTURAL stepped "step not known" case below
  // (`resolveObservedSteppedLoadCurrentState` with no selectedStepId).
  if (hasSteppedCapability(device) && device.steppedLoadProfile) {
    const steppedState = resolveObservedSteppedLoadCurrentState({
      steppedLoadProfile: device.steppedLoadProfile,
      selectedStepId: device.selectedStepId,
      binaryControl: device.binaryControl,
      controlCapabilityId: device.controlCapabilityId,
    });
    if (steppedState !== 'unknown') return steppedState;
  }
  if (!hasBinaryCapability(device)) {
    return 'not_applicable';
  }
  return (device.binaryControl?.on ?? true) ? 'on' : 'off';
}

// `isObservedOff` / `isObservedOn` are retired. The on/off question is a
// binary-only concern: consumers narrow via `isBinaryPlanDevice` and read the
// producer-resolved `currentOn` boolean directly (see `resolveCurrentOn`). No
// kind-agnostic wrapper remains, so binary and non-binary handling stay in
// separate, specialised branches.
