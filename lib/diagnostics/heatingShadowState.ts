import type {
  HeatingShadowDay, HeatingShadowDeviceDay, HeatingShadowInterval, HeatingShadowOutdoorPoint,
  HeatingShadowReading, HeatingShadowSignal, HeatingShadowState, HeatingShadowWindow,
} from './heatingShadowTypes';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import {
  getDateKeyStartMs, isCalendarDateKey, shiftDateKey,
} from '../../packages/shared-domain/src/utils/dateUtils';
import {
  HEATING_SHADOW_COMPLETED_DAYS, HEATING_SHADOW_INTERVAL_MS, HEATING_SHADOW_MAX_CHANGES,
  HEATING_SHADOW_MAX_ELIGIBLE_DEVICES, HEATING_SHADOW_MAX_GAP_MS, HEATING_SHADOW_MAX_INTERVALS,
  HEATING_SHADOW_MAX_OUTDOOR_POINTS, HEATING_SHADOW_MAX_SELECTED_DEVICES,
} from './heatingShadow';

const count = (value: unknown): value is number => isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
const instant = (value: unknown): value is number => isFiniteNumber(value) && value > 0;
const nonnegative = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;
const flags = (value: unknown): value is number => count(value) && value <= 15;

function boundedArray<T>(
  value: unknown, maximum: number, accepts: (entry: unknown) => entry is T,
): value is T[] {
  return Array.isArray(value) && value.length <= maximum && value.every(accepts);
}

const samplingCoverage = (value: Record<string, unknown>, minimumObservations: number): boolean => (
  count(value.observations) && value.observations >= minimumObservations
  && nonnegative(value.maximumGapMs) && value.maximumGapMs <= HEATING_SHADOW_MAX_GAP_MS
);

const signal = (value: unknown): value is HeatingShadowSignal => isUnknownRecord(value)
  && value.temperatureCapability === 'measure_temperature' && value.temperatureRole === 'unclassified'
  && typeof value.targetCapability === 'string' && value.targetCapability.length > 0
  && value.electricalInput === 'held_reported_direct_power';

const reading = (value: unknown): value is HeatingShadowReading => isUnknownRecord(value)
  && instant(value.atMs) && isFiniteNumber(value.temperatureC) && nonnegative(value.powerKw)
  && isFiniteNumber(value.targetC)
  && (value.control === 'enabled' || value.control === 'disabled' || value.control === 'unobserved');

const window = (value: unknown): value is HeatingShadowWindow => isUnknownRecord(value)
  && reading(value.start) && reading(value.last) && value.start.atMs <= value.last.atMs
  && value.last.atMs - value.start.atMs < HEATING_SHADOW_INTERVAL_MS
  && nonnegative(value.inputKWh) && isFiniteNumber(value.temperatureIntegralCHours) && flags(value.flags)
  && samplingCoverage(value, 1);

const interval = (value: unknown): value is HeatingShadowInterval => isUnknownRecord(value)
  && instant(value.startMs) && instant(value.endMs) && value.startMs < value.endMs
  && value.endMs - value.startMs <= HEATING_SHADOW_INTERVAL_MS + HEATING_SHADOW_MAX_GAP_MS
  && isFiniteNumber(value.startTemperatureC) && isFiniteNumber(value.endTemperatureC)
  && isFiniteNumber(value.meanTemperatureC) && nonnegative(value.inputKWh) && isFiniteNumber(value.targetC)
  && flags(value.flags) && ((value.flags & 8) !== 0 || value.endMs - value.startMs >= HEATING_SHADOW_INTERVAL_MS)
  && samplingCoverage(value, 2);

const outdoor = (value: unknown): value is HeatingShadowOutdoorPoint => isUnknownRecord(value)
  && instant(value.atMs) && (value.state === 'available' && isFiniteNumber(value.temperatureC)
    || value.state === 'unavailable' && value.temperatureC === undefined);

export {
  interval as isHeatingShadowInterval, reading as isHeatingShadowReading,
  window as isHeatingShadowWindow, outdoor as isHeatingShadowOutdoorPoint,
};

function ordered<T>(rows: readonly T[], starts: (row: T) => number, ends = starts): boolean {
  return rows.every((row, index) => index === 0 || starts(row) >= ends(rows[index - 1]!));
}

