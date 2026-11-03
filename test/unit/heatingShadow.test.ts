import { describe, expect, it } from 'vitest';
import type {
  HeatingShadowDevice, HeatingShadowReading, HeatingShadowSignal, HeatingShadowState,
} from '../../lib/diagnostics/heatingShadowTypes';
import {
  HEATING_SHADOW_MAX_CHANGES, HEATING_SHADOW_MAX_ELIGIBLE_DEVICES, HEATING_SHADOW_MAX_INTERVALS,
  HEATING_SHADOW_MAX_OUTDOOR_POINTS, HEATING_SHADOW_MAX_SELECTED_DEVICES,
  orderHeatingShadowDeviceIds, recordHeatingShadow,
} from '../../lib/diagnostics/heatingShadow';
import { getDateKeyStartMs, shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';

const START = Date.UTC(2026, 10, 2, 8);
const MINUTE = 60_000;
const SIGNAL: HeatingShadowSignal = {
  temperatureCapability: 'measure_temperature', temperatureRole: 'unclassified',
  targetCapability: 'target_temperature', electricalInput: 'held_reported_direct_power',
};

function device(atMs: number, values: Partial<HeatingShadowReading> = {}, id = 'room'): HeatingShadowDevice {
  return { id, signal: SIGNAL, reading: { atMs, temperatureC: 20, powerKw: 1, targetC: 22,
    control: 'enabled', ...values } };
}

function sample(
  state: HeatingShadowState | undefined, minute: number, values: Partial<HeatingShadowReading> = {},
): HeatingShadowState {
  const atMs = START + minute * MINUTE;
  return recordHeatingShadow(state, [device(atMs, values)], atMs, undefined, 'UTC');
}

describe('passive heating shadow collection', () => {
  it('closes at real endpoints after fifteen minutes and integrates held power and actual temperature segments', () => {
    let state = sample(undefined, 0);
    state = sample(state, 4, { temperatureC: 20.4, powerKw: 0 });
    state = sample(state, 8, { temperatureC: 20.8, powerKw: 2 });
    state = sample(state, 12, { temperatureC: 21.2, powerKw: 2 });
    state = sample(state, 16, { temperatureC: 21.6, powerKw: 0 });
    const day = state.days[0]!;
    const interval = day.devices.room!.intervals[0]!;
    expect(interval).toMatchObject({ startMs: START, endMs: START + 16 * MINUTE,
      startTemperatureC: 20, endTemperatureC: 21.6, observations: 5, maximumGapMs: 4 * MINUTE, flags: 0 });
    expect(interval.inputKWh).toBeCloseTo(1 / 3);
    expect(interval.meanTemperatureC).toBeCloseTo(20.8);
    expect(day.devices.room!.window?.start.atMs).toBe(START + 16 * MINUTE);
    expect(day.outdoor).toEqual([{ atMs: START, state: 'unavailable' }]);
  });

  it('records true zero input and target/control changes without changing the interval initial target', () => {
    let state = sample(undefined, 0, { powerKw: 0 });
    state = sample(state, 5, { powerKw: 0, targetC: 23, control: 'unobserved' });
    state = sample(state, 10, { powerKw: 0, control: 'disabled' });
    state = sample(state, 15, { powerKw: 0 });
    expect(state.days[0]!.devices.room!.intervals[0]).toMatchObject({ inputKWh: 0, targetC: 22, flags: 7 });
    expect(state.days[0]!.devices.room!.changes).toHaveLength(4);
  });

  it('retains a cumulative significant power ramp and actual zero crossings below that threshold', () => {
    let state = sample(undefined, 0);
    for (let minute = 1; minute <= 12; minute += 1) state = sample(state, minute, { powerKw: 1 + minute / 100 });
    expect(state.days[0]!.devices.room!.changes.map((change) => change.powerKw)).toEqual([1, 1.1]);
    state = sample(state, 13, { powerKw: 0 });
    state = sample(state, 14, { powerKw: 0.001 });
    expect(state.days[0]!.devices.room!.changes.slice(-2).map((change) => change.powerKw)).toEqual([0, 0.001]);
  });

  it('interrupts missing devices and excessive gaps at their last observations, then resumes without filling either gap', () => {
    let state = sample(undefined, 0);
    state = sample(state, 5);
    state = recordHeatingShadow(state, [], START + 7 * MINUTE, undefined, 'UTC');
    expect(state.days[0]!.devices.room!.intervals[0]).toMatchObject({ endMs: START + 5 * MINUTE, flags: 8 });
    expect(state.days[0]!.devices.room!.intervals[0]!.inputKWh).toBeCloseTo(1 / 12);
    expect(state.days[0]!.devices.room!.window).toBeUndefined();
    state = sample(state, 8, { powerKw: 0 });
    state = sample(state, 13, { powerKw: 0 });
    state = sample(state, 19, { powerKw: 0 });
    const collected = state.days[0]!.devices.room!;
    expect(collected.interruptions).toBe(2);
    expect(collected.intervals[1]).toMatchObject({ startMs: START + 8 * MINUTE,
      endMs: START + 13 * MINUTE, inputKWh: 0, flags: 8 });
    expect(collected.window?.start.atMs).toBe(START + 19 * MINUTE);
  });

  it('continues a persisted declared-held window only across a bounded ordinary gap and ignores repeated time', () => {
    const before = sample(sample(undefined, 0), 5);
    const serialized = JSON.stringify(before);
    const restored: HeatingShadowState = JSON.parse(serialized);
    const resumed = sample(sample(restored, 10), 15);
    expect(resumed.days[0]!.devices.room!.intervals[0]!.inputKWh).toBeCloseTo(0.25);
    expect(sample(before, 5)).toBe(before);
    expect(JSON.stringify(before)).toBe(serialized);
  });

  it('resumes chronological collection after a forward clock jump is corrected backward', () => {
    const future = sample(undefined, 7 * 24 * 60);
    let corrected = sample(future, 0);
    for (let minute = 5; minute <= 15; minute += 5) corrected = sample(corrected, minute);
    expect(corrected.days.map((day) => day.dateKey)).toEqual(['2026-11-02']);
    expect(corrected.days[0]!.devices.room!.intervals[0]).toMatchObject({
      startMs: START, endMs: START + 15 * MINUTE, inputKWh: 0.25,
    });
  });

  it('closes the prior local day at the last actual observation without inventing a midnight endpoint', () => {
    const start = Date.UTC(2026, 0, 1, 22, 52);
    let state = recordHeatingShadow(undefined, [device(start)], start, -4, 'Europe/Oslo');
    state = recordHeatingShadow(state, [device(start + 4 * MINUTE)], start + 4 * MINUTE, -4, 'Europe/Oslo');
    const midnight = Date.UTC(2026, 0, 1, 23);
    state = recordHeatingShadow(state, [device(midnight, { powerKw: 0 })], midnight, -3, 'Europe/Oslo');
    expect(state.days.map((day) => day.dateKey)).toEqual(['2026-01-01', '2026-01-02']);
    expect(state.days[0]!.devices.room!.intervals[0]).toMatchObject({ startMs: start,
      endMs: start + 4 * MINUTE, flags: 8 });
    expect(state.days[0]!.devices.room!.window).toBeUndefined();
    expect(state.days[1]!.devices.room!.window?.start.atMs).toBe(midnight);
  });

  it.each([['2026-03-29', 23], ['2026-10-25', 25]] as const)('uses actual DST bounds for %s', (dateKey, hours) => {
    const atMs = getDateKeyStartMs(dateKey, 'Europe/Oslo') + 8 * 3_600_000;
    const state = recordHeatingShadow(undefined, [device(atMs)], atMs, 0, 'Europe/Oslo');
    const day = state.days[0]!;
    expect(day.dateKey).toBe(dateKey);
    expect((day.endMs - day.startMs) / 3_600_000).toBe(hours);
    expect((day.endMs - day.startMs) / (15 * MINUTE)).toBe(hours * 4);
  });

  it('keeps the selected daily roster fixed, fills free places and bounds the eligible pool honestly', () => {
    const devices = Array.from({ length: 80 }, (_, i) => device(START, {}, `room-${String(i).padStart(2, '0')}`));
    const first = recordHeatingShadow(undefined, devices, START, undefined, 'UTC');
    const reversed = recordHeatingShadow(undefined, [...devices].reverse(), START, undefined, 'UTC');
    expect(Object.keys(first.days[0]!.devices)).toEqual(Object.keys(reversed.days[0]!.devices));
    expect(Object.keys(first.days[0]!.devices)).toHaveLength(HEATING_SHADOW_MAX_SELECTED_DEVICES);
    expect(first.days[0]!.eligibleDeviceIds).toHaveLength(HEATING_SHADOW_MAX_ELIGIBLE_DEVICES);
    expect(first.days[0]!.eligibleIdsTruncated).toBe(true);
    const later = recordHeatingShadow(first, [device(START + MINUTE, {}, 'brand-new')], START + MINUTE, undefined, 'UTC');
    expect(Object.keys(later.days[0]!.devices)).toEqual(Object.keys(first.days[0]!.devices));
    const small = recordHeatingShadow(sample(undefined, 0), [device(START + MINUTE),
      device(START + MINUTE, {}, 'room-2')], START + MINUTE, undefined, 'UTC');
    expect(Object.keys(small.days[0]!.devices).sort()).toEqual(['room', 'room-2']);
  });

  it('rotates the full eligible pool fairly with the same ordering used by reports', () => {
    const ids = Array.from({ length: 32 }, (_, i) => `room-${i}`);
    const chosen = Array.from({ length: 32 }, (_, day) => orderHeatingShadowDeviceIds(ids,
      shiftDateKey('2026-11-02', day))[0]);
    expect(new Set(chosen).size).toBe(32);
  });

  it('freezes a device-day when signal identity changes while preserving the original evidence identity', () => {
    let state = sample(sample(undefined, 0), 5);
    const changed = { ...device(START + 10 * MINUTE), signal: { ...SIGNAL, targetCapability: 'target_temperature.other' } };
    state = recordHeatingShadow(state, [changed], START + 10 * MINUTE, undefined, 'UTC');
    state = sample(state, 15);
    expect(state.days[0]!.devices.room!).toMatchObject({ signal: SIGNAL, signalChanged: true });
    expect(state.days[0]!.devices.room!.intervals[0]).toMatchObject({ endMs: START + 5 * MINUTE, flags: 8 });
    expect(state.days[0]!.devices.room!.window).toBeUndefined();
    expect(state.days[0]!.devices.room!.changes).toHaveLength(1);
  });

  it('retains only current plus two completed local days and resets collection when timezone changes', () => {
    let state: HeatingShadowState | undefined;
    for (let day = 0; day < 5; day += 1) {
      const atMs = START + day * 86_400_000;
      state = recordHeatingShadow(state, [device(atMs)], atMs, undefined, 'UTC');
    }
    expect(state!.days.map((day) => day.dateKey)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    const atMs = START + 4 * 86_400_000 + MINUTE;
    const changed = recordHeatingShadow(state, [device(atMs)], atMs, undefined, 'Europe/Oslo');
    expect(changed.days).toHaveLength(1);
    expect(changed.timeZone).toBe('Europe/Oslo');
  });

  it('bounds repeated interruptions and counts omitted intervals', () => {
    let state: HeatingShadowState | undefined;
    for (let cycle = 0; cycle < HEATING_SHADOW_MAX_INTERVALS + 3; cycle += 1) {
      const atMs = START + cycle * 3 * MINUTE;
      state = recordHeatingShadow(state, [device(atMs)], atMs, undefined, 'UTC');
      state = recordHeatingShadow(state, [device(atMs + MINUTE)], atMs + MINUTE, undefined, 'UTC');
      state = recordHeatingShadow(state, [], atMs + 2 * MINUTE, undefined, 'UTC');
    }
    expect(state!.days[0]!.devices.room!.intervals).toHaveLength(HEATING_SHADOW_MAX_INTERVALS);
    expect(state!.days[0]!.devices.room!.omittedIntervals).toBe(3);
  });

  it('bounds significant changes and shared outdoor points while explicitly recording missing-weather transitions', () => {
    let state: HeatingShadowState | undefined;
    const observations = HEATING_SHADOW_MAX_CHANGES + 5;
    for (let minute = 0; minute < observations; minute += 1) {
      const atMs = START + minute * MINUTE;
      state = recordHeatingShadow(state, [device(atMs, { targetC: minute % 2 ? 23 : 22 })],
        atMs, minute % 2 ? undefined : -4, 'UTC');
    }
    const day = state!.days[0]!;
    expect(day.devices.room!.changes).toHaveLength(HEATING_SHADOW_MAX_CHANGES);
    expect(day.devices.room!.omittedChanges).toBe(5);
    expect(day.outdoor).toHaveLength(HEATING_SHADOW_MAX_OUTDOOR_POINTS);
    expect(day.omittedOutdoorPoints).toBe(observations - HEATING_SHADOW_MAX_OUTDOOR_POINTS);
    expect(day.outdoor.some((point) => point.state === 'unavailable')).toBe(true);
    expect(day.outdoor.some((point) => point.state === 'available' && point.temperatureC === -4)).toBe(true);
  });
});
