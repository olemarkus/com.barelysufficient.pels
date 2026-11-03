import type {
  HeatingShadowDay, HeatingShadowDevice, HeatingShadowDeviceDay, HeatingShadowInterval,
  HeatingShadowOutdoorPoint, HeatingShadowReading, HeatingShadowSignal, HeatingShadowState,
  HeatingShadowWindow,
} from '../../packages/contracts/src/heatingShadow';
import {
  getDateKeyInTimeZone, getDateKeyStartMs, shiftDateKey,
} from '../../packages/shared-domain/src/utils/dateUtils';

export const HEATING_SHADOW_INTERVAL_MS = 15 * 60_000;
export const HEATING_SHADOW_MAX_GAP_MS = 5 * 60_000;
export const HEATING_SHADOW_COMPLETED_DAYS = 2;
export const HEATING_SHADOW_MAX_SELECTED_DEVICES = 16;
export const HEATING_SHADOW_MAX_ELIGIBLE_DEVICES = 64;
export const HEATING_SHADOW_MAX_INTERVALS = 128;
export const HEATING_SHADOW_MAX_CHANGES = 256;
export const HEATING_SHADOW_MAX_OUTDOOR_POINTS = 256;
export const HEATING_SHADOW_POWER_CHANGE_KW = 0.1;

const TARGET_CHANGED = 1;
const OBSERVED_OFF = 2;
const CONTROL_UNOBSERVED = 4;
const PARTIAL_WINDOW = 8;

function controlFlags(reading: HeatingShadowReading): number {
  if (reading.control === 'disabled') return OBSERVED_OFF;
  return reading.control === 'unobserved' ? CONTROL_UNOBSERVED : 0;
}

function freshWindow(reading: HeatingShadowReading): HeatingShadowWindow {
  return { start: reading, last: reading, inputKWh: 0, temperatureIntegralCHours: 0,
    flags: controlFlags(reading), observations: 1, maximumGapMs: 0 };
}

function freshDevice(device: HeatingShadowDevice): HeatingShadowDeviceDay {
  return { signal: { ...device.signal }, intervals: [], changes: [device.reading], window: freshWindow(device.reading),
    omittedIntervals: 0, omittedChanges: 0, interruptions: 0, signalChanged: false };
}

function freshDay(dateKey: string, timeZone: string): HeatingShadowDay {
  return { dateKey, startMs: getDateKeyStartMs(dateKey, timeZone),
    endMs: getDateKeyStartMs(shiftDateKey(dateKey, 1), timeZone), devices: {}, eligibleDeviceIds: [],
    eligibleIdsTruncated: false, outdoor: [], omittedOutdoorPoints: 0 };
}

function sameSignal(left: HeatingShadowSignal, right: HeatingShadowSignal): boolean {
  return left.temperatureCapability === right.temperatureCapability && left.temperatureRole === right.temperatureRole
    && left.targetCapability === right.targetCapability && left.electricalInput === right.electricalInput;
}

function closeWindow(device: HeatingShadowDeviceDay, partial: boolean): HeatingShadowDeviceDay {
  const { window, ...closed } = device;
  if (!window || window.last.atMs <= window.start.atMs) return closed;
  const hours = (window.last.atMs - window.start.atMs) / 3_600_000;
  const interval: HeatingShadowInterval = {
    startMs: window.start.atMs, endMs: window.last.atMs,
    startTemperatureC: window.start.temperatureC, endTemperatureC: window.last.temperatureC,
    meanTemperatureC: window.temperatureIntegralCHours / hours, inputKWh: window.inputKWh,
    targetC: window.start.targetC, flags: window.flags | (partial ? PARTIAL_WINDOW : 0),
    observations: window.observations, maximumGapMs: window.maximumGapMs,
  };
  const intervals = [...closed.intervals, interval];
  return { ...closed, intervals: intervals.slice(-HEATING_SHADOW_MAX_INTERVALS),
    omittedIntervals: closed.omittedIntervals + Math.max(0, intervals.length - HEATING_SHADOW_MAX_INTERVALS) };
}

