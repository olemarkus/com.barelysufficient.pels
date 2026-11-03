import { describe, expect, it } from 'vitest';
import type {
  HeatingShadowDay, HeatingShadowDeviceDay, HeatingShadowSignal,
} from '../../packages/contracts/src/heatingShadow';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import {
  getDateKeyStartMs, shiftDateKey,
} from '../../packages/shared-domain/src/utils/dateUtils';
import {
  HEATING_SHADOW_REPORT_BUDGET_BYTES, readHeatingShadowDaily,
} from '../../lib/diagnostics/heatingShadowReport';
import { orderHeatingShadowDeviceIds } from '../../lib/diagnostics/heatingShadow';

const TIME_ZONE = 'Europe/Oslo';
const QUARTER_MS = 15 * 60_000;
const signal: HeatingShadowSignal = { temperatureCapability: 'measure_temperature', temperatureRole: 'unclassified',
  targetCapability: 'target_temperature', electricalInput: 'held_reported_direct_power' };

function dayAt(dateKey: string): HeatingShadowDay {
  return { dateKey, startMs: getDateKeyStartMs(dateKey, TIME_ZONE),
    endMs: getDateKeyStartMs(shiftDateKey(dateKey, 1), TIME_ZONE),
    devices: {}, eligibleDeviceIds: [], eligibleIdsTruncated: false, outdoor: [], omittedOutdoorPoints: 0 };
}

function deviceDay(day: HeatingShadowDay, changes = 0): HeatingShadowDeviceDay {
  return { signal,
    intervals: Array.from({ length: (day.endMs - day.startMs) / QUARTER_MS }, (_, index) => ({
      startMs: day.startMs + index * QUARTER_MS, endMs: day.startMs + (index + 1) * QUARTER_MS,
      startTemperatureC: 21.123456789012344, endTemperatureC: 21.24691357802469,
      meanTemperatureC: 21.17283945061728, inputKWh: 0.19033333333333333,
      targetC: 23.123456789012344, flags: 0, observations: 16, maximumGapMs: 60_000,
    })),
    changes: Array.from({ length: changes }, (_, index) => ({
      atMs: day.startMs + index * 300_000, temperatureC: 21.123456789012344,
      powerKw: 0.7613333333333333, targetC: 23.123456789012344, control: 'enabled' as const,
    })), omittedIntervals: 0, omittedChanges: 0, interruptions: 0, signalChanged: false };
}

function stateFor(day: HeatingShadowDay): PowerTrackerState {
  return { heatingShadow: { version: 1, timeZone: TIME_ZONE, days: [day] } };
}

