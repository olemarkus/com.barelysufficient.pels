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
  sortSteppedLoadSteps,
} from '../utils/deviceControlProfiles';
import type {
  SteppedLoadProfile,
  SteppedLoadStep,
} from '../../packages/contracts/src/types';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { isBinaryPlanDevice } from './planBinaryDevice';
import type {
  DevicePlanDevice,
  PlanInputDevice,
  PlannedShedTargetKind,
  SteppedDiscriminantProbe,
  SteppedLoadKind,
  SteppedPlanDevice,
  SteppedPlanInputDevice,
} from './planTypes';
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
// `selectedStepId` arrives via the probe (it moved onto the stepped cluster,
// so it is no longer a common key of the unions and cannot be `Pick`ed).
type StepCapableDevice = SteppedDiscriminantProbe & Pick<
  PlanInputDevice | DevicePlanDevice,
  | 'reportedStepId'
  | 'desiredStepId'
  | 'currentDrawKw'
  | 'stepPowerCalibration'
>;
type StepIdentityFields = Pick<StepCapableDevice, 'reportedStepId' | 'selectedStepId' | 'desiredStepId'>;
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
  plannedState?: string;
  /**
   * This cycle's decided shed END STATE (`resolvePlannedShedTargetKind`), NOT
   * the configured shed behaviour. The two are not interchangeable here: a
   * `turn_off` behaviour is only the floor, so a device it covers may still be
   * decided at an intermediate rung, and entering the full-shed branch on the
   * behaviour would command a binary off the plan did not decide.
   */
  plannedShedTargetKind?: PlannedShedTargetKind;
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

// Kind type-guard: "stepped load" is a yes/no capability = presence of a
// `steppedLoadProfile`. After a positive branch the consumer reads
// `steppedLoadProfile` and `planningPowerKw` as required (no `?.` / `!`). The
// predicate proves exactly that narrowed shape, so the guard is sound. Dedicated
// overloads narrow the two flat plan device types to their named `Stepped*`
// slices; the generic overload preserves any other caller's variable type and
// intersects it with `SteppedLoadKind`.
//
// The runtime predicate is delegated to the browser-safe `isSteppedLoadSnapshot`
// so there is exactly one definition of "is this a stepped load" — this module
// owns only the plan-layer narrowing, the way `isTemperaturePlanDevice` owns
// its own.
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
  // is simply absent on the non-stepped variants, so the probe read is sound).
  //
  // What the shared predicate asks is PRESENCE, nothing more — this is a type
  // guard, not a validator. Whether the ladder is USABLE stays the producer's
  // question, already answered there; do not re-ask it here. The argument for
  // that lives with the one definition, on `isSteppedLoadSnapshot`.
  return isSteppedLoadSnapshot(device as SteppedDiscriminantProbe);
}

type ObservedOnOffDevice = {
  // Present so the all-optional shape shares a property with every plan-device
  // union member (TS weak-type check); not read by the predicate itself.
  id?: string;
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
  // variant; treat the value as the probe shape for the guard + read. The guard
  // proves the profile, so the read is plain.
  const probe = device as SteppedDiscriminantProbe;
  return isSteppedLoadDevice(probe) ? probe.steppedLoadProfile : null;
};

export const resolveSteppedLoadInitialDesiredStepId = (
  device: Pick<StepCapableDevice, 'steppedLoadProfile'> & StepIdentityFields,
): string | undefined => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return undefined;
  return getSteppedLoadStep(profile, resolvePlannerEffectiveStepId(device))?.id ?? undefined;
};