function interruptDevice(device: HeatingShadowDeviceDay): HeatingShadowDeviceDay {
  return device.window ? { ...closeWindow(device, true), interruptions: device.interruptions + 1 } : device;
}

function recordChange(
  device: HeatingShadowDeviceDay, reading: HeatingShadowReading, previous?: HeatingShadowReading,
): HeatingShadowDeviceDay {
  const powerReference = device.changes.at(-1)?.powerKw ?? previous?.powerKw;
  const changed = !previous || reading.targetC !== previous.targetC || reading.control !== previous.control
    || (reading.powerKw === 0) !== (previous.powerKw === 0)
    || powerReference !== undefined
      && Math.abs(reading.powerKw - powerReference) >= HEATING_SHADOW_POWER_CHANGE_KW - 1e-12;
  if (!changed) return device;
  const changes = [...device.changes, reading];
  return { ...device, changes: changes.slice(-HEATING_SHADOW_MAX_CHANGES),
    omittedChanges: device.omittedChanges + Math.max(0, changes.length - HEATING_SHADOW_MAX_CHANGES) };
}

function extendDevice(device: HeatingShadowDeviceDay, reading: HeatingShadowReading): HeatingShadowDeviceDay {
  const previous = device.window;
  if (!previous) return { ...recordChange(device, reading), window: freshWindow(reading) };
  if (reading.atMs <= previous.last.atMs) return device;
  const gapMs = reading.atMs - previous.last.atMs;
  if (gapMs > HEATING_SHADOW_MAX_GAP_MS) {
    return { ...recordChange(interruptDevice(device), reading), window: freshWindow(reading) };
  }
  const window: HeatingShadowWindow = {
    ...previous, last: reading,
    inputKWh: previous.inputKWh + previous.last.powerKw * gapMs / 3_600_000,
    temperatureIntegralCHours: previous.temperatureIntegralCHours
      + (previous.last.temperatureC + reading.temperatureC) / 2 * gapMs / 3_600_000,
    flags: previous.flags | controlFlags(reading) | (reading.targetC !== previous.start.targetC ? TARGET_CHANGED : 0),
    observations: previous.observations + 1, maximumGapMs: Math.max(previous.maximumGapMs, gapMs),
  };
  const sampled = { ...recordChange(device, reading, previous.last), window };
  return reading.atMs - window.start.atMs < HEATING_SHADOW_INTERVAL_MS
    ? sampled : { ...closeWindow(sampled, false), window: freshWindow(reading) };
}

function recordDevice(device: HeatingShadowDeviceDay, source: HeatingShadowDevice): HeatingShadowDeviceDay {
  if (device.signalChanged) return device;
  if (!sameSignal(device.signal, source.signal)) return { ...closeWindow(device, true), signalChanged: true };
  return extendDevice(device, source.reading);
}

/** Collection and whole-device report selection share one calendar rotation. */
export function orderHeatingShadowDeviceIds(ids: readonly string[], dateKey: string): string[] {
  if (ids.length === 0) return [];
  const ordered = [...ids].sort();
  const ordinal = Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 86_400_000);
  const offset = ordinal % ordered.length;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)];
}

function selectDevices(day: HeatingShadowDay, devices: readonly HeatingShadowDevice[]): HeatingShadowDay {
  const ids = [...new Set(devices.map((device) => device.id))].sort();
  const newlyEligible = ids.filter((id) => !day.eligibleDeviceIds.includes(id));
  const eligibleDeviceIds = [...day.eligibleDeviceIds,
    ...newlyEligible.slice(0, HEATING_SHADOW_MAX_ELIGIBLE_DEVICES - day.eligibleDeviceIds.length)].sort();
  const sources = new Map(devices.map((device) => [device.id, device]));
  let selected = { ...day.devices };
  for (const id of orderHeatingShadowDeviceIds(eligibleDeviceIds, day.dateKey)) {
    if (Object.keys(selected).length >= HEATING_SHADOW_MAX_SELECTED_DEVICES) break;
    const source = sources.get(id);
    if (!Object.hasOwn(selected, id) && source) selected = { ...selected, [id]: freshDevice(source) };
  }
  return { ...day, devices: selected, eligibleDeviceIds,
    eligibleIdsTruncated: day.eligibleIdsTruncated
      || newlyEligible.length + day.eligibleDeviceIds.length > HEATING_SHADOW_MAX_ELIGIBLE_DEVICES };
}

