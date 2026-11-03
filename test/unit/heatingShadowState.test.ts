import { describe, expect, it } from 'vitest';
import { recordHeatingShadow } from '../../lib/diagnostics/heatingShadow';
import { isHeatingShadowState } from '../../lib/diagnostics/heatingShadowState';
import type { HeatingShadowDevice } from '../../lib/diagnostics/heatingShadowTypes';

const START = Date.UTC(2026, 10, 2, 8);
const device = (atMs: number): HeatingShadowDevice => ({ id: 'room', signal: {
  temperatureCapability: 'measure_temperature', temperatureRole: 'unclassified', targetCapability: 'target_temperature',
  electricalInput: 'held_reported_direct_power',
}, reading: { atMs, temperatureC: 20, powerKw: 0, targetC: 22, control: 'enabled' } });

describe('persisted heating shadow boundary', () => {
  it('accepts a real idle collection after JSON persistence, including missing outdoor context', () => {
    let state = recordHeatingShadow(undefined, [device(START)], START, undefined, 'UTC');
    for (const minute of [5, 10, 15]) {
      const atMs = START + minute * 60_000;
      state = recordHeatingShadow(state, [device(atMs)], atMs, minute === 15 ? -6 : undefined, 'UTC');
    }
    expect(isHeatingShadowState(JSON.parse(JSON.stringify(state)))).toBe(true);
    expect(isHeatingShadowState({ version: 1, timeZone: 'UTC', days: [] })).toBe(true);
    expect(isHeatingShadowState(undefined)).toBe(false);
  });

  it.each([{ control: ['enabled'] }, { control: ['disabled'] }, { control: null }, { control: 1 }])(
    'rejects malformed persisted control $control', ({ control }) => {
      const state = recordHeatingShadow(undefined, [device(START)], START, undefined, 'UTC');
      const day = state.days[0]!;
      const bad = { ...state, days: [{ ...day, devices: { room: { ...day.devices.room!,
        changes: [{ ...device(START).reading, control }],
      } } }] };
      expect(isHeatingShadowState(bad)).toBe(false);
    },
  );

  it('rejects nonfinite values, incorrect calendar bounds, unsorted observations and incompatible signal state', () => {
    const state = recordHeatingShadow(undefined, [device(START)], START, -2, 'UTC');
    const day = state.days[0]!;
    const observed = day.devices.room!;
    const invalid = [
      { ...state, timeZone: 'unknown/timezone' },
      { ...state, days: [{ ...day, endMs: day.endMs + 1 }] },
      { ...state, days: [{ ...day, outdoor: [{ atMs: START, state: 'available', temperatureC: Number.NaN }] }] },
      { ...state, days: [{ ...day, outdoor: [day.outdoor[0], day.outdoor[0]] }] },
      { ...state, days: [{ ...day, devices: { room: { ...observed, omittedChanges: -1 } } }] },
      { ...state, days: [{ ...day, devices: { room: { ...observed, signalChanged: true } } }] },
      { ...state, days: [{ ...day, devices: { room: { ...observed,
        window: { ...observed.window!, inputKWh: Number.POSITIVE_INFINITY },
      } } }] },
    ];
    for (const value of invalid) expect(isHeatingShadowState(value)).toBe(false);
  });
});