/* eslint-disable complexity, sonarjs/cognitive-complexity --
   stepped-load transition decision table: mutually-exclusive shed/restore/step
   cases read clearer as one top-to-bottom table than split across helpers. */
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
  // The decided end state, not the policy: only a shed the planner decided
  // ends at the device's off step runs the two-phase step-prep-then-binary-off.
  // A `turn_off` device parked at an intermediate rung falls through to
  // `step_down_while_on`, which leaves the binary axis undemanded.
  if (device.plannedState === 'shed' && device.plannedShedTargetKind === 'binary_off') {
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
    currentState?: string;
    currentOn?: boolean;
    plannedState?: string;
  },
  options: {
    anyOtherDeviceLimited?: boolean;
    boostActive?: boolean;
    /**
     * The rung this cycle's surplus allocation bought a surplus-TRACKING device
     * (`PlanEngineState.surplusTrackingByDevice`), resolved by the producer
     * and passed flat. A CEILING, never a target: it can only lower the answer
     * this function would otherwise give, so capacity shedding stays the ceiling
     * above it and the ordinary keep logic still owns everything below.
     */
    surplusCeilingStepId?: string;
  } = {},
): string | undefined => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return device.desiredStepId;
  if (device.plannedState !== 'keep') return device.desiredStepId;

  const lowestActiveStep = getSteppedLoadLowestActiveStep(profile);
  if (!lowestActiveStep) return device.desiredStepId;
  const lowestActiveStepId = lowestActiveStep.id;

  // On/off is kind-aware: a binary stepper reads `currentOn`, a step-only stepper
  // the step axis. A strict `currentOn === true/false` would skip BOTH branches
  // for a step-only device (no `currentOn`) and fall through to the reported-step
  // path below, abandoning an in-flight step-down toward `desiredStepId`.
  if (isPlanDeviceObservedOn(device)) {
    const baseStepId = device.desiredStepId && isSteppedLoadOffStep(profile, device.desiredStepId)
      ? lowestActiveStepId
      : device.desiredStepId;
    // Boost bypasses the surplus ceiling deliberately, exactly as it bypasses
    // the lowest-active fairness clamp: a boost is a live demand the owner (or a
    // smart task) asked for, and "use only your own sun" must not outrank it.
    if (options.boostActive) {
      return resolveHigherSteppedLoadStepId({
        profile,
        firstStepId: baseStepId,
        secondStepId: resolvePlannerEffectiveStepId(device),
      }) ?? lowestActiveStepId;
    }
    return clampToSurplusCeiling(profile, clampToLowestActiveWhenOtherDevicesLimited({
      profile,
      stepId: baseStepId,
      lowestActiveStep,
      anyOtherDeviceLimited: options.anyOtherDeviceLimited === true,
    }), options.surplusCeilingStepId);
  }

  if (isPlanDeviceObservedOff(device)) {
    return clampToSurplusCeiling(profile, lowestActiveStepId, options.surplusCeilingStepId);
  }

  const selectedStep = getSteppedLoadStep(profile, resolvePlannerEffectiveStepId(device));
  if (!selectedStep || selectedStep.planningPowerW <= 0) {
    return clampToSurplusCeiling(profile, lowestActiveStepId, options.surplusCeilingStepId);
  }
  return clampToSurplusCeiling(profile, clampToLowestActiveWhenOtherDevicesLimited({
    profile,
    stepId: selectedStep.id,
    lowestActiveStep,
    anyOtherDeviceLimited: options.anyOtherDeviceLimited === true,
  }), options.surplusCeilingStepId);
};

/**
 * Lower `stepId` to the surplus allocation's rung when it sits above it. Never
 * raises: a device already below its allocation stays where it is, so the
 * ceiling can only ever cost the device power, never hand it any. That
 * one-directionality is what keeps this an admission term rather than an
 * actuation decision (`lib/plan/shedding/AGENTS.md` — "express it as an
 * admission term instead").
 */
const clampToSurplusCeiling = (
  profile: SteppedLoadProfile,
  stepId: string | undefined,
  surplusCeilingStepId: string | undefined,
): string | undefined => {
  if (surplusCeilingStepId === undefined || stepId === undefined) return stepId;
  if (stepId === surplusCeilingStepId) return stepId;
  const ceilingStep = getSteppedLoadStep(profile, surplusCeilingStepId);
  const step = getSteppedLoadStep(profile, stepId);
  if (!ceilingStep || !step) return stepId;
  return step.planningPowerW > ceilingStep.planningPowerW ? ceilingStep.id : stepId;
};

