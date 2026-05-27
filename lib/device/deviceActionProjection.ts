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
import { isFiniteNumber } from '../utils/appTypeGuards';
import { hasTemperatureBoostTarget } from '../utils/temperatureBoost';

// Trust-gate logic intentionally duplicated from
// `lib/observer/observationTrust.ts` to satisfy the
// `no-device-to-peer-except-power` layering rule: lib/device/ cannot
// consume lib/observer/. The duplication is bounded and intentional;
// see CLAUDE.md "Accept code duplication if consolidation would violate
// an architectural boundary." A later chunk of the planner-detype
// refactor may collapse the two copies once a producer-layer home for
// trust gates is decided.

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

const isObservationTrusted = (device: ObservationFreshness): boolean => (
  device.observationStale !== true
);

const getTrustedTemperatureC = (
  device: ObservationFreshness & { currentTemperature?: number },
): number | undefined => {
  if (!isObservationTrusted(device)) return undefined;
  const temperature = device.currentTemperature;
  if (!isFiniteNumber(temperature)) return undefined;
  return temperature;
};

const getTrustedStateOfChargeSnapshot = (
  device: ObservationFreshness & { stateOfCharge?: DeviceStateOfChargeSnapshot },
): DeviceStateOfChargeSnapshot | undefined => {
  if (!isObservationTrusted(device)) return undefined;
  const stateOfCharge = device.stateOfCharge;
  if (!stateOfCharge || stateOfCharge.status !== 'fresh') return undefined;
  if (!isFiniteNumber(stateOfCharge.percent)) return undefined;
  return stateOfCharge;
};

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
  const stateOfCharge = getTrustedStateOfChargeSnapshot(dev);
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
  const currentTemperature = getTrustedTemperatureC(dev);
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
  if (snapshot.evChargingState === undefined) return 'charger state unknown';

  switch (snapshot.evChargingState) {
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return null;
    case 'plugged_in':
      return 'charger is not resumable';
    case 'plugged_out':
      return 'charger is unplugged';
    case 'plugged_in_discharging':
      return 'charger is discharging';
    default:
      return `unknown charging state '${snapshot.evChargingState}'`;
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