function sameOutdoor(left: HeatingShadowOutdoorPoint, right: HeatingShadowOutdoorPoint): boolean {
  return left.state === right.state && (left.state === 'unavailable'
    || right.state === 'available' && left.temperatureC === right.temperatureC);
}

function recordOutdoor(day: HeatingShadowDay, nowMs: number, temperatureC: number | undefined): HeatingShadowDay {
  const point: HeatingShadowOutdoorPoint = temperatureC === undefined
    ? { atMs: nowMs, state: 'unavailable' } : { atMs: nowMs, state: 'available', temperatureC };
  const previous = day.outdoor.at(-1);
  if (previous && (point.atMs <= previous.atMs || sameOutdoor(previous, point))) return day;
  const outdoor = [...day.outdoor, point];
  return { ...day, outdoor: outdoor.slice(-HEATING_SHADOW_MAX_OUTDOOR_POINTS),
    omittedOutdoorPoints: day.omittedOutdoorPoints + Math.max(0, outdoor.length - HEATING_SHADOW_MAX_OUTDOOR_POINTS) };
}

function latestTimestamp(state: HeatingShadowState): number {
  const day = state.days.at(-1);
  if (!day) return 0;
  return Math.max(day.startMs, day.outdoor.at(-1)?.atMs ?? 0,
    ...Object.values(day.devices).map((device) => Math.max(device.window?.last.atMs ?? 0,
      device.intervals.at(-1)?.endMs ?? 0, device.changes.at(-1)?.atMs ?? 0)));
}

/** Passive held-value collection; missing devices interrupt evidence rather than implying zero input. */
export function recordHeatingShadow(
  before: HeatingShadowState | undefined,
  devices: readonly HeatingShadowDevice[],
  nowMs: number,
  outdoorTemperatureC: number | undefined,
  timeZone: string,
): HeatingShadowState {
  // A corrected wall clock starts a new chronology; future-dated evidence must not freeze collection.
  const previous = before?.timeZone === timeZone && nowMs >= latestTimestamp(before) ? before : undefined;
  if (previous && nowMs === latestTimestamp(previous)) return previous;
  const dateKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const cutoff = shiftDateKey(dateKey, -HEATING_SHADOW_COMPLETED_DAYS);
  const retained = (previous?.days ?? []).filter((day) => day.dateKey >= cutoff && day.dateKey <= dateKey);
  const completed = retained.filter((day) => day.dateKey < dateKey).map((day) => ({ ...day,
    devices: Object.fromEntries(Object.entries(day.devices).map(([id, device]) => [id, closeWindow(device, true)])),
  }));
  const today = retained.find((day) => day.dateKey === dateKey) ?? freshDay(dateKey, timeZone);
  const available = devices.filter((device) => device.reading.atMs >= today.startMs
    && device.reading.atMs < today.endMs && device.reading.atMs <= nowMs);
  const selected = selectDevices(today, available);
  const sources = new Map(available.map((device) => [device.id, device]));
  const sampled = { ...selected, devices: Object.fromEntries(Object.entries(selected.devices)
    .map(([id, device]) => [id, sources.has(id) ? recordDevice(device, sources.get(id)!) : interruptDevice(device)])) };
  return { version: 1, timeZone, days: [...completed, recordOutdoor(sampled, nowMs, outdoorTemperatureC)] };
}
