import { describe, expect, it } from 'vitest';
import type {
  HeatingShadowDevice, HeatingShadowInterval, HeatingShadowState,
} from '../../lib/diagnostics/heatingShadowTypes';
import {
  HEATING_SHADOW_MAX_CHANGES, HEATING_SHADOW_MAX_ELIGIBLE_DEVICES, HEATING_SHADOW_MAX_INTERVALS,
  HEATING_SHADOW_MAX_OUTDOOR_POINTS, HEATING_SHADOW_MAX_SELECTED_DEVICES, recordHeatingShadow,
} from '../../lib/diagnostics/heatingShadow';
import { mergeHeatingShadowHistory } from '../../lib/diagnostics/heatingShadowMerge';
import { isHeatingShadowState } from '../../lib/diagnostics/heatingShadowState';

const START = Date.UTC(2026, 10, 3, 8);
const MINUTE = 60_000;
const DAY = 86_400_000;

function device(atMs: number, id = 'room', targetCapability = 'target_temperature'): HeatingShadowDevice {
  return { id, signal: { temperatureCapability: 'measure_temperature', temperatureRole: 'unclassified',
    targetCapability, electricalInput: 'held_reported_direct_power' },
  reading: { atMs, temperatureC: 20, powerKw: 1, targetC: 22, control: 'enabled' } };
}

function collect(times: number[], ids = ['room'], targetCapability = 'target_temperature'): HeatingShadowState {
  let state: HeatingShadowState | undefined;
  for (const atMs of times) state = recordHeatingShadow(state,
    ids.map((id) => device(atMs, id, targetCapability)), atMs, -4, 'UTC');
  return state!;
}

function dense(startMs: number): HeatingShadowState {
  const state = collect([startMs]);
  const day = state.days[0]!;
  const observed = day.devices.room!;
  const intervals: HeatingShadowInterval[] = Array.from({ length: HEATING_SHADOW_MAX_INTERVALS }, (_, index) => ({
    startMs: startMs + index * 2 * MINUTE, endMs: startMs + (index * 2 + 1) * MINUTE,
    startTemperatureC: 20, endTemperatureC: 20, meanTemperatureC: 20, inputKWh: 1 / 60,
    targetC: 22, flags: 8, observations: 2, maximumGapMs: MINUTE,
  }));
  return { ...state, days: [{ ...day, devices: { room: { ...observed, window: undefined, intervals,
    changes: Array.from({ length: HEATING_SHADOW_MAX_CHANGES }, (_, index) =>
      device(startMs + index * MINUTE).reading),
  } }, outdoor: Array.from({ length: HEATING_SHADOW_MAX_OUTDOOR_POINTS }, (_, index) => ({
    atMs: startMs + index * MINUTE, state: 'available' as const, temperatureC: index % 2,
  })) }] };
}