function orderedPoints<T>(rows: readonly T[], atMs: (row: T) => number): boolean {
  return rows.every((row, index) => index === 0 || atMs(row) > atMs(rows[index - 1]!));
}

const withinDay = (atMs: number, startMs: number, endMs: number): boolean => atMs >= startMs && atMs < endMs;

type DeviceDayShape = Omit<HeatingShadowDeviceDay, 'window'> & { window?: unknown };

const deviceDayShape = (value: unknown): value is DeviceDayShape => isUnknownRecord(value)
  && signal(value.signal) && boundedArray(value.intervals, HEATING_SHADOW_MAX_INTERVALS, interval)
  && boundedArray(value.changes, HEATING_SHADOW_MAX_CHANGES, reading)
  && count(value.omittedIntervals) && count(value.omittedChanges)
  && count(value.interruptions) && typeof value.signalChanged === 'boolean';

function deviceHistory(value: DeviceDayShape, startMs: number, endMs: number): boolean {
  return ordered(value.intervals, (row) => row.startMs, (row) => row.endMs)
    && orderedPoints(value.changes, (row) => row.atMs)
    && value.intervals.every((row) => withinDay(row.startMs, startMs, endMs) && withinDay(row.endMs, startMs, endMs))
    && value.changes.every((row) => withinDay(row.atMs, startMs, endMs));
}

function deviceWindow(value: DeviceDayShape, startMs: number, endMs: number): boolean {
  if (value.window === undefined) return true;
  return !value.signalChanged && window(value.window)
    && withinDay(value.window.start.atMs, startMs, endMs) && withinDay(value.window.last.atMs, startMs, endMs)
    && (value.intervals.length === 0 || value.window.start.atMs >= value.intervals.at(-1)!.endMs);
}

const deviceDay = (value: unknown, startMs: number, endMs: number): value is HeatingShadowDeviceDay => (
  deviceDayShape(value) && deviceHistory(value, startMs, endMs) && deviceWindow(value, startMs, endMs)
);

type DayShape = Omit<HeatingShadowDay, 'devices'> & { devices: Record<string, unknown> };
const eligibleId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const dayShape = (value: unknown): value is DayShape => isUnknownRecord(value)
  && isCalendarDateKey(value.dateKey) && instant(value.startMs) && instant(value.endMs) && value.startMs < value.endMs
  && isUnknownRecord(value.devices) && Object.keys(value.devices).length <= HEATING_SHADOW_MAX_SELECTED_DEVICES
  && boundedArray(value.eligibleDeviceIds, HEATING_SHADOW_MAX_ELIGIBLE_DEVICES, eligibleId)
  && new Set(value.eligibleDeviceIds).size === value.eligibleDeviceIds.length
  && typeof value.eligibleIdsTruncated === 'boolean'
  && boundedArray(value.outdoor, HEATING_SHADOW_MAX_OUTDOOR_POINTS, outdoor) && count(value.omittedOutdoorPoints);

function day(value: unknown, timeZone: string): value is HeatingShadowDay {
  if (!dayShape(value)) return false;
  const { startMs, endMs, eligibleDeviceIds } = value;
  return startMs === getDateKeyStartMs(value.dateKey, timeZone)
    && endMs === getDateKeyStartMs(shiftDateKey(value.dateKey, 1), timeZone)
    && Object.entries(value.devices).every(([id, device]) => eligibleDeviceIds.includes(id)
      && deviceDay(device, startMs, endMs))
    && orderedPoints(value.outdoor, (row) => row.atMs)
    && value.outdoor.every((row) => withinDay(row.atMs, startMs, endMs));
}

/** Persisted-boundary validation of the stored observations (`heatingShadowStore.ts`). */
export function isHeatingShadowState(value: unknown): value is HeatingShadowState {
  if (!isUnknownRecord(value) || value.version !== 1 || typeof value.timeZone !== 'string'
    || !Array.isArray(value.days) || value.days.length > HEATING_SHADOW_COMPLETED_DAYS + 1) return false;
  const timeZone = value.timeZone;
  const days = value.days;
  try {
    Intl.DateTimeFormat('en', { timeZone }).resolvedOptions();
    if (!days.every((entry): entry is HeatingShadowDay => day(entry, timeZone))) return false;
    return ordered(days, (entry) => entry.startMs, (entry) => entry.endMs)
      && new Set(days.map((entry) => entry.dateKey)).size === days.length;
  } catch {
    return false;
  }
}
