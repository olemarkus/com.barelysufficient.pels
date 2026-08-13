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
  EvObservedProbe,
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
import {
  isEvDevice,
  isEvPlugStateBlocked,
  isEvSessionInactive,
} from '../../packages/shared-domain/src/evPlugState';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
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
  getSteppedLoadStep,
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

type ControllableFlags = {
  controllable?: boolean;
  managed?: boolean;
  available?: boolean;
};

export type EvBoostResolveInput = SteppedLoadIdentity & ControllableFlags & EvObservedProbe & {
  deviceClass?: string;
  forceBoostActive?: boolean;
  evBoost?: EvBoostConfig;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
};

export type TemperatureBoostResolveInput = SteppedLoadIdentity & ControllableFlags & {
  targets: readonly TargetCapabilitySnapshot[];
  forceBoostActive?: boolean;
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
 * A device's measured progress value against its boost floor, both in the
 * device's own unit: a temperature device measures °C against `boostBelowC`, an
 * EV charger measures SoC % against `boostBelowPercent`. Both kinds project into
 * this shape so the boost decision itself is unit-agnostic.
 */
type MeasuredBoostState = {
  current: number;
  boostFloor: number;
};

/**
 * The unit-agnostic boost decision: the measured value strictly below its floor.
 *
 * There is no exit-margin hysteresis — the only behavioural consumer (restore
 * escalation in `lib/plan/restore/helpers.ts`) is already gated on recent
 * observed draw, so a device satisfied at/near its setpoint stops escalating
 * without a band, and each device's own thermostat/charger deadband supplies the
 * physical hysteresis.
 *
 * Only the final comparison is shared. The kind-specific eligibility and gate
 * ORDERING stay in the two resolvers below — in particular EV's plug-state block
 * must precede `forceBoostActive` (a not-resumable charger must never force-boost),
 * which a flattened skeleton would lose.
 */
const isBelowBoostFloor = (state: MeasuredBoostState): boolean => (
  state.current < state.boostFloor
);

export function resolveEvBoostActive(dev: EvBoostResolveInput): boolean {
  // Identity gate, NOT the plug-state guard: an `evcharger` driven through
  // `target_power` or a stepped-load profile exposes no EV capabilities and has
  // no plug state, but it still boosts on SoC like any other charger.
  if (!isEvDevice(dev)) return false;
  if (!hasSteppedLoadProfile(dev)) return false;
  if (dev.controllable === false || dev.managed === false || dev.available === false) return false;
  // Block boost only where PELS genuinely cannot drive the charger: unplugged or
  // discharging. Boost is "command it on now", so this asks the same question of
  // the same plug-state the restore path does, through the one shared classifier
  // — and only for a charger that HAS a plug-state to ask about. The settings-UI
  // boost panel renders its wording off that same classification
  // (`resolveEvBoostBlockReason`), so the runtime can never force a boost the UI
  // says won't activate.
  if (isEvObserved(dev) && isEvPlugStateBlocked(dev.evChargingState)) return false;
  // The deferred limit-lower-priority rescue lane forces boost while the task is in its
  // planned hours, independent of the device's own boost config/threshold.
  if (dev.forceBoostActive === true) return true;
  const config = dev.evBoost;
  if (config?.enabled !== true) return false;
  const percent = getTrustedStateOfCharge(dev);
  if (percent === undefined) return false;
  const boostBelowPercent = config.boostBelowPercent;
  if (!Number.isFinite(boostBelowPercent)) return false;
  return isBelowBoostFloor({ current: percent, boostFloor: boostBelowPercent });
}

export function resolveTemperatureBoostActive(dev: TemperatureBoostResolveInput): boolean {
  if (!hasSteppedLoadProfile(dev)) return false;
  if (!hasTemperatureBoostTarget(dev.targets)) return false;
  if (dev.controllable === false || dev.managed === false || dev.available === false) return false;
  // The deferred limit-lower-priority rescue lane forces boost while the task is in its
  // planned hours, independent of the device's own boost config/threshold.
  if (dev.forceBoostActive === true) return true;
  const config = dev.temperatureBoost;
  if (config?.enabled !== true) return false;
  const currentTemperature = getTrustedCurrentTemperatureC(dev);
  if (currentTemperature === undefined) return false;
  const boostBelowC = config.boostBelowC;
  if (typeof boostBelowC !== 'number' || !Number.isFinite(boostBelowC)) return false;
  return isBelowBoostFloor({ current: currentTemperature, boostFloor: boostBelowC });
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

/**
 * Resolve aggregate boost activation: true if either temperature-boost or
 * EV-boost policies fire. Producer-side aggregator over the two
 * domain-specific resolvers added in chunk 1.
 *
 * Two-arg form (preferred at the planner call site, which already computed
 * both booleans for state tracking + transition emission): pass the
 * resolved temperature/EV booleans directly. Stays pure.
 */
export function resolveBoostActive(params: {
  temperatureBoostActive: boolean;
  evBoostActive: boolean;
}): boolean {
  return params.temperatureBoostActive === true || params.evBoostActive === true;
}


/**
 * Dual-read consumer helper for the aggregate boost flag. Prefers the
 * producer-resolved `boostActive` bit (populated by
 * `buildBoostPlanDeviceFields`) and falls back to the OR over the two
 * per-axis flags so manually-built `DevicePlanDevice` fixtures and any
 * legacy upstream shapes that haven't yet propagated `boostActive`
 * continue to behave identically.
 */
export function isBoostActive(dev: {
  boostActive?: boolean;
  temperatureBoostActive?: boolean;
  evBoostActive?: boolean;
}): boolean {
  if (dev.boostActive !== undefined) return dev.boostActive;
  return dev.temperatureBoostActive === true || dev.evBoostActive === true;
}

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

/**
 * Detects the specific "EV physical block" sub-case that the consumer at
 * `planOffStateReason.resolveEvPhysicalBlockInactiveReason` cares about:
 * the device is an EV charger and the plug is out or discharging. Other
 * not-commandable reasons (e.g. `available === false`) are not physical
 * EV blocks and stay outside this gate.
 */
export function isEvPhysicallyUnplugged(
  dev: { deviceClass?: string } & EvObservedProbe,
): boolean {
  // `isEvObserved` scopes the question to EV devices, so a non-EV device can
  // never read as an EV block, and the plug-state it narrows to is the same one
  // every other EV question is answered from.
  return isEvObserved(dev) && isEvSessionInactive(dev.evChargingState);
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
  // (configured `shedBehavior.stepId` → lowest-active step → off-step). The
  // lifecycle-end release consumer (`lib/executor/shedReleaseActuation.ts`)
  // reads it directly instead of re-running the cascade at apply time. It is
  // `null` only on a degenerate empty profile; the consumer gates on null.
  //
  // The cap-driven shed path (`lib/plan/planSteppedLoad.ts`) does NOT consult
  // this field — it picks the lowest-active step itself to maximise load drop.
  // That intentional semantic divergence is documented at both call sites.
  | { kind: 'set_step'; targetStepId: string | null };

export type ShedIntentBehaviorInput = {
  action: 'turn_off' | 'set_temperature' | 'set_step';
  temperature: number | null;
  stepId: string | null;
};

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
  // Release cascade: honour the configured `shedBehavior.stepId` first, then fall back to
  // the lowest-active step, then the off-step. Mirrors what `shedReleaseActuation.ts` used
  // to resolve at apply time. Cap-driven sheds do not read this; they pick lowest-active
  // independently in `planSteppedLoad.ts`.
  const preferred = input.shedBehavior.stepId;
  if (preferred) {
    const exact = getSteppedLoadStep(profile, preferred);
    if (exact) return exact.id;
  }
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
    && shedBehavior.temperature !== null
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
