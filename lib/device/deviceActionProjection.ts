/**
 * Producer-seam home for pure helpers that resolve device-shape questions
 * the planner used to answer by branching on raw device type/class fields.
 *
 * This is chunk 1 of the planner-detype refactor: the helpers move here
 * verbatim with their existing call signatures preserved through thin
 * re-export shims in `lib/plan/`. No behavior change; later chunks layer
 * new resolved fields on top of this seam.
 *
 * Purity rules for this file:
 *  - No side effects, no class instances, no runtime singletons.
 *  - No imports from `lib/plan/**` (transitively enforced by the
 *    `no-device-action-projection-to-plan` dependency-cruiser rule).
 *  - Input types are structural; consumers under `lib/plan/` pass their
 *    own richer device shapes (e.g. `PlanInputDevice`) which TypeScript
 *    narrows automatically via structural compatibility.
 */
import type {
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  SteppedLoadProfile,
  TargetCapabilitySnapshot,
  TemperatureBoostConfig,
} from '../../packages/contracts/src/types';
import {
  getTrustedCurrentTemperatureC,
  getTrustedStateOfCharge,
} from '../utils/observationTrust';
import { normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import { hasTemperatureBoostTarget } from '../utils/temperatureBoost';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
// Commandability resolution lives in shared-domain so the executor can import it
// without crossing the no-executor-to-device-internals boundary. Re-exported
// here for the planner/producer call sites that already import from this module.
export {
  isCommandableNow,
} from '../../packages/shared-domain/src/commandableNow';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';

// Trust gates (`getTrustedCurrentTemperatureC`, `getTrustedStateOfCharge`)
// live in `lib/utils/observationTrust.ts` so both this module and
// `lib/observer/` can share one source under the
// `no-device-to-peer-except-power` layering rule.

export type BinaryControlPlan = {
  canSet: boolean;
};

type SteppedLoadIdentity = {
  steppedLoadProfile?: SteppedLoadProfile;
};

/**
 * Everything the producer needs to answer the two boost questions for one
 * device.
 *
 * One flat shape, not a per-kind union: the two config/reading pairs below are
 * two SOURCES for the same quantity (see `BoostLevel`), and a device carries
 * whichever its capabilities give it. Splitting them into kind-shaped inputs is
 * what made this look like two decisions.
 *
 * `commandableNow` is the producer's already-resolved answer to "may PELS drive
 * this device right now" (`resolveCommandableNow`: EV plug-state and
 * availability). It is passed in rather than re-derived so the boost gate and
 * the commandability the rest of the plan reads cannot give two answers.
 *
 * The remaining runnable flags (`controllable` / `managed`) are deliberately NOT
 * here. They are the planner's own gating vocabulary, and they are read AFTER
 * deferred-objective admission may have flipped `controllable` for a rescued
 * device, while this producer runs before that. See `resolveBoostActive`
 * (`lib/plan/planBoost.ts`), which applies them.
 */
export type BoostResolveInput = SteppedLoadIdentity & {
  commandableNow: boolean;
  targets: readonly TargetCapabilitySnapshot[];
  // Source A — state of charge, floor in percent.
  evBoost?: EvBoostConfig;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
  // Source B — temperature, floor in °C.
  temperatureBoost?: TemperatureBoostConfig;
  currentTemperature?: number;
};

// "Stepped load" is a yes/no capability = presence of a valid
// `steppedLoadProfile`. `controlModel` is a producer-only SETTING and never rode
// on this seam's discriminant, so the field is gone from `SteppedLoadIdentity`
// entirely rather than sitting there unread. Shared by the boost resolvers and
// the shed-intent resolver below — and matching every other site
// (`planSteppedLoad`, `planCurrentState`, `planTypes`, `observedState`) — so the
// planner's profile-only stepped check and this one cannot drift.
const hasSteppedLoadProfile = (
  device: { steppedLoadProfile?: SteppedLoadProfile },
): boolean => isSteppedLoadSnapshot(device);

/**
 * How full this device's store already is, against the floor its owner set —
 * both in the device's own unit.
 *
 * There is ONE such quantity per device, not one per device kind. A tank's
 * temperature and a car's battery percentage are the same reading asked in
 * different units: how much of what this device holds is already there. The
 * `unmeasured` arm is what a device with no reading, no floor, or no boost
 * config resolves to — a typed result rather than a nullable, so no caller has
 * to decide what an absent level would have meant.
 */
type BoostLevel =
  | { kind: 'measured'; current: number; boostFloor: number }
  | { kind: 'unmeasured' };

const UNMEASURED_BOOST_LEVEL: BoostLevel = { kind: 'unmeasured' };

/**
 * The one guard every source passes through: a trusted reading and a finite
 * floor, or nothing. Sources differ ONLY in which capability they read and which
 * config field holds the floor — everything after that is this function, which
 * is why there is no per-kind resolver left to keep in sync.
 */
const toBoostLevel = (
  current: number | undefined,
  boostFloor: number | undefined,
): BoostLevel => {
  if (current === undefined) return UNMEASURED_BOOST_LEVEL;
  if (boostFloor === undefined || !Number.isFinite(boostFloor)) return UNMEASURED_BOOST_LEVEL;
  return { kind: 'measured', current, boostFloor };
};

/**
 * The device's level, read from whichever source it has.
 *
 * First match wins rather than "either source may request" — the two are one
 * quantity, so a device that reports a level has reported THE level, and falling
 * through to a second source would be asking the same question twice hoping for
 * a different answer. In practice no device has both: a charger exposes no
 * temperature target, a thermostat no state of charge.
 *
 * Neither branch asks what kind of device it is on. The observed capability IS
 * the source: a device with a trusted state of charge reads its level there, and
 * a device with a temperature setpoint to raise reads it from the thermometer.
 */
const resolveBoostLevel = (dev: BoostResolveInput): BoostLevel => {
  const stateOfCharge = dev.evBoost?.enabled === true && hasObservedStateOfCharge(dev)
    ? toBoostLevel(getTrustedStateOfCharge(dev), dev.evBoost.boostBelowPercent)
    : UNMEASURED_BOOST_LEVEL;
  if (stateOfCharge.kind === 'measured') return stateOfCharge;
  // The target capability is what makes a temperature this device's level at
  // all: without a setpoint to raise, the thermometer is telling PELS about the
  // room rather than about a store it can fill.
  return dev.temperatureBoost?.enabled === true && hasTemperatureBoostTarget(dev.targets)
    ? toBoostLevel(getTrustedCurrentTemperatureC(dev), dev.temperatureBoost.boostBelowC)
    : UNMEASURED_BOOST_LEVEL;
};

/**
 * Producer-resolved: PELS has a boost it can drive on this device right now. It
 * says nothing about whether boost is wanted.
 *
 * Two conditions, and no device kinds behind either. Boost's only actuation is
 * escalating a stepped ladder — `resolveSteppedKeepDesiredStepId`, the
 * shed-invariant bypass and the swap path in `lib/plan/restore/` are the entire
 * consumer set, and all three are stepped-only — so a usable ladder is what
 * makes boost drivable. And `commandableNow` is what makes it drivable *now*: it
 * already folds in the EV plug-state that used to be asked for here by hand, so
 * a charger PELS cannot resume is not boost-supported, exactly as before. The
 * settings-UI boost panel renders its wording off the same classification
 * (`resolveEvBoostBlockReason`), so the runtime can never force a boost the UI
 * says won't activate.
 *
 * This is the bit a forced boost needs: the deferred limit-lower-priority rescue
 * lane engages boost independently of the device's own threshold, and this is
 * what stops it engaging one that could not possibly land.
 */
export function resolveBoostSupported(dev: BoostResolveInput): boolean {
  return hasSteppedLoadProfile(dev) && dev.commandableNow;
}

/**
 * Producer-resolved: the device's OWN boost policy asks for boost this cycle —
 * drivable, and its store is below the floor its owner set.
 *
 * The whole request, in one comparison. Unit-agnostic by construction: the level
 * and the floor arrive in the same unit from the same source, so no consumer
 * ever sees a percentage or a temperature, and no comparison here ever spans
 * two units.
 *
 * There is no exit-margin hysteresis. `resolveBoostActive`
 * (`lib/plan/planBoost.ts`) releases boost on the device's own observed draw
 * going quiet, so a device satisfied at its setpoint stops boosting without a
 * band, and each device's thermostat/charger deadband supplies the physical
 * hysteresis below that.
 */
export function resolveBoostRequested(dev: BoostResolveInput): boolean {
  if (!resolveBoostSupported(dev)) return false;
  const level = resolveBoostLevel(dev);
  return level.kind === 'measured' && level.current < level.boostFloor;
}

/**
 * Exactly the fields the binary control plan reads. Narrow on purpose: both call
 * sites pass a PROJECTED snapshot shape (`BinaryControlDecisionSnapshot` in plan,
 * `ExecutorDeviceSnapshot` in executor), never a whole `TargetDeviceSnapshot`.
 * Declaring the parameter as the full descriptor only type-checked for as long as
 * every descriptor field happened to be optional, so the first required one broke
 * both callers — and the `canSetOnOff` cast below existed for the same reason.
 */
export type BinaryControlPlanInput = BinaryCapabilityResolveInput & {
  canSetControl?: boolean;
  canSetOnOff?: boolean;
};

export function getBinaryControlPlan(snapshot?: BinaryControlPlanInput): BinaryControlPlan | null {
  if (!snapshot || !hasBinaryAxis(snapshot)) return null;
  return {
    // Routed through `resolveCanSetControl` so the planner-side producer bit
    // (consumed by the migrated `canTurnOnDevice`) and the legacy
    // `getBinaryControlPlan().canSet` view stay bit-exact in lockstep.
    canSet: resolveCanSetControl({
      binaryControl: snapshot.binaryControl,
      currentOn: snapshot.currentOn,
      capabilities: snapshot.capabilities,
      canSetControl: snapshot.canSetControl,
      canSetOnOff: snapshot.canSetOnOff,
    }),
  };
}



type BinaryCapabilityResolveInput = {
  binaryControl?: { on: boolean };
  currentOn?: boolean;
  capabilities?: string[];
};

const hasBinaryAxis = (snapshot: BinaryCapabilityResolveInput): boolean => (
  snapshot.binaryControl !== undefined || typeof snapshot.currentOn === 'boolean'
);

// `resolveCanSetBinaryControl` collapsed into `resolveCanSetControl` above
// (chunk 6 of the planner-detype refactor). `getBinaryControlPlan` now routes
// through the same producer that PlanInputDevice consumers read.

// =============================================================================
// Chunk 2 of the planner-detype refactor: resolve commandableNow + boostActive
// at the producer seam (toPlanDevice) and let consumers consume the resolved
// bit instead of branching on raw evChargingState / controlCapabilityId /
// deviceClass / boost-threshold math.
//
// Pure helpers: state-dependent inputs (previous boost) are passed in
// explicitly. No closure over runtime singletons.
// =============================================================================

// The two per-kind boost flags are gone from the plan device, and with them the
// aggregate `resolveBoostActive({ temperatureBoostActive, evBoostActive })` and
// its dual-read consumer `isBoostActive`. There is one boost truth now:
// `boostActive`, resolved once by `lib/plan/planBoost.ts` from the two bits
// above plus the planner's own runnable gate and draw release, and read directly
// off the device.

// -----------------------------------------------------------------------------
// canSetControl — sibling producer-resolved bit (chunk 6 of the planner-detype
// refactor). Mirrors the `canSet` computation inside `getBinaryControlPlan`
// (`canSetControl !== false`, plus the legacy `canSetOnOff` fallback for the
// `onoff` capability) so executor consumers can read a single resolved flag
// instead of round-tripping through `getBinaryControlPlan`.
//
// Kept separate from `commandableNow`: commandableNow answers "is the device
// responsive right now" (EV plug state, available) which `planOffStateReason`
// reads without caring about `canSet`. canSetControl answers "can we write
// to its control capability" — different question, separate bit.
// -----------------------------------------------------------------------------

export type CanSetControlResolveInput = BinaryCapabilityResolveInput & {
  canSetControl?: boolean;
  canSetOnOff?: boolean;
};

/**
 * Resolve whether the device's binary control capability can be written this
 * cycle. Returns `false` when:
 *  - the device exposes no resolvable binary capability (no `controlCapabilityId`,
 *    no matching entry in `capabilities`); or
 *  - `canSetControl === false`; or
 *  - the resolved capability is `onoff` and the legacy `canSetOnOff === false`.
 *
 * Mirrors `getBinaryControlPlan(snapshot)?.canSet ?? false` exactly so the
 * migrated `canTurnOnDevice` gate stays byte-for-byte equivalent for the
 * existing snapshot shapes the executor passes in.
 */
export function resolveCanSetControl(input: CanSetControlResolveInput): boolean {
  if (!hasBinaryAxis(input)) return false;
  if (input.canSetControl === false) return false;
  if (input.canSetOnOff === false) return false;
  return true;
}

type CanSetControlConsumerInput = CanSetControlResolveInput & {
  canSetControlResolved?: boolean;
};

/**
 * Dual-read consumer helper: prefer the producer-resolved bit when the
 * caller passes a `PlanInputDevice` (`canSetControlResolved` set by
 * `toPlanDevice`), fall back to fresh resolution from raw fields when the
 * caller passes a `TargetDeviceSnapshot`. Mirrors `isCommandableNow`'s
 * dual-read pattern from chunk 2.
 */
export function isCanSetControl(dev: CanSetControlConsumerInput): boolean {
  if (dev.canSetControlResolved !== undefined) return dev.canSetControlResolved;
  return resolveCanSetControl(dev);
}

// ---------------------------------------------------------------------------
// Producer-resolved shed-action intent (chunk 5 of the planner-detype
// refactor).
//
// Today the planner branches on raw `shedBehavior.action` + device-shape
// fields (`controlCapabilityId`, `isSteppedLoadDevice`, primary target presence)
// inside `lib/plan/planDevices.ts:resolveShedAction` to materialise the
// `{ shedAction, shedTemperature, releaseShedStepId }` triple on each
// `DevicePlanDevice`. Chunk 5 lifts the *device-capability* half of that
// resolution into the producer: the resulting `ShedActionIntent` captures
// "what the device's configured shedBehavior translates to given its
// capabilities", independent of plan-cycle controllable/shouldShed gates.
//
// Consumers (planDevices.resolveShedAction, planRemainingSheddableLoad,
// shedReleaseActuation) read the resolved intent and apply their plan-cycle
// gates. The intent is structurally a discriminated union — no consumer
// needs to call back into a device-shape helper.
//
// Chunk 6 retires the dual-read fallback in `resolveShedAction` and the
// `ShedAction` enum on `DevicePlanDevice` is materialised exclusively from
// `shedIntent` via a snapshot-adapter helper. The `controllable` plan-cycle
// gate is also folded into the producer (PR A of the post-detype cleanup):
// the producer collapses cap-off devices to their binary fallback intent
// (`turn_off` for non-stepped, `set_step` for stepped-no-binary, `turn_off`
// for stepped-with-binary) so the materialisation adapter only has to apply
// the per-cycle `shouldShed` gate.
// ---------------------------------------------------------------------------

export type ShedActionIntent =
  | { kind: 'turn_off' }
  | { kind: 'set_temperature'; temperature: number }
  // `targetStepId` is the producer-resolved release-cascade target step
  // (lowest-active step → off-step). The lifecycle-end release consumer
  // (`lib/executor/shedReleaseActuation.ts`) reads it directly instead of
  // re-running the cascade at apply time. It is `null` only on a degenerate
  // empty profile; the consumer gates on null.
  //
  // The cap-driven shed path (`lib/plan/planSteppedLoad.ts`) does NOT consult
  // this field — it picks the lowest-active step itself to maximise load drop.
  // That intentional semantic divergence is documented at both call sites.
  | { kind: 'set_step'; targetStepId: string | null };

// Structural mirror of `ShedBehavior` (`lib/plan/planTypes.ts`). Duplicated on
// purpose: `lib/device` must not import `lib/plan` (`no-device-to-plan`), and
// the alternative — a nullable flat shape — is the impossible state the union
// exists to forbid. Keep the two in step.
export type ShedIntentBehaviorInput =
  | { action: 'turn_off' }
  | { action: 'set_temperature'; temperature: number }
  | { action: 'set_step' };

export type ShedIntentResolveInput = {
  shedBehavior: ShedIntentBehaviorInput;
  controllable: boolean;
  hasBinaryControl: boolean;
  steppedLoadProfile?: SteppedLoadProfile;
  primaryTarget?: TargetCapabilitySnapshot | null;
};

// Same stepped discriminant as the boost resolvers — see `hasSteppedLoadProfile`.
const isSteppedLoadDeviceShape = (input: ShedIntentResolveInput): boolean => (
  hasSteppedLoadProfile(input)
);

const resolveSetStepTargetStepId = (input: ShedIntentResolveInput): string | null => {
  const profile = input.steppedLoadProfile;
  if (!profile) return null;
  // Release cascade: the lowest-active step, then the off-step. Mirrors what
  // `shedReleaseActuation.ts` used to resolve at apply time. Cap-driven sheds do not read
  // this; they pick lowest-active independently in `planSteppedLoad.ts`.
  //
  // There used to be a rung above these two — a configured `shedBehavior.stepId`. Nothing
  // ever wrote one (`normalizeShedBehaviors` stores `set_step` as a bare `{ action }`), so
  // that branch was unreachable; the ladder is the device's, not the owner's.
  const lowestActive = getSteppedLoadLowestActiveStep(profile);
  if (lowestActive) return lowestActive.id;
  const offStep = getSteppedLoadOffStep(profile);
  return offStep ? offStep.id : null;
};

export const resolveShedIntent = (input: ShedIntentResolveInput): ShedActionIntent => {
  const { shedBehavior, controllable, hasBinaryControl, primaryTarget } = input;
  // set_temperature requires both a primary target capability (so the executor has a write
  // surface and a normalised setpoint) AND `controllable === true` for this cycle. Cap-off
  // devices configured for set_temperature collapse to the binary fallback below; the planner
  // and executor never see a set_temperature intent for a non-controllable device.
  if (
    controllable
    && shedBehavior.action === 'set_temperature'
    && primaryTarget
  ) {
    return {
      kind: 'set_temperature',
      temperature: normalizeTargetCapabilityValue({ target: primaryTarget, value: shedBehavior.temperature }),
    };
  }
  // Stepped devices without a binary handle can only shed via the step capability — both the
  // legacy `resolveSteppedShedAction` and the post-fold materialisation fall back to
  // 'set_step' in that case regardless of the configured behaviour action or controllability.
  if (isSteppedLoadDeviceShape(input)) {
    if (controllable && shedBehavior.action === 'set_step') {
      return { kind: 'set_step', targetStepId: resolveSetStepTargetStepId(input) };
    }
    if (!hasBinaryControl) {
      return { kind: 'set_step', targetStepId: resolveSetStepTargetStepId(input) };
    }
  }
  return { kind: 'turn_off' };
};
