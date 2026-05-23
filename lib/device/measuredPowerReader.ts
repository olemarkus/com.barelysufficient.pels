import type { DeviceCapabilityMap } from './managerControl';
import type { LiveDevicePowerWatts } from './managerEnergy';
import {
  getExactPowerCapabilityValue,
  type PowerCapabilityId,
} from './managerParse';

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
  const measurePower = readFinitePowerCapability(capabilities, capabilityObj, 'measure_power');
  const meterPower = readFinitePowerCapability(capabilities, capabilityObj, 'meter_power');
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

function readFinitePowerCapability(
  capabilities: readonly string[],
  capabilityObj: DeviceCapabilityMap,
  capabilityId: PowerCapabilityId,
): { value?: number; observedAtMs?: number } {
  const value = toFiniteNumber(getExactPowerCapabilityValue(capabilities, capabilityObj, capabilityId));
  return {
    value,
    observedAtMs: capabilities.includes(capabilityId)
      ? toTimestampMs(capabilityObj[capabilityId]?.lastUpdated)
      : undefined,
  };
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
