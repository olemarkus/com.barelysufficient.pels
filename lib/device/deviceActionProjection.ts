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
  if (dev.deviceClass !== 'evcharger') return false;
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
    canSet: resolveCanSetBinaryControl(snapshot, capabilityId),
  };
}

export function getEvRestoreBlockReason(snapshot?: TargetDeviceSnapshot): string | null {
  if (!snapshot || snapshot.controlCapabilityId !== 'evcharger_charging') return null;
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

function resolveBinaryCapabilityId(
  snapshot?: TargetDeviceSnapshot,
): BinaryControlPlan['capabilityId'] | undefined {
  if (!snapshot) return undefined;
  if (snapshot.controlCapabilityId) return snapshot.controlCapabilityId;
  if (snapshot.capabilities?.includes('evcharger_charging')) return 'evcharger_charging';
  if (snapshot.capabilities?.includes('onoff')) return 'onoff';
  return undefined;
}

function resolveCanSetBinaryControl(
  snapshot: TargetDeviceSnapshot,
  capabilityId: BinaryControlPlan['capabilityId'],
): boolean {
  const legacyCanSetOnOff = (snapshot as (TargetDeviceSnapshot & { canSetOnOff?: boolean })).canSetOnOff;
  return snapshot.canSetControl !== false && !(capabilityId === 'onoff' && legacyCanSetOnOff === false);
}

// =============================================================================
// Chunk 2 of the planner-detype refactor: resolve commandableNow + boostActive
// at the producer seam (toPlanDevice) and let consumers consume the resolved
// bit instead of branching on raw evChargingState / controlCapabilityId /
// deviceClass / boost-threshold math.
//
// Pure helpers: state-dependent inputs (previous boost, abandon-grace window)
// are passed in explicitly. No closure over runtime singletons.
// =============================================================================

/**
 * Grace window during which a missing/empty SDK read is allowed to fall back
 * to the previously observed commandableNow. Tuned to comfortably exceed the
 * typical Homey snapshot-refresh cadence (a couple of poll cycles); shorter
 * than the deferred-objective ABANDON_GRACE_MS because commandability is a
 * per-cycle decision rather than a multi-hour planning bet.
 *
 * Pattern source: `lib/plan/deferredObjectives/planHistory.ts` —
 * `ABANDON_GRACE_MS`. See `feedback_homey_sdk_unreliable.md` — never drop
 * persisted state on a single missing read.
 */
export const COMMANDABLE_NOW_GRACE_MS = 5 * 60 * 1000;

export type CommandableNowResolveInput = {
  deviceClass?: string;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  evChargingState?: string;
  available?: boolean;
};

export type CommandableNowGraceEntry = {
  commandableNow: boolean;
  observedAtMs: number;
};

export type CommandableNowResolution = {
  commandableNow: boolean;
  reason: string | null;
};

/**
 * Resolve whether the device is commandable in this cycle.
 *
 * Returns:
 *   - `commandableNow: false` with a reason string when the device is
 *     physically blocked (EV unplugged / discharging, unavailable, etc.).
 *   - `commandableNow: true` with `reason: null` when the device accepts
 *     commands.
 *
 * Abandon-grace semantics: if the current SDK read is uncertain (no EV state
 * available on an EV charger, no controlCapabilityId yet, but we previously
 * observed a stable commandable answer within the grace window), the prior
 * observation wins. This protects against single-cycle SDK hiccups where
 * polling returns an empty payload — see `feedback_homey_sdk_unreliable.md`.
 *
 * `previousObservation` carries the most recent producer-resolved answer for
 * this device (managed in AppContext alongside `lastKnownPowerKw`). `nowMs`
 * is injected so the helper stays pure and unit-testable.
 */
export function resolveCommandableNow(params: {
  dev: CommandableNowResolveInput;
  previousObservation?: CommandableNowGraceEntry;
  nowMs: number;
}): CommandableNowResolution {
  const { dev, previousObservation, nowMs } = params;

  const evBlock = resolveEvCommandableBlock(dev);
  if (evBlock !== null) {
    // Only uncertain reads (no `evChargingState` from the SDK this cycle)
    // are eligible for the abandon-grace fallback. A confident negative
    // (plugged_out / discharging / explicit unknown state) is reported
    // as-is. Likewise, `available === false` is a confident SDK answer —
    // not a missing read — so it bypasses grace entirely.
    if (evBlock.uncertain) {
      const recent = isWithinGrace(previousObservation, nowMs);
      if (recent) return { commandableNow: recent.commandableNow, reason: null };
    }
    return { commandableNow: false, reason: evBlock.reason };
  }

  if (dev.available === false) {
    return { commandableNow: false, reason: 'device unavailable' };
  }

  return { commandableNow: true, reason: null };
}

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

// -----------------------------------------------------------------------------
// Dual-read consumer helpers (transitional bridge — removed in chunk 6).
//
// While `commandableNow` rolls out, planner consumers should prefer the
// producer-resolved bit when present and fall back to local resolution when
// undefined. Tests that build PlanInputDevice shapes manually keep working
// unchanged via the fallback path; chunk 6 removes the fallback once tests
// migrate.
// -----------------------------------------------------------------------------

type CommandableNowConsumerInput = CommandableNowResolveInput & {
  commandableNow?: boolean;
  commandableNowReason?: string | null;
};

export function isCommandableNow(dev: CommandableNowConsumerInput, nowMs: number = Date.now()): boolean {
  if (dev.commandableNow !== undefined) return dev.commandableNow;
  return resolveCommandableNow({ dev, nowMs }).commandableNow;
}

export function getCommandableNowReason(
  dev: CommandableNowConsumerInput,
  nowMs: number = Date.now(),
): string | null {
  if (dev.commandableNow !== undefined) return dev.commandableNowReason ?? null;
  return resolveCommandableNow({ dev, nowMs }).reason;
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
    dev.controlCapabilityId === 'evcharger_charging'
    && (dev.evChargingState === 'plugged_out' || dev.evChargingState === 'plugged_in_discharging')
  );
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

type EvCommandableBlock = { reason: string; uncertain: boolean };

function resolveEvCommandableBlock(dev: CommandableNowResolveInput): EvCommandableBlock | null {
  // Match the legacy `getEvRestoreBlockReason` gate exactly: only branch on
  // EV semantics when `controlCapabilityId === 'evcharger_charging'`. The
  // `deviceClass === 'evcharger'` short-circuit used by `planEvBoost` is a
  // distinct concern (boost activation, not commandability) and stays in
  // that resolver. Chunk 6 will normalise the two if a unified gate is
  // shown to be safe.
  if (dev.controlCapabilityId !== 'evcharger_charging') return null;

  switch (dev.evChargingState) {
    case 'plugged_out':
      return { reason: EV_COMMANDABLE_NOW_REASONS.plugged_out, uncertain: false };
    case 'plugged_in_discharging':
      return { reason: EV_COMMANDABLE_NOW_REASONS.plugged_in_discharging, uncertain: false };
    case 'plugged_in':
      return { reason: EV_COMMANDABLE_NOW_REASONS.plugged_in, uncertain: false };
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return null;
    case undefined:
      // No EV state read this cycle — uncertain. Caller may apply the
      // abandon-grace window.
      return { reason: EV_COMMANDABLE_NOW_REASONS.state_unknown, uncertain: true };
    default:
      return {
        reason: formatUnknownEvChargingStateReason(dev.evChargingState),
        uncertain: false,
      };
  }
}

function isWithinGrace(
  observation: CommandableNowGraceEntry | undefined,
  nowMs: number,
): CommandableNowGraceEntry | null {
  if (!observation) return null;
  if (nowMs - observation.observedAtMs > COMMANDABLE_NOW_GRACE_MS) return null;
  return observation;
}

// ---------------------------------------------------------------------------
// Producer-resolved shed-action intent (chunk 5 of the planner-detype
// refactor).
//
// Today the planner branches on raw `shedBehavior.action` + device-shape
// fields (`hasBinaryControl`, `isSteppedLoadDevice`, primary target presence)
// inside `lib/plan/planDevices.ts:resolveShedAction` to materialise the
// `{ shedAction, shedTemperature, shedStepId }` triple on each
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
  | { kind: 'set_step' };

export type ShedIntentBehaviorInput = {
  action: 'turn_off' | 'set_temperature' | 'set_step';
  temperature: number | null;
  stepId: string | null;
};

export type ShedIntentResolveInput = {
  shedBehavior: ShedIntentBehaviorInput;
  controllable: boolean;
  hasBinaryControl?: boolean;
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  primaryTarget?: TargetCapabilitySnapshot | null;
};

const isSteppedLoadDeviceShape = (input: ShedIntentResolveInput): boolean => (
  input.controlModel === 'stepped_load'
  && input.steppedLoadProfile?.model === 'stepped_load'
);

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
      return { kind: 'set_step' };
    }
    if (hasBinaryControl === false) {
      return { kind: 'set_step' };
    }
  }
  return { kind: 'turn_off' };
};
