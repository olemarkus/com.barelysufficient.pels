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
  DeviceControlModel,
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  SteppedLoadProfile,
  TargetCapabilitySnapshot,
  TargetDeviceSnapshot,
  TemperatureBoostConfig,
} from '../../packages/contracts/src/types';
import {
  getTrustedCurrentTemperatureC,
  getTrustedStateOfCharge,
} from '../utils/observationTrust';
import { normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import { hasTemperatureBoostTarget } from '../utils/temperatureBoost';
import {
  EV_COMMANDABLE_NOW_REASONS,
  formatUnknownEvChargingStateReason,
} from '../../packages/shared-domain/src/commandableNowReason';
import { isEvDevice, type CommandableNowResolveInput } from '../../packages/shared-domain/src/commandableNow';
// Commandability resolution lives in shared-domain so the executor can import it
// without crossing the no-executor-to-device-internals boundary. Re-exported
// here for the planner/producer call sites that already import from this module.
export {
  resolveCommandableNow,
  isCommandableNow,
  getCommandableNowReason,
} from '../../packages/shared-domain/src/commandableNow';
export type {
  CommandableNowResolveInput,
  CommandableNowResolution,
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

export const TEMPERATURE_BOOST_EXIT_MARGIN_C = 2;


export type BinaryControlPlan = {
  capabilityId: 'onoff' | 'evcharger_charging';
  isEv: boolean;
  canSet: boolean;
};

type SteppedLoadIdentity = {
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
};

type ControllableFlags = {
  controllable?: boolean;
  managed?: boolean;
  available?: boolean;
};

type ObservationFreshness = {
  observationStale?: boolean;
};

export type EvBoostResolveInput = SteppedLoadIdentity & ControllableFlags & ObservationFreshness & {
  deviceClass?: string;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  evChargingState?: string;
  forceBoostActive?: boolean;
  evBoost?: EvBoostConfig;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
};

export type TemperatureBoostResolveInput = SteppedLoadIdentity & ControllableFlags & ObservationFreshness & {
  targets: readonly TargetCapabilitySnapshot[];
  forceBoostActive?: boolean;
  temperatureBoost?: TemperatureBoostConfig;
  currentTemperature?: number;
};

const isSteppedLoad = (device: SteppedLoadIdentity): boolean => (
  device.controlModel === 'stepped_load' && device.steppedLoadProfile?.model === 'stepped_load'
);

export function resolveEvBoostActive(params: {
  dev: EvBoostResolveInput;
  previousActive: boolean;
}): boolean {
  const { dev } = params;
  if (!isEvDevice(dev)) return false;
  if (!isSteppedLoad(dev)) return false;
  if (dev.controllable === false || dev.managed === false || dev.available === false) return false;
  if (dev.evChargingState === 'plugged_out' || dev.evChargingState === 'plugged_in_discharging') return false;
  // The deferred limit-lower-priority rescue lane forces boost while the task is in its
  // planned hours, independent of the device's own boost config/threshold.
  if (dev.forceBoostActive === true) return true;
  const config = dev.evBoost;
  if (config?.enabled !== true) return false;
  const stateOfCharge = getTrustedStateOfCharge(dev);
  if (!stateOfCharge) return false;
  const boostBelowPercent = config.boostBelowPercent;
  if (!Number.isFinite(boostBelowPercent)) return false;
  return stateOfCharge.percent < boostBelowPercent;
}

export function resolveTemperatureBoostActive(params: {
  dev: TemperatureBoostResolveInput;
  previousActive: boolean;
}): boolean {
  const { dev, previousActive } = params;
  if (!isSteppedLoad(dev)) return false;
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
  const exitThresholdC = boostBelowC + TEMPERATURE_BOOST_EXIT_MARGIN_C;
  return previousActive
    ? currentTemperature < exitThresholdC
    : currentTemperature < boostBelowC;
}

export function getBinaryControlPlan(snapshot?: TargetDeviceSnapshot): BinaryControlPlan | null {
  const capabilityId = resolveBinaryCapabilityId(snapshot);
  if (!snapshot || !capabilityId) return null;
  return {
    capabilityId,
    isEv: capabilityId === 'evcharger_charging',
    // Routed through `resolveCanSetControl` so the planner-side producer bit
    // (consumed by the migrated `canTurnOnDevice`) and the legacy
    // `getBinaryControlPlan().canSet` view stay bit-exact in lockstep.
    canSet: resolveCanSetControl({
      controlCapabilityId: snapshot.controlCapabilityId,
      capabilities: snapshot.capabilities,
      canSetControl: snapshot.canSetControl,
      canSetOnOff: (snapshot as (TargetDeviceSnapshot & { canSetOnOff?: boolean })).canSetOnOff,
    }),
  };
}

export function getEvRestoreBlockReason(snapshot?: TargetDeviceSnapshot): string | null {
  if (!snapshot || !isEvDevice(snapshot)) return null;
  if (snapshot.evChargingState === undefined) return EV_COMMANDABLE_NOW_REASONS.state_unknown;

  switch (snapshot.evChargingState) {
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return null;
    case 'plugged_in':
      return EV_COMMANDABLE_NOW_REASONS.plugged_in;
    case 'plugged_out':
      return EV_COMMANDABLE_NOW_REASONS.plugged_out;
    case 'plugged_in_discharging':
      return EV_COMMANDABLE_NOW_REASONS.plugged_in_discharging;
    default:
      return formatUnknownEvChargingStateReason(snapshot.evChargingState);
  }
}

type BinaryCapabilityResolveInput = {
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  capabilities?: string[];
};

function resolveBinaryCapabilityId(
  snapshot?: BinaryCapabilityResolveInput,
): BinaryControlPlan['capabilityId'] | undefined {
  if (!snapshot) return undefined;
  if (snapshot.controlCapabilityId) return snapshot.controlCapabilityId;
  if (snapshot.capabilities?.includes('evcharger_charging')) return 'evcharger_charging';
  if (snapshot.capabilities?.includes('onoff')) return 'onoff';
  return undefined;
}

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
  const capabilityId = resolveBinaryCapabilityId(input);
  if (!capabilityId) return false;
  if (input.canSetControl === false) return false;
  if (capabilityId === 'onoff' && input.canSetOnOff === false) return false;
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
export function isEvPhysicallyUnplugged(dev: CommandableNowResolveInput): boolean {
  return (
    isEvDevice(dev)
    && (dev.evChargingState === 'plugged_out' || dev.evChargingState === 'plugged_in_discharging')
  );
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
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  primaryTarget?: TargetCapabilitySnapshot | null;
};

const isSteppedLoadDeviceShape = (input: ShedIntentResolveInput): boolean => (
  input.controlModel === 'stepped_load'
  && input.steppedLoadProfile?.model === 'stepped_load'
);

const resolveSetStepTargetStepId = (input: ShedIntentResolveInput): string | null => {
  const profile = input.steppedLoadProfile;
  if (!profile || profile.model !== 'stepped_load') return null;
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
  const { shedBehavior, controllable, controlCapabilityId, primaryTarget } = input;
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
    if (controlCapabilityId === undefined) {
      return { kind: 'set_step', targetStepId: resolveSetStepTargetStepId(input) };
    }
  }
  return { kind: 'turn_off' };
};
