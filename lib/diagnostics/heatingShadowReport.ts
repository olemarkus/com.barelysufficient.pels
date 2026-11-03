import type {
  HeatingShadowDay, HeatingShadowDeviceDay, HeatingShadowReading, HeatingShadowState,
} from './heatingShadowTypes';
import type { SupportReportSection } from '../../packages/contracts/src/supportReport';
import { getDateKeyInTimeZone, shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';
import {
  HEATING_SHADOW_COMPLETED_DAYS, HEATING_SHADOW_INTERVAL_MS, HEATING_SHADOW_MAX_CHANGES,
  HEATING_SHADOW_MAX_ELIGIBLE_DEVICES, HEATING_SHADOW_MAX_GAP_MS, HEATING_SHADOW_MAX_INTERVALS,
  HEATING_SHADOW_MAX_OUTDOOR_POINTS, HEATING_SHADOW_MAX_SELECTED_DEVICES, HEATING_SHADOW_POWER_CHANGE_KW,
  orderHeatingShadowDeviceIds,
} from './heatingShadow';

export const HEATING_SHADOW_REPORT_BUDGET_BYTES = 64 * 1024;
export const HEATING_SHADOW_REPORT_TITLE = 'Daily heating observations';
const CONTROL_CODES = { disabled: 0, enabled: 1, unobserved: 2 };

const controlCode = (control: HeatingShadowReading['control']): number => CONTROL_CODES[control];

function uncoveredRanges(day: HeatingShadowDay, device: HeatingShadowDeviceDay): number[][] {
  const spans = [...device.intervals.map((interval) => [interval.startMs, interval.endMs] as const),
    ...(device.window ? [[device.window.start.atMs, device.window.last.atMs] as const] : [])];
  let cursor = day.startMs;
  let gaps: number[][] = [];
  for (const [startMs, endMs] of spans) {
    if (startMs > cursor) gaps = [...gaps, [cursor - day.startMs, startMs - day.startMs]];
    cursor = Math.max(cursor, endMs);
  }
  return cursor < day.endMs ? [...gaps, [cursor - day.startMs, day.endMs - day.startMs]] : gaps;
}

function deviceRows(id: string, device: HeatingShadowDeviceDay, day: HeatingShadowDay) {
  const offset = (atMs: number): number => atMs - day.startMs;
  const window = device.window;
  return {
    id, signal: { ...device.signal },
    intervals: device.intervals.map((interval) => [offset(interval.startMs), offset(interval.endMs),
      interval.startTemperatureC, interval.endTemperatureC, interval.meanTemperatureC, interval.inputKWh,
      interval.targetC, interval.flags, interval.observations, interval.maximumGapMs]),
    changes: device.changes.map((reading) => [offset(reading.atMs), reading.temperatureC, reading.powerKw,
      reading.targetC, controlCode(reading.control)]),
    coverage: {
      acceptedDurationMs: device.intervals.reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0),
      openWindowDurationMs: window ? window.last.atMs - window.start.atMs : 0,
      uncoveredRanges: uncoveredRanges(day, device),
      omittedIntervals: device.omittedIntervals, omittedChanges: device.omittedChanges,
      interruptions: device.interruptions, signalChanged: device.signalChanged,
    },
    ...(window ? { openWindow: [offset(window.start.atMs), offset(window.last.atMs),
      window.start.temperatureC, window.last.temperatureC, window.inputKWh, window.temperatureIntegralCHours,
      window.flags, window.observations, window.maximumGapMs, window.start.powerKw, window.last.powerKw,
      window.start.targetC, window.last.targetC,
      controlCode(window.start.control), controlCode(window.last.control)] } : {}),
  };
}

/**
 * Reports a passive retained day, independent of the fitter's training reservoir.
 * A report budget selects whole device-day blocks; no accepted row is shortened or rounded.
 */
