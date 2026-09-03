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
 * `resolveObservedCurrentState` produces the SEPARATE `currentState` label for
 * reason/UI rendering only — it must never be consulted as the on/off truth. It
 * is THREE-valued: `on` / `off` / `not_applicable`. It never emits 'unknown' at
 * all — not from staleness (a stale binary read resolves to its latched on/off),
 * and not from the STRUCTURAL stepped "step not known" case either, because its
 * own guard drops that value and falls through to the binary arms. The only
 * resolver here that returns 'unknown' is
 * `resolveObservedSteppedLoadCurrentState`, and only for that structural case.
 */
import { getSteppedLoadStep, isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

export type ObservedCurrentStateInput = {
  // Present iff binary control; absence is the old fabricated `currentOn: true`.
  binaryControl?: { on: boolean };
  // No `controlModel`: every resolver below asks the stepped question
  // structurally, through `isSteppedLoadSnapshot`. The producer-only setting was
  // carried here unread.
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
};

/**
 * The same observation plus the precomputed `currentState` label that a
 * `DevicePlanDevice` already carries. Only `resolveObservedCurrentStateValue`
 * (and its plan-layer callers) reads that cache; every other resolver here takes
 * the bare observation. No `Partial<>` wrapper — every field of the base is
 * already optional, so wrapping it said nothing.
 */
export type CurrentStateInput = ObservedCurrentStateInput & {
  currentState?: string;
};

// Deliberately narrower than `ObservedCurrentStateInput`: the off-step question
// is answered on the stepped axis alone. Withholding `binaryControl` keeps this
// BODY from reading it, so a defaulted binary bit cannot mask the step state
// here — the hazard `resolveObservedSteppedLoadCurrentState` guards in prose.
// It constrains the body only; the sole caller passes its whole device, which
// structural typing accepts silently.
function stepIsAtOff(
  device: Pick<ObservedCurrentStateInput, 'steppedLoadProfile' | 'selectedStepId'>,
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
  device: ObservedCurrentStateInput,
): boolean {
  const binaryOff = device.binaryControl?.on === false;
  const steppedOff = isSteppedLoadSnapshot(device) && stepIsAtOff(device);
  return !(binaryOff || steppedOff);
}

/**
 * String projection of the resolved observed state. Used by reason rendering
 * and as a precomputed cache on `DevicePlanDevice`. The boolean helpers do not
 * rely on this projection — they recompute from primitives — so the two stay
 * in sync by construction.
 */
export function resolveObservedSteppedLoadCurrentState(
  device: ObservedCurrentStateInput,
): string {
  const profile = isSteppedLoadSnapshot(device) ? device.steppedLoadProfile : null;
  if (!profile) {
    return (device.binaryControl?.on ?? true) ? 'on' : 'off';
  }
  // Only short-circuit on binary off when the device actually has a binary
  // capability — a defaulted `currentOn: false` on a step-only device must not
  // mask the step state.
  if (device.binaryControl?.on === false) return 'off';
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
  return resolveObservedCurrentState(device);
}

export function resolveObservedCurrentState(
  device: ObservedCurrentStateInput,
): string {
  // The producer resolves the CONCRETE latched label — it never emits 'unknown'
  // from staleness (the plan has no right to distrust observer data, and a stale
  // binary read is still the latched bit: Homey reports capabilities on change).
  // It never emits 'unknown' at all: this function is THREE-valued
  // (`on` / `off` / `not_applicable`). The stepped resolver's STRUCTURAL "step
  // not known" 'unknown' is dropped by the guard below and falls through to the
  // binary arms, so it never leaves this function.
  if (isSteppedLoadSnapshot(device)) {
    const steppedState = resolveObservedSteppedLoadCurrentState(device);
    if (steppedState !== 'unknown') return steppedState;
  }
  if (device.binaryControl === undefined) {
    return 'not_applicable';
  }
  return (device.binaryControl?.on ?? true) ? 'on' : 'off';
}

// `isObservedOff` / `isObservedOn` are retired. The on/off question is a
// binary-only concern: consumers narrow via `isBinaryPlanDevice` and read the
// producer-resolved `currentOn` boolean directly (see `resolveCurrentOn`). No
// kind-agnostic wrapper remains, so binary and non-binary handling stay in
// separate, specialised branches.
