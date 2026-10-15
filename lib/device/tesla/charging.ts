import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { isTeslaChargingDevice } from './identity';

const TESLA_CHARGING_STATES = new Set([
  'Disconnected', 'Calibrating', 'Starting', 'Charging', 'Stopped', 'Complete', 'NoPower', 'Unknown',
]);

export function isTeslaChargingState(value: unknown): value is string {
  return typeof value === 'string' && TESLA_CHARGING_STATES.has(value);
}

/** Valid vendor evidence can revoke control without asserting a Homey plug state. */
export function hasTeslaChargingStateWithoutEvProjection(device: HomeyDeviceLike): boolean {
  const state = device.capabilitiesObj?.charging_state?.value;
  return isTeslaChargingDevice(device) && isTeslaChargingState(state)
    && resolveTeslaChargingState(state) === undefined;
}

export function resolveTeslaChargingState(value: unknown): string | undefined {
  switch (value) {
    case 'Disconnected': return 'plugged_out';
    case 'Charging': return 'plugged_in_charging';
    case 'Starting': case 'Stopped': return 'plugged_in_paused';
    case 'Complete': return 'plugged_in';
    default: return undefined;
  }
}

export function teslaChargingCapabilities(
  device: HomeyDeviceLike, capabilityObj: DeviceCapabilityMap,
): DeviceCapabilityMap {
  if (!isTeslaChargingDevice(device)) return capabilityObj;
  const currentPower = capabilityObj.measure_charge_power;
  const confirmedCurrent = confirmedTeslaCurrent(capabilityObj);
  return {
    ...capabilityObj,
    ...(confirmedCurrent ? { available_installation_current: confirmedCurrent } : {}),
    evcharger_charging: { ...capabilityObj.charging_on, setable: true },
    evcharger_charging_state: {
      ...capabilityObj.charging_state, value: resolveTeslaChargingState(capabilityObj.charging_state?.value),
    },
    measure_power: {
      ...currentPower,
      value: typeof currentPower?.value === 'number' ? currentPower.value * 1000 : undefined,
    },
  };
}

/**
 * Resolve the configured current, never measured draw. While stopped, the
 * Tesla app publishes the limit after its vehicle command succeeds; that is
 * preparation evidence even when unchanged zero measurements retain their
 * timestamps. The binary axis still says off. While running, require fresh
 * measurements as well so a limit echo cannot settle a power adjustment.
 */
export function confirmedTeslaCurrent(
  capabilities: Readonly<Partial<DeviceCapabilityMap>>,
): DeviceCapabilityMap[string] | undefined {
  const limit = readDatedNumber(capabilities.measure_charge_current_max, 32);
  const actual = readDatedNumber(capabilities.measure_charge_current, 32);
  const power = readDatedNumber(capabilities.measure_charge_power, Number.POSITIVE_INFINITY);
  if (limit && actual?.value === 0 && power?.value === 0
    && hasStoppedChargingState(capabilities)) {
    return { value: limit.value, lastUpdated: new Date(limit.at).toISOString(), setable: false };
  }
  if (!limit || !actual || !power || actual.value > limit.value || actual.at < limit.at || power.at < limit.at) {
    return undefined;
  }
  return { value: limit.value, lastUpdated: new Date(Math.min(actual.at, power.at)).toISOString(), setable: false };
}

function hasStoppedChargingState(capabilities: Readonly<Partial<DeviceCapabilityMap>>): boolean {
  return capabilities.charging_on?.value === false && capabilities.charging_state?.value === 'Stopped'
    && toCapabilityTimestampMs(capabilities.charging_on.lastUpdated) !== undefined
    && toCapabilityTimestampMs(capabilities.charging_state.lastUpdated) !== undefined;
}

function readDatedNumber(capability: DeviceCapabilityMap[string] | undefined, max: number) {
  const value = capability?.value;
  const at = toCapabilityTimestampMs(capability?.lastUpdated);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || at === undefined) {
    return undefined;
  }
  return { value, at };
}

export function normalizeTeslaChargingUpdate(capabilityId: string, value: unknown) {
  if (capabilityId === 'charging_on' && typeof value === 'boolean') {
    return [{ capabilityId: 'evcharger_charging', value }];
  }
  if (capabilityId === 'charging_state') {
    const state = resolveTeslaChargingState(value);
    return state ? [{ capabilityId: 'evcharger_charging_state', value: state }] : [];
  }
  if (capabilityId === 'measure_charge_power' && typeof value === 'number') {
    return [{ capabilityId: 'measure_power', value: value * 1000 }];
  }
  return [{ capabilityId, value }];
}

export function hasTeslaChargingSurface(snapshot: { capabilities?: readonly string[] }): boolean {
  return snapshot.capabilities?.includes('charging_on') === true;
}
