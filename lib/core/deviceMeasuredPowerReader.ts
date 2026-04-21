import type { DeviceCapabilityMap } from './deviceManagerControl';
import type { LiveDevicePowerWatts } from './deviceManagerEnergy';
import { getCapabilityValueByPrefix } from './deviceManagerParse';

export type DeviceMeasuredPowerObservation = {
  measurePowerW?: number;
  measurePowerObservedAtMs?: number;
  meterPowerKwh?: number;
  meterPowerObservedAtMs?: number;
  homeyEnergyLiveW?: number;
  homeyEnergyObservedAtMs?: number;
};

export function readDeviceMeasuredPowerObservation(params: {
  deviceId: string;
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  livePowerWByDeviceId?: LiveDevicePowerWatts;
  homeyEnergyObservedAtMs?: number;
}): DeviceMeasuredPowerObservation {
  const {
    deviceId,
    capabilities,
    capabilityObj,
    livePowerWByDeviceId = {},
    homeyEnergyObservedAtMs,
  } = params;
  const measurePower = readFiniteCapabilityByPrefix(capabilities, capabilityObj, 'measure_power');
  const meterPower = readFiniteCapabilityByPrefix(capabilities, capabilityObj, 'meter_power');
  const homeyEnergyLiveW = toFiniteNumber(livePowerWByDeviceId[deviceId]);
  return {
    measurePowerW: measurePower.value,
    measurePowerObservedAtMs: measurePower.observedAtMs,
    meterPowerKwh: meterPower.value,
    meterPowerObservedAtMs: meterPower.observedAtMs,
    homeyEnergyLiveW,
    homeyEnergyObservedAtMs: homeyEnergyLiveW !== undefined ? homeyEnergyObservedAtMs : undefined,
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readFiniteCapabilityByPrefix(
  capabilities: string[],
  capabilityObj: DeviceCapabilityMap,
  prefix: 'measure_power' | 'meter_power',
): { value?: number; observedAtMs?: number } {
  const value = toFiniteNumber(getCapabilityValueByPrefix(capabilities, capabilityObj, prefix));
  const capabilityId = resolveCapabilityIdByPrefix(capabilities, prefix);
  return {
    value,
    observedAtMs: capabilityId ? toTimestampMs(capabilityObj[capabilityId]?.lastUpdated) : undefined,
  };
}

function resolveCapabilityIdByPrefix(
  capabilities: string[],
  prefix: 'measure_power' | 'meter_power',
): string | undefined {
  if (capabilities.includes(prefix)) {
    return prefix;
  }
  return capabilities.find((capabilityId) => capabilityId.startsWith(`${prefix}.`));
}

function toTimestampMs(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
