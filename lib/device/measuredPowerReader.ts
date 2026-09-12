import type { DeviceCapabilityMap } from './managerControl';
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

export type DeviceMeasuredPowerObservation = {
  measurePowerW?: number;
  measurePowerObservedAtMs?: number;
  meterEnergy?: MeterEnergyReading;
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
    meterEnergy: toMeterEnergyReading(meterPower),
    homeyEnergyLiveW,
    homeyEnergyObservedAtMs: homeyEnergyLiveW !== undefined ? homeyEnergyObservedAtMs : undefined,
  };
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
      ? toTimestampMs(capabilityObj[capabilityId]?.lastUpdated)
      : undefined,
  };
}

// The ECMAScript time-value range: a `Date` can represent |t| <= 8.64e15 ms and
// nothing beyond it. A number outside that range is not a date, so it is not a
// stamp — and bounding it HERE, at the boundary, is what lets every consumer
// subtract two accepted stamps without the difference overflowing to Infinity.
// The `Date` and string branches are in range by construction (`getTime` and
// `Date.parse` answer NaN otherwise); only a raw number needs the check.
const MAX_TIME_VALUE_MS = 8.64e15;

const isTimeValue = (value: number): boolean => (
  Number.isFinite(value) && Math.abs(value) <= MAX_TIME_VALUE_MS
);

function toTimestampMs(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value === 'number' && isTimeValue(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
