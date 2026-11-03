import type {
  HeatingShadowDay, HeatingShadowDeviceDay, HeatingShadowInterval, HeatingShadowOutdoorPoint,
  HeatingShadowReading, HeatingShadowSignal, HeatingShadowState,
} from './heatingShadowTypes';
import { shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';
import {
  HEATING_SHADOW_COMPLETED_DAYS, HEATING_SHADOW_MAX_CHANGES, HEATING_SHADOW_MAX_ELIGIBLE_DEVICES,
  HEATING_SHADOW_MAX_INTERVALS, HEATING_SHADOW_MAX_OUTDOOR_POINTS, HEATING_SHADOW_MAX_SELECTED_DEVICES,
  orderHeatingShadowDeviceIds,
} from './heatingShadow';

const PARTIAL_WINDOW = 8;

const intervalKey = (row: HeatingShadowInterval): string => JSON.stringify([
  row.startMs, row.endMs, row.startTemperatureC, row.endTemperatureC, row.meanTemperatureC,
  row.inputKWh, row.targetC, row.flags, row.observations, row.maximumGapMs,
]);
const readingKey = (row: HeatingShadowReading): string => JSON.stringify([
  row.atMs, row.temperatureC, row.powerKw, row.targetC, row.control,
]);
const outdoorKey = (row: HeatingShadowOutdoorPoint): string => JSON.stringify([
  row.atMs, row.state, row.state === 'available' ? row.temperatureC : null,
]);

function sameSignal(left: HeatingShadowSignal, right: HeatingShadowSignal): boolean {
  return left.temperatureCapability === right.temperatureCapability && left.temperatureRole === right.temperatureRole
    && left.targetCapability === right.targetCapability && left.electricalInput === right.electricalInput;
}

function firstDeviceObservation(device: HeatingShadowDeviceDay): number {
  return Math.min(device.intervals[0]?.startMs ?? Infinity, device.changes[0]?.atMs ?? Infinity,
    device.window?.start.atMs ?? Infinity);
}

function firstDayObservation(day: HeatingShadowDay): number {
  return Math.min(day.outdoor[0]?.atMs ?? Infinity,
    ...Object.values(day.devices).map(firstDeviceObservation));
}

function lastDayObservation(day: HeatingShadowDay): number {
  return Math.max(day.startMs, day.outdoor.at(-1)?.atMs ?? 0,
    ...Object.values(day.devices).map((device) => Math.max(device.intervals.at(-1)?.endMs ?? 0,
      device.changes.at(-1)?.atMs ?? 0, device.window?.last.atMs ?? 0)));
}

/** Hydration cannot join an unobserved restart interval onto a live window. */
function sealWindow(device: HeatingShadowDeviceDay): HeatingShadowDeviceDay {
  const { window, ...closed } = device;
  if (!window) return closed;
  const interrupted = { ...closed, interruptions: closed.interruptions + 1 };
  if (window.last.atMs <= window.start.atMs) return interrupted;
  const hours = (window.last.atMs - window.start.atMs) / 3_600_000;
  return { ...interrupted, intervals: [...closed.intervals, {
    startMs: window.start.atMs, endMs: window.last.atMs,
    startTemperatureC: window.start.temperatureC, endTemperatureC: window.last.temperatureC,
    meanTemperatureC: window.temperatureIntegralCHours / hours, inputKWh: window.inputKWh,
    targetC: window.start.targetC, flags: window.flags | PARTIAL_WINDOW,
    observations: window.observations, maximumGapMs: window.maximumGapMs,
  }] };
}

function mergeIntervals(current: HeatingShadowDeviceDay, stored: HeatingShadowDeviceDay): HeatingShadowDeviceDay {
  const currentKeys = new Set(current.intervals.map(intervalKey));
  const older = stored.intervals.filter((row) => !currentKeys.has(intervalKey(row))
    && row.endMs <= (current.window?.start.atMs ?? Infinity)
    && !current.intervals.some((active) => row.startMs < active.endMs && active.startMs < row.endMs));
  const intervals = [...older, ...current.intervals].sort((left, right) => left.startMs - right.startMs)
    .slice(-HEATING_SHADOW_MAX_INTERVALS);
  const retained = new Set(intervals.map(intervalKey));
  return { ...current, intervals, omittedIntervals: Math.max(
    current.omittedIntervals + current.intervals.filter((row) => !retained.has(intervalKey(row))).length,
    stored.omittedIntervals + stored.intervals.filter((row) => !retained.has(intervalKey(row))).length,
  ) };
}

function mergeChanges(current: HeatingShadowDeviceDay, stored: HeatingShadowDeviceDay): HeatingShadowDeviceDay {
  const currentKeys = new Set(current.changes.map(readingKey));
  const firstCurrent = firstDeviceObservation(current);
  const older = stored.changes.filter((row) => !currentKeys.has(readingKey(row)) && row.atMs < firstCurrent);
  const changes = [...older, ...current.changes].sort((left, right) => left.atMs - right.atMs)
    .slice(-HEATING_SHADOW_MAX_CHANGES);
  const retained = new Set(changes.map(readingKey));
  return { ...current, changes, omittedChanges: Math.max(
    current.omittedChanges + current.changes.filter((row) => !retained.has(readingKey(row))).length,
    stored.omittedChanges + stored.changes.filter((row) => !retained.has(readingKey(row))).length,
  ) };
}

function conflictingSignals(current: HeatingShadowDeviceDay, stored: HeatingShadowDeviceDay): HeatingShadowDeviceDay {
  const keepStored = firstDeviceObservation(stored) < firstDeviceObservation(current);
  const kept = sealWindow(keepStored ? stored : current);
  const omitted = sealWindow(keepStored ? current : stored);
  return { ...kept, intervals: kept.intervals.slice(-HEATING_SHADOW_MAX_INTERVALS), signalChanged: true,
    omittedIntervals: Math.max(
      kept.omittedIntervals + Math.max(0, kept.intervals.length - HEATING_SHADOW_MAX_INTERVALS),
      omitted.omittedIntervals + omitted.intervals.length,
    ),
    omittedChanges: Math.max(kept.omittedChanges, omitted.omittedChanges + omitted.changes.length),
    interruptions: Math.max(kept.interruptions, omitted.interruptions) };
}

function mergeDevice(current: HeatingShadowDeviceDay, stored: HeatingShadowDeviceDay): HeatingShadowDeviceDay {
  if (!sameSignal(current.signal, stored.signal)) return conflictingSignals(current, stored);
  const frozen = current.signalChanged || stored.signalChanged;
  const active = frozen ? sealWindow(current) : current;
  const closed = sealWindow(stored);
  return { ...mergeIntervals(mergeChanges(active, closed), closed), signalChanged: frozen,
    interruptions: Math.max(active.interruptions, closed.interruptions) };
}

function mergeOutdoor(current: HeatingShadowDay, stored: HeatingShadowDay): HeatingShadowDay {
  const firstCurrent = firstDayObservation(current);
  const currentKeys = new Set(current.outdoor.map(outdoorKey));
  const older = stored.outdoor.filter((point) => point.atMs < firstCurrent && !currentKeys.has(outdoorKey(point)));
  const lastStored = lastDayObservation(stored);
  // This is an availability boundary, not a weather measurement: the first millisecond after accepted evidence.
  const gapStartMs = lastStored + 1;
  const gap = gapStartMs < firstCurrent && firstCurrent !== Infinity && older.at(-1)?.state === 'available';
  const prefix = gap ? [...older, { atMs: gapStartMs, state: 'unavailable' as const }] : older;
  const outdoor = [...prefix, ...current.outdoor].sort((left, right) => left.atMs - right.atMs)
    .slice(-HEATING_SHADOW_MAX_OUTDOOR_POINTS);
  const retained = new Set(outdoor.map(outdoorKey));
  return { ...current, outdoor, omittedOutdoorPoints: Math.max(
    current.omittedOutdoorPoints + current.outdoor.filter((point) => !retained.has(outdoorKey(point))).length,
    stored.omittedOutdoorPoints + stored.outdoor.filter((point) => !retained.has(outdoorKey(point))).length,
  ) };
}

function closeRetainedDevice(device: HeatingShadowDeviceDay): HeatingShadowDeviceDay {
  const closed = sealWindow(device);
  return { ...closed, intervals: closed.intervals.slice(-HEATING_SHADOW_MAX_INTERVALS),
    omittedIntervals: closed.omittedIntervals + Math.max(0, closed.intervals.length - HEATING_SHADOW_MAX_INTERVALS) };
}

function closeDay(day: HeatingShadowDay): HeatingShadowDay {
  return { ...day, devices: Object.fromEntries(Object.entries(day.devices)
    .map(([id, device]) => [id, closeRetainedDevice(device)])) };
}

function mergeDay(current: HeatingShadowDay, stored: HeatingShadowDay): HeatingShadowDay {
  const allEligible = [...new Set([...current.eligibleDeviceIds, ...stored.eligibleDeviceIds])];
  const selected = [...Object.keys(current.devices), ...orderHeatingShadowDeviceIds(allEligible, current.dateKey)
    .filter((id) => !Object.hasOwn(current.devices, id) && Object.hasOwn(stored.devices, id))]
    .slice(0, HEATING_SHADOW_MAX_SELECTED_DEVICES);
  const eligibleDeviceIds = [...new Set([...selected, ...allEligible])]
    .slice(0, HEATING_SHADOW_MAX_ELIGIBLE_DEVICES).sort();
  const devices = Object.fromEntries(selected.map((id) => {
    const active = current.devices[id];
    const older = stored.devices[id];
    if (active && older) return [id, mergeDevice(active, older)];
    if (active) return [id, active];
    return [id, closeRetainedDevice(older!)];
  }));
  return { ...mergeOutdoor(current, stored), devices, eligibleDeviceIds,
    eligibleIdsTruncated: current.eligibleIdsTruncated || stored.eligibleIdsTruncated
      || allEligible.length > HEATING_SHADOW_MAX_ELIGIBLE_DEVICES };
}

/**
 * Restore trusted retained history under observations collected before late hydration.
 * Current selection/timezone wins; measured intervals are never spliced or integrated.
 * Omission counters remain per-source lower bounds because overlapping capped histories
 * do not identify which earlier omissions describe the same rows.
 */
export function mergeHeatingShadowHistory(current: HeatingShadowState, stored: HeatingShadowState): HeatingShadowState {
  if (current.timeZone !== stored.timeZone) return current;
  const latest = current.days.at(-1)?.dateKey;
  if (latest === undefined) return stored;
  const cutoff = shiftDateKey(latest, -HEATING_SHADOW_COMPLETED_DAYS);
  const dates = [...new Set([...stored.days, ...current.days].map((day) => day.dateKey))]
    .filter((dateKey) => dateKey >= cutoff && dateKey <= latest).sort();
  const days = dates.map((dateKey) => {
    const active = current.days.find((day) => day.dateKey === dateKey);
    const older = stored.days.find((day) => day.dateKey === dateKey);
    if (active && older) return mergeDay(active, older);
    return active ?? closeDay(older!);
  });
  return { version: 1, timeZone: current.timeZone, days };
}