export function readHeatingShadowDaily(
  retained: HeatingShadowState, capturedAtMs: number, timeZone: string,
): SupportReportSection | undefined {
  if (retained.timeZone !== timeZone) return undefined;
  const currentDateKey = getDateKeyInTimeZone(new Date(capturedAtMs), timeZone);
  const oldestDateKey = shiftDateKey(currentDateKey, -HEATING_SHADOW_COMPLETED_DAYS);
  const day = retained.days.filter((candidate) => candidate.dateKey >= oldestDateKey
    && candidate.dateKey < currentDateKey && candidate.endMs <= capturedAtMs)
    .sort((left, right) => right.startMs - left.startMs)[0];
  if (!day) return undefined;
  const ids = Object.keys(day.devices).sort();
  if (ids.length === 0) return undefined;
  // Use the collector's full-roster priority. Rotating its already selected
  // subset again can alias the two limits and permanently exclude some ids.
  const eligible = [...day.eligibleDeviceIds].sort();
  const orderedEligible = orderHeatingShadowDeviceIds(eligible, day.dateKey);
  const outsideRoster = ids.filter((id) => !eligible.includes(id));
  const ordered = [...orderedEligible.filter((id) => Object.hasOwn(day.devices, id)), ...outsideRoster];
  const rotationOffset = Math.max(0, eligible.indexOf(orderedEligible[0] ?? ''));
  const blocks = new Map(ids.map((id) => [id, deviceRows(id, day.devices[id]!, day)]));
  const section = (selected: readonly string[]): SupportReportSection => ({
    title: HEATING_SHADOW_REPORT_TITLE,
    values: {
      schemaVersion: 1, capturedAtMs, timeZone, dateKey: day.dateKey,
      startMs: day.startMs, endMs: day.endMs, durationMs: day.endMs - day.startMs,
      columns: {
        intervals: ['startOffsetMs', 'endOffsetMs', 'startTemperatureC', 'endTemperatureC', 'meanTemperatureC',
          'inputKWh', 'initialTargetC', 'flags', 'observations', 'maximumGapMs'],
        changes: ['offsetMs', 'temperatureC', 'powerKw', 'targetC', 'control'],
        outdoor: ['offsetMs', 'available', 'temperatureC'],
        openWindow: ['startOffsetMs', 'lastOffsetMs', 'startTemperatureC', 'lastTemperatureC', 'inputKWh',
          'temperatureIntegralCHours', 'flags', 'observations', 'maximumGapMs', 'startPowerKw', 'lastPowerKw',
          'startTargetC', 'lastTargetC', 'startControl', 'lastControl'],
        uncoveredRanges: ['startOffsetMs', 'endOffsetMs'],
      },
      codes: { control: CONTROL_CODES,
        flags: { targetChanged: 1, observedDisabled: 2, controlUnobserved: 4, partialWindow: 8 },
        outdoor: { unavailable: 0, available: 1 } },
      collection: {
        targetIntervalMs: HEATING_SHADOW_INTERVAL_MS, maximumObservationGapMs: HEATING_SHADOW_MAX_GAP_MS,
        significantPowerChangeKw: HEATING_SHADOW_POWER_CHANGE_KW,
        transitions: 'initial reading, target/control changes, significant power changes and crossings of zero',
        temperature: 'accepted held measure_temperature at meter ingest; sensor role unclassified',
        electricalInput: 'integral of held reported direct power over accepted observation intervals',
        outdoor: 'shared held context at ingest; unavailable markers explicit; original source timestamps unresolved',
        cadence: '15-minute target aggregates, not native sensor cadence; actual durations and gaps are retained',
        selection: 'separate chronological buffer, not the model training reservoir',
        localCaps: { completedDays: HEATING_SHADOW_COMPLETED_DAYS,
          selectedDevices: HEATING_SHADOW_MAX_SELECTED_DEVICES, eligibleIds: HEATING_SHADOW_MAX_ELIGIBLE_DEVICES,
          intervalsPerDevice: HEATING_SHADOW_MAX_INTERVALS, changesPerDevice: HEATING_SHADOW_MAX_CHANGES,
          outdoorPoints: HEATING_SHADOW_MAX_OUTDOOR_POINTS },
      },
      coverage: {
        eligibleDeviceCount: day.eligibleDeviceIds.length, eligibleIdsTruncated: day.eligibleIdsTruncated,
        eligibleCountIsLowerBound: day.eligibleIdsTruncated,
        recordedDeviceCount: ids.length, exportedDeviceCount: selected.length,
        eligibleIdsWithoutRetainedBlock: day.eligibleDeviceIds.filter((id) => !blocks.has(id)),
        omittedWholeDevicesForBudget: ids.filter((id) => !selected.includes(id)),
        rotation: 'collector calendar order over the full eligible roster, then retained device blocks',
        rotationOffset, rotationPoolSize: eligible.length, recordedIdsOutsideRoster: outsideRoster,
        omittedOutdoorPoints: day.omittedOutdoorPoints,
        outdoorCoverage: 'only retained points; omitted prefixes and unavailable markers are not filled',
      },
      outdoor: day.outdoor.map((point) => [point.atMs - day.startMs, point.state === 'available' ? 1 : 0,
        point.state === 'available' ? point.temperatureC : null]),
      devices: selected.map((id) => blocks.get(id)!),
    },
  });
  let selected: string[] = [];
  if (Buffer.byteLength(JSON.stringify(section(selected)), 'utf8') > HEATING_SHADOW_REPORT_BUDGET_BYTES) {
    return undefined;
  }
  for (const id of ordered) {
    const candidate = [...selected, id];
    if (Buffer.byteLength(JSON.stringify(section(candidate)), 'utf8') <= HEATING_SHADOW_REPORT_BUDGET_BYTES) {
      selected = candidate;
    }
  }
  return section(selected);
}