describe('late hydration of heating shadow history', () => {
  it('retains earlier local days and pre-restart evidence without joining open-window input across the restart', () => {
    const stored = collect([START - DAY, START, START + 5 * MINUTE, START + 10 * MINUTE,
      START + 15 * MINUTE, START + 20 * MINUTE]);
    const current = collect([START + 60 * MINUTE, START + 65 * MINUTE,
      START + 70 * MINUTE, START + 75 * MINUTE, START + 80 * MINUTE]);
    const original = JSON.stringify({ current, stored });
    const merged = mergeHeatingShadowHistory(current, stored);
    expect(merged.days.map((day) => day.dateKey)).toEqual(['2026-11-02', '2026-11-03']);
    const room = merged.days[1]!.devices.room!;
    expect(room.intervals.map((row) => [row.startMs, row.endMs])).toEqual([
      [START, START + 15 * MINUTE], [START + 15 * MINUTE, START + 20 * MINUTE],
      [START + 60 * MINUTE, START + 75 * MINUTE],
    ]);
    expect(room.intervals[1]).toMatchObject({ flags: 8, inputKWh: 1 / 12 });
    expect(room.intervals.reduce((sum, row) => sum + row.inputKWh, 0)).toBeCloseTo(7 / 12);
    expect(room.window).toEqual(current.days[0]!.devices.room!.window);
    expect(room.changes.map((row) => row.atMs)).toEqual([START, START + 60 * MINUTE]);
    expect(room.interruptions).toBe(1);
    expect(merged.days[1]!.outdoor).toEqual([
      { atMs: START, state: 'available', temperatureC: -4 },
      { atMs: START + 20 * MINUTE + 1, state: 'unavailable' },
      { atMs: START + 60 * MINUTE, state: 'available', temperatureC: -4 },
    ]);
    expect(isHeatingShadowState(merged)).toBe(true);
    expect(JSON.stringify({ current, stored })).toBe(original);
  });

  it('prefers current overlapping intervals and is idempotent for repeated hydration', () => {
    const stored = collect([START, START + 5 * MINUTE, START + 10 * MINUTE, START + 15 * MINUTE]);
    const current = collect([START + 10 * MINUTE, START + 15 * MINUTE,
      START + 20 * MINUTE, START + 25 * MINUTE]);
    const merged = mergeHeatingShadowHistory(current, stored);
    expect(merged.days[0]!.devices.room!.intervals).toEqual(current.days[0]!.devices.room!.intervals);
    expect(merged.days[0]!.devices.room!.omittedIntervals).toBe(1);
    expect(mergeHeatingShadowHistory(merged, stored)).toEqual(merged);
    expect(isHeatingShadowState(merged)).toBe(true);
  });

  it('preserves a real outdoor point at the end of stored observations before marking the restart gap', () => {
    const stored = collect([START]);
    const current = collect([START + 60 * MINUTE]);
    const merged = mergeHeatingShadowHistory(current, stored);
    expect(merged.days[0]!.outdoor).toEqual([
      { atMs: START, state: 'available', temperatureC: -4 },
      { atMs: START + 1, state: 'unavailable' },
      { atMs: START + 60 * MINUTE, state: 'available', temperatureC: -4 },
    ]);
    expect(merged.days[0]!.omittedOutdoorPoints).toBe(0);
    expect(isHeatingShadowState(merged)).toBe(true);
  });

  it('preserves exact duplicate intervals once instead of double counting their input', () => {
    const state = collect([START, START + 5 * MINUTE, START + 10 * MINUTE, START + 15 * MINUTE]);
    const merged = mergeHeatingShadowHistory(state, state);
    expect(merged.days[0]!.devices.room!.intervals).toEqual(state.days[0]!.devices.room!.intervals);
    expect(merged.days[0]!.devices.room!.intervals[0]!.inputKWh).toBe(0.25);
    expect(isHeatingShadowState(merged)).toBe(true);
  });

  it('freezes the first signal identity instead of attributing earlier observations to a new channel', () => {
    const stored = collect([START, START + 5 * MINUTE]);
    const current = collect([START + 60 * MINUTE, START + 65 * MINUTE], ['room'], 'target_temperature.other');
    const merged = mergeHeatingShadowHistory(current, stored);
    expect(merged.days[0]!.devices.room!).toMatchObject({ signal: stored.days[0]!.devices.room!.signal,
      signalChanged: true });
    expect(merged.days[0]!.devices.room!.window).toBeUndefined();
    expect(merged.days[0]!.devices.room!.intervals[0]).toMatchObject({ startMs: START, endMs: START + 5 * MINUTE });
    expect(isHeatingShadowState(merged)).toBe(true);
  });

  it('keeps the live daily roster and bounds the eligible union while making truncation explicit', () => {
    const oldIds = Array.from({ length: 16 }, (_, index) => `old-${index}`);
    const newIds = Array.from({ length: 64 }, (_, index) => `new-${index}`);
    const stored = collect([START], oldIds);
    const current = collect([START + 60 * MINUTE], newIds);
    const merged = mergeHeatingShadowHistory(current, stored);
    expect(Object.keys(merged.days[0]!.devices)).toEqual(Object.keys(current.days[0]!.devices));
    expect(Object.keys(merged.days[0]!.devices)).toHaveLength(HEATING_SHADOW_MAX_SELECTED_DEVICES);
    expect(merged.days[0]!.eligibleDeviceIds).toHaveLength(HEATING_SHADOW_MAX_ELIGIBLE_DEVICES);
    expect(merged.days[0]!.eligibleIdsTruncated).toBe(true);
    expect(isHeatingShadowState(merged)).toBe(true);
  });

  it('fills free cohort places with sealed stored devices rather than retaining stale live windows', () => {
    const stored = collect([START, START + 5 * MINUTE], ['old']);
    const current = collect([START + 60 * MINUTE], ['new']);
    const merged = mergeHeatingShadowHistory(current, stored);
    expect(Object.keys(merged.days[0]!.devices).sort()).toEqual(['new', 'old']);
    expect(merged.days[0]!.devices.old!.window).toBeUndefined();
    expect(merged.days[0]!.devices.old!.intervals[0]).toMatchObject({ flags: 8, endMs: START + 5 * MINUTE });
    expect(isHeatingShadowState(merged)).toBe(true);
  });

  it('bounds merged observations and retains stable per-source omission lower bounds', () => {
    const stored = dense(START);
    const current = dense(START + 8 * 60 * MINUTE);
    const merged = mergeHeatingShadowHistory(current, stored);
    const day = merged.days[0]!;
    expect(day.devices.room!.intervals).toHaveLength(HEATING_SHADOW_MAX_INTERVALS);
    expect(day.devices.room!.changes).toHaveLength(HEATING_SHADOW_MAX_CHANGES);
    expect(day.outdoor).toHaveLength(HEATING_SHADOW_MAX_OUTDOOR_POINTS);
    expect(day.devices.room!.omittedIntervals).toBe(HEATING_SHADOW_MAX_INTERVALS);
    expect(day.devices.room!.omittedChanges).toBe(HEATING_SHADOW_MAX_CHANGES);
    expect(day.omittedOutdoorPoints).toBe(HEATING_SHADOW_MAX_OUTDOOR_POINTS);
    expect(mergeHeatingShadowHistory(merged, stored)).toEqual(merged);
    expect(isHeatingShadowState(merged)).toBe(true);
  });

  it('retains current plus two calendar days and respects an explicit timezone reset', () => {
    const stored = collect([START - 3 * DAY, START - 2 * DAY, START - DAY]);
    const current = collect([START]);
    expect(mergeHeatingShadowHistory(current, stored).days.map((day) => day.dateKey))
      .toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    const changed = recordHeatingShadow(undefined, [device(START)], START, -4, 'Europe/Oslo');
    expect(mergeHeatingShadowHistory(changed, stored)).toBe(changed);
    expect(mergeHeatingShadowHistory({ version: 1, timeZone: 'UTC', days: [] }, stored)).toBe(stored);
  });
});
