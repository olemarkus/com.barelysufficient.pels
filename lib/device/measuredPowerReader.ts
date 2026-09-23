import { toCapabilityTimestampMs, type DeviceCapabilityMap } from './managerControl';
import type { LiveDevicePowerWatts } from './managerEnergy';
import {
  getExactPowerCapabilityValue,
  type PowerCapabilityId,
} from './transport/managerParse';

/**
 * One cumulative energy reading placed on the device's own clock. A rate is
 * only ever derived from two of these, so a meter value with no stamp is not a
 * reading at all — the reader resolves that to absence here rather than handing
 * the resolver two optionals to reassemble.
 */
export type MeterEnergyReading = {
  kwh: number;
  observedAtMs: number;
};

/** One direct watt reading, placed on the clock of the source that reported it. */
export type DirectPowerReading = {
  watts: number;
  observedAtMs: number;
};

export type DeviceMeasuredPowerObservation = {
  measurePower?: DirectPowerReading;
  meterEnergy?: MeterEnergyReading;
  homeyEnergyLive?: DirectPowerReading;
};

export function readDeviceMeasuredPowerObservation(params: {
  deviceId: string;
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  livePowerWByDeviceId?: LiveDevicePowerWatts;
  homeyEnergyObservedAtMs: number;
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
    measurePower: toDirectPowerReading(measurePower),
    meterEnergy: toMeterEnergyReading(meterPower),
    homeyEnergyLive: homeyEnergyLiveW === undefined
      ? undefined
      : { watts: homeyEnergyLiveW, observedAtMs: homeyEnergyObservedAtMs },
  };
}

// A watt value is a reading only with the stamp that places it; the device-read
// contract guarantees a conforming read carries both.
function toDirectPowerReading(
  read: { value?: number; observedAtMs?: number },
): DirectPowerReading | undefined {
  return read.value !== undefined && read.observedAtMs !== undefined
    ? { watts: read.value, observedAtMs: read.observedAtMs }
    : undefined;
}

// The producer-side classification: a finite, non-negative value AND a
// parseable stamp make a reading; anything less is absence. This is the one
// place the halves are looked at together.
//
// Non-negative is the same rule `normalizeMeasuredPowerKw` applies to a direct
// watt reading, and it matters more here: a cumulative meter is non-negative by
// definition, and holding both operands in [0, MAX] is what keeps the resolver's
// `kwh - previous.kwh` finite without a check of its own.
function toMeterEnergyReading(
  read: { value?: number; observedAtMs?: number },
): MeterEnergyReading | undefined {
  return read.value !== undefined && read.value >= 0 && read.observedAtMs !== undefined
    ? { kwh: read.value, observedAtMs: read.observedAtMs }
    : undefined;
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
      ? toCapabilityTimestampMs(capabilityObj[capabilityId]?.lastUpdated)
      : undefined,
  };
}