describe('compact daily heating observations', () => {
  it.each([
    { dateKey: '2026-03-29', hours: 23, intervals: 92 },
    { dateKey: '2026-10-25', hours: 25, intervals: 100 },
  ])('retains the actual $hours-hour local day and all $intervals intervals', ({ dateKey, hours, intervals }) => {
    const day = dayAt(dateKey);
    day.devices = { heater: deviceDay(day) };
    day.eligibleDeviceIds = ['heater'];
    const report = readHeatingShadowDaily(stateFor(day), day.endMs + 60_000, TIME_ZONE);
    expect(report?.values).toMatchObject({ dateKey, durationMs: hours * 3_600_000,
      devices: [{ id: 'heater', signal, coverage: { acceptedDurationMs: hours * 3_600_000,
        uncoveredRanges: [] } }] });
    const blocks = report?.values.devices;
    if (!Array.isArray(blocks)) throw new Error('Expected device blocks');
    expect(blocks[0].intervals).toHaveLength(intervals);
    expect(blocks[0].intervals.at(-1)?.[1]).toBe(hours * 3_600_000);
  });

  it('preserves precision, partial durations, gaps and shared unavailable outdoor markers', () => {
    const day = dayAt('2026-11-01');
    const device = deviceDay(day);
    device.intervals = [{ ...device.intervals[0]!, startMs: day.startMs + 123_456,
      endMs: day.startMs + 800_123, flags: 1 | 2 | 8, observations: 12, maximumGapMs: 72_345 }];
    device.changes = [{ atMs: day.startMs + 400_000, temperatureC: 21.123456789012344,
      powerKw: 0, targetC: 22.987654321098766, control: 'disabled' }];
    device.omittedIntervals = 3;
    device.omittedChanges = 5;
    device.interruptions = 2;
    device.signalChanged = true;
    day.devices = { heater: device };
    day.eligibleDeviceIds = ['heater', 'not-retained'];
    day.eligibleIdsTruncated = true;
    day.outdoor = [{ atMs: day.startMs + 100, state: 'available', temperatureC: -1.123456789012345 },
      { atMs: day.startMs + 500_000, state: 'unavailable' }];
    day.omittedOutdoorPoints = 4;
    const state = stateFor(day), original = JSON.stringify(state);
    const report = readHeatingShadowDaily(state, day.endMs + 60_000, TIME_ZONE);
    expect(report?.values).toMatchObject({
      outdoor: [[100, 1, -1.123456789012345], [500_000, 0, null]],
      coverage: { eligibleCountIsLowerBound: true, eligibleIdsWithoutRetainedBlock: ['not-retained'],
        omittedOutdoorPoints: 4 },
      devices: [{ signal: { temperatureRole: 'unclassified' },
        intervals: [[123_456, 800_123, 21.123456789012344, 21.24691357802469,
          21.17283945061728, 0.19033333333333333, 23.123456789012344, 11, 12, 72_345]],
        changes: [[400_000, 21.123456789012344, 0, 22.987654321098766, 0]],
        coverage: { acceptedDurationMs: 676_667, omittedIntervals: 3, omittedChanges: 5,
          interruptions: 2, signalChanged: true,
          uncoveredRanges: [[0, 123_456], [800_123, day.endMs - day.startMs]] } }],
    });
    expect(JSON.stringify(state)).toBe(original);
  });

  it('selects the latest completed retained local day and never the current day', () => {
    const older = dayAt('2026-10-31'), latest = dayAt('2026-11-01'), current = dayAt('2026-11-02');
    for (const day of [older, latest, current]) day.devices = { heater: deviceDay(day) };
    const state: PowerTrackerState = { heatingShadow: { version: 1, timeZone: TIME_ZONE,
      days: [current, older, latest] } };
    expect(readHeatingShadowDaily(state, current.startMs + 3_600_000, TIME_ZONE)?.values.dateKey).toBe(latest.dateKey);
    expect(readHeatingShadowDaily({ heatingShadow: { ...state.heatingShadow!, days: [current] } },
      current.startMs + 3_600_000, TIME_ZONE)).toBeUndefined();
    expect(readHeatingShadowDaily(state, current.endMs, 'UTC')).toBeUndefined();
    expect(readHeatingShadowDaily(state, getDateKeyStartMs('2026-11-05', TIME_ZONE), TIME_ZONE)).toBeUndefined();
  });

  it('retains an unfinished window with its actual last observation and marks the uncovered day edges', () => {
    const day = dayAt('2026-11-01');
    const device = deviceDay(day);
    device.intervals = [];
    const start = { atMs: day.startMs + 100_000, temperatureC: 20, powerKw: 1,
      targetC: 22, control: 'enabled' as const };
    device.window = { start, last: { ...start, atMs: day.startMs + 200_000, temperatureC: 21, powerKw: 0 },
      inputKWh: 1 / 36, temperatureIntegralCHours: 20.5 / 36, flags: 0, observations: 3, maximumGapMs: 50_000 };
    day.devices = { heater: device };
    const report = readHeatingShadowDaily(stateFor(day), day.endMs + 60_000, TIME_ZONE);
    expect(report?.values.devices).toMatchObject([{
      intervals: [],
      openWindow: [100_000, 200_000, 20, 21, 1 / 36, 20.5 / 36, 0, 3, 50_000, 1, 0, 22, 22, 1, 1],
      coverage: { acceptedDurationMs: 0, openWindowDurationMs: 100_000,
        uncoveredRanges: [[0, 100_000], [200_000, day.endMs - day.startMs]] },
    }]);
  });

  it('fits64KiB by rotating whole device-day blocks without trimming accepted rows', () => {
    const first = dayAt('2026-10-31'), second = dayAt('2026-11-01');
    const ids = Array.from({ length: 16 }, (_, index) => `heater-${String(index).padStart(2, '0')}`);
    for (const day of [first, second]) {
      day.devices = Object.fromEntries(ids.map((id) => [id, deviceDay(day, 256)]));
      day.eligibleDeviceIds = ids;
    }
    const reports = [first, second].map((day) => readHeatingShadowDaily(stateFor(day), day.endMs + 60_000, TIME_ZONE));
    const exportedIds = reports.map((report, index) => {
      expect(Buffer.byteLength(JSON.stringify(report), 'utf8')).toBeLessThanOrEqual(HEATING_SHADOW_REPORT_BUDGET_BYTES);
      const blocks = report?.values.devices;
      if (!Array.isArray(blocks)) throw new Error('Expected complete device blocks');
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.length).toBeLessThan(16);
      for (const block of blocks) {
        expect(block.intervals).toHaveLength(96);
        expect(block.changes).toHaveLength(256);
      }
      const selected = blocks.map((block) => block.id);
      expect(report?.values.coverage).toMatchObject({
        omittedWholeDevicesForBudget: ids.filter((id) => !selected.includes(id)),
        recordedDeviceCount: 16, exportedDeviceCount: selected.length,
      });
      expect(readHeatingShadowDaily(stateFor([first, second][index]!), [first, second][index]!.endMs + 60_000,
        TIME_ZONE)).toEqual(report);
      return selected;
    });
    expect(exportedIds[0]?.[0]).not.toBe(exportedIds[1]?.[0]);
  });

  it('exports every stable32-device roster member when only one retained device-day fits per report', () => {
    const ids = Array.from({ length: 32 }, (_, index) => `heater-${String(index).padStart(2, '0')}`);
    const exported = new Set<string>();
    for (let index = 0; index < 32; index += 1) {
      const day = dayAt(shiftDateKey('2026-11-01', index));
      const selected = orderHeatingShadowDeviceIds(ids, day.dateKey).slice(0, 16);
      day.devices = Object.fromEntries(selected.map((id) => [id, deviceDay(day, 256)]));
      day.eligibleDeviceIds = ids;
      day.outdoor = Array.from({ length: 256 }, (_, point) => ({
        atMs: day.startMs + point * 300_000, state: 'available' as const,
        temperatureC: -1.123456789012345 + point / 100,
      }));
      const report = readHeatingShadowDaily(stateFor(day), day.endMs + 60_000, TIME_ZONE);
      const blocks = report?.values.devices;
      if (!Array.isArray(blocks)) throw new Error('Expected one whole device-day block');
      expect(blocks).toHaveLength(1);
      expect(blocks[0].id).toBe(selected[0]);
      expect(blocks[0].intervals).toHaveLength(96);
      expect(blocks[0].changes).toHaveLength(256);
      exported.add(blocks[0].id);
      expect(Buffer.byteLength(JSON.stringify(report), 'utf8')).toBeLessThanOrEqual(HEATING_SHADOW_REPORT_BUDGET_BYTES);
    }
    expect([...exported].sort()).toEqual(ids);
  });
});