const resolveHigherSteppedLoadStepId = (params: {
  profile: SteppedLoadProfile;
  firstStepId: string | undefined;
  secondStepId: string | undefined;
}): string | undefined => {
  const { profile, firstStepId, secondStepId } = params;
  const firstStep = getSteppedLoadStep(profile, firstStepId);
  const secondStep = getSteppedLoadStep(profile, secondStepId);
  if (!firstStep) return secondStep?.id;
  if (!secondStep) return firstStep.id;
  return secondStep.planningPowerW > firstStep.planningPowerW ? secondStep.id : firstStep.id;
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

/**
 * The highest ACTIVE rung whose calibrated power fits inside
 * `budgetKw`, or `null` when even the ladder floor does not fit. Off steps are
 * never answered — "no rung fits" is the caller's decision to make, and for the
 * surplus allocator it is exactly the question the floor policy settles.
 *
 * Calibrated power, not nameplate: `resolveStepPowerKw` prefers the
 * calibrated draw the device actually pulls at that rung and falls back to the
 * profile's planning watts only where the calibration view has no entry. A
 * ladder is not monotonic in calibrated terms — a mis-sampled rung can price
 * above the one above it — so this walks every rung rather than binary-searching
 * from the top, and answers the highest FITTING one rather than the one below
 * the first miss.
 */
export const resolveHighestStepWithinKw = (
  device: Pick<StepCapableDevice, 'steppedLoadProfile' | 'stepPowerCalibration'>,
  budgetKw: number,
): SteppedLoadStep | null => {
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return null;
  if (!Number.isFinite(budgetKw)) return null;
  let best: SteppedLoadStep | null = null;
  for (const step of sortSteppedLoadSteps(profile.steps)) {
    if (isSteppedLoadOffStep(profile, step.id)) continue;
    if (step.planningPowerW <= 0) continue;
    if (resolveStepPowerKw(device, step.id) > budgetKw) continue;
    if (best === null || step.planningPowerW > best.planningPowerW) best = step;
  }
  return best;
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

type StepChangeDevice =
  & Pick<
    StepCapableDevice,
    'steppedLoadProfile' | 'currentDrawKw' | 'stepPowerCalibration'
  >
  & StepIdentityFields
  & { currentOn?: boolean };

/**
 * What a from -> to step change is expected to alter, in kW. Non-negative in
 * both directions: `down` is relief the change releases, `up` is the draw it
 * commits to. The sign lives in `direction` so no caller has to remember which
 * way a bare number pointed.
 */
export type StepChange =
  | { direction: 'none'; deltaKw: 0 }
  | { direction: 'down' | 'up'; deltaKw: number };

const NO_STEP_CHANGE: StepChange = { direction: 'none', deltaKw: 0 };

/**
 * THE step-change price. Shedding asks it what a descent releases, restore asks
 * it what a climb commits, and there is nothing else to ask: one delta, one set
 * of rules, one place where the meter and the step model are reconciled.
 *
 * Two sources can answer "what is this device drawing now": the meter
 * (`currentDrawKw`) and the model (this device's calibrated or nameplate power
 * for the step it reports being on). Only the model can answer the after-side,
 * since the meter has not seen that rung yet. The direction of the change
 * decides which one owns the before-side, because the two directions have
 * opposite pessimism:
 *
 * - Going DOWN we are counting on watts to go away, and **the meter is the
 *   bound**: a device cannot release more than it is drawing. Clamping the
 *   before-side to the model as well under-credits a descent whenever the step
 *   report is the stale half — a 3.645 kW charger reporting `6a` (1.38 kW
 *   nameplate) had a full turn-off priced at 1.38 kW, so the selection loop went
 *   on shedding devices the owner ranked higher against 2.27 kW of deficit that
 *   was already freed.
 * - Going UP we are counting on room to add watts, so the before-side takes the
 *   SMALLER of the two: over-stating what is already accounted for under-states
 *   the commitment, and admits a device into a breach.
 *
 * Both ends are pessimistic about headroom. That is the whole rule.
 *
 * What this deliberately does NOT do is let the model out-price the meter on a
 * descent. A reading below what the reported step should draw has two readings —
 * a stale meter (2026-08-05, `inc_26449fb9`) or a device genuinely idle at its
 * setpoint, which is ordinary behaviour for a thermostat or a tapering charger —
 * and they are indistinguishable from one sample. Crediting the model would
 * declare a breach closed on watts that were never flowing; crediting the meter
 * under-credits a stale one, which the ladder already covers by walking to a
 * deeper rung.
 */
export function resolveStepChangeKw(
  device: StepChangeDevice,
  fromStepId: string | undefined,
  toStepId: string | undefined,
): StepChange {
  if (!isSteppedLoadDevice(device)) return NO_STEP_CHANGE;
  const effectiveFromStepId = fromStepId ?? resolvePlannerEffectiveStepId(device);
  // A device the producer resolved as off is AT zero, whatever step it still
  // reports — both for where the change starts and for what is flowing. Reading
  // the reported step as the from-position would make a restore look like a
  // descent (`medium` -> `low` runs down the ladder, but from off it is a
  // climb) and answer nothing for a device about to start drawing.
  const observedOff = device.currentOn === false;

  // Direction comes from the ladder's ORDER, never from the estimates: a step
  // whose calibration has learned oddly must not be able to invert which way
  // the ladder runs. Position, not watts — `normalizeSteppedLoadProfile`
  // dedupes step IDs but not wattages, so a hand-configured profile can carry
  // two distinct rungs at the same `planningPowerW`. Comparing watts calls that
  // transition "no change", and the restore lane then never commands the tied
  // rung and stalls before every rung above it. `sortSteppedLoadSteps` breaks
  // the tie by id, so the order is total and both rungs are reachable.
  const fromIndex = observedOff ? OFF_LADDER_INDEX : resolveStepIndex(device, effectiveFromStepId);
  const toIndex = resolveStepIndex(device, toStepId);
  if (toIndex === fromIndex) return NO_STEP_CHANGE;
  const direction = toIndex < fromIndex ? 'down' : 'up';

  const beforeKw = observedOff
    ? 0
    : resolveStepChangeBeforeKw(device, effectiveFromStepId, direction);
  const afterKw = resolveStepPowerKw(device, toStepId);
  const deltaKw = direction === 'down'
    ? Math.max(0, beforeKw - afterKw)
    : Math.max(0, afterKw - beforeKw);
  return { direction, deltaKw };
}

/**
 * Below every rung: where a device the producer resolved as off sits, and where
 * a step id the profile does not carry resolves to. Both mean "not on the
 * ladder", and both make any real rung a climb.
 */
const OFF_LADDER_INDEX = -1;

/** A step's position on the device's ladder, gentlest first. */
function resolveStepIndex(
  device: Pick<StepCapableDevice, 'steppedLoadProfile'>,
  stepId: string | undefined,
): number {
  if (stepId === undefined) return OFF_LADDER_INDEX;
  const profile = getSteppedLoadProfileForDevice(device);
  if (!profile) return OFF_LADDER_INDEX;
  return sortSteppedLoadSteps(profile.steps).findIndex((step) => step.id === stepId);
}

/** What the device is drawing now, as far as the evidence allows. */
function resolveStepChangeBeforeKw(
  device: StepChangeDevice,
  fromStepId: string | undefined,
  direction: 'down' | 'up',
): number {
  const modelKw = resolveStepPowerKw(device, fromStepId);
  const measuredKw = Math.max(0, device.currentDrawKw);
  // A zero reading at a running step is not evidence of idleness — an
  // unreadable meter resolves to 0 as well, and a device mid-cycle or throttled
  // reads zero while still committed to its rung. The model is the only usable
  // estimate either way.
  if (measuredKw <= 0) return modelKw;
  return direction === 'down' ? measuredKw : Math.min(measuredKw, modelKw);
}

// Per the "resolution belongs in producer" rule, the producer
// (`appInit.buildStepPowerCalibrationView`) has already bound the calibrated
// value to samples inside the configured step's power band. The plan layer
// trusts the view; this only falls back to nameplate when no entry is present.
//
// One figure, not two ends of a band: the store learns a single number per
// rung, so a caller wanting the conservative end has to find it against the
// meter, never against a second calibration value.
export function resolveStepPowerKw(
  device: Pick<StepCapableDevice, 'steppedLoadProfile' | 'stepPowerCalibration'>,
  stepId: string | undefined,
): number {
  if (stepId === undefined) return resolveSteppedLoadPlanningKw(device, stepId);
  const calibrated = device.stepPowerCalibration?.[stepId];
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

function normalizePlannerStepState(device: StepIdentityFields) {
  return normalizeSteppedLoadStepStateFromLegacyFields({
    fields: device,
    selectedStepFallbackIsPlanningAssumption: true,
  });
}

function resolvePlannerEffectiveStepId(device: Parameters<typeof normalizePlannerStepState>[0]): string | undefined {
  return resolveKnownEffectiveStepId(normalizePlannerStepState(device));
}
