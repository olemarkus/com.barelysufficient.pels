import { describe, expect, it } from 'vitest';
import {
  formatSolarNowSubline,
  resolveSolarNow,
  SOLAR_NOW_MIN_W,
} from '../../shared-domain/src/solar/solarNow.ts';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../shared-domain/src/powerFreshness.ts';

const NOW_MS = 1_750_000_000_000;

const freshInput = (overrides: Record<string, unknown> = {}) => ({
  lastPowerW: -2100,
  lastGenerationW: 3200,
  lastTimestamp: NOW_MS - 5_000,
  ...overrides,
});

describe('resolveSolarNow', () => {
  it('resolves the exporting triple from a fresh sample', () => {
    expect(resolveSolarNow(freshInput(), NOW_MS)).toEqual({
      producingW: 3200,
      exportingW: 2100,
      selfUsingW: 1100,
    });
  });

  it('resolves an all-used-at-home triple when net is positive', () => {
    expect(resolveSolarNow(freshInput({ lastPowerW: 400 }), NOW_MS)).toEqual({
      producingW: 3200,
      exportingW: 0,
      selfUsingW: 3200,
    });
  });

  it('battery-export edge: exporting above producing floors selfUsing at 0, export uncapped', () => {
    const resolved = resolveSolarNow(freshInput({ lastPowerW: -5000 }), NOW_MS);
    expect(resolved).toEqual({ producingW: 3200, exportingW: 5000, selfUsingW: 0 });
  });

  it.each([
    ['null input', null],
    ['missing lastPowerW', freshInput({ lastPowerW: undefined })],
    ['missing lastGenerationW', freshInput({ lastGenerationW: undefined })],
    ['missing lastTimestamp', freshInput({ lastTimestamp: undefined })],
    ['NaN power', freshInput({ lastPowerW: Number.NaN })],
    ['infinite generation', freshInput({ lastGenerationW: Number.POSITIVE_INFINITY })],
  ])('returns null for %s', (_label, input) => {
    expect(resolveSolarNow(input as never, NOW_MS)).toBeNull();
  });

  it('stale-gates on the shared power freshness threshold', () => {
    const stale = freshInput({ lastTimestamp: NOW_MS - POWER_SAMPLE_STALE_THRESHOLD_MS });
    expect(resolveSolarNow(stale, NOW_MS)).toBeNull();
    const justFresh = freshInput({ lastTimestamp: NOW_MS - POWER_SAMPLE_STALE_THRESHOLD_MS + 1 });
    expect(resolveSolarNow(justFresh, NOW_MS)).not.toBeNull();
  });

  it('hides asleep panels below the minimum production threshold', () => {
    expect(resolveSolarNow(freshInput({ lastGenerationW: SOLAR_NOW_MIN_W - 1 }), NOW_MS)).toBeNull();
    expect(resolveSolarNow(freshInput({ lastGenerationW: SOLAR_NOW_MIN_W }), NOW_MS)).not.toBeNull();
  });
});

describe('formatSolarNowSubline', () => {
  it('names the split while exporting materially (terse one-line form)', () => {
    expect(formatSolarNowSubline({ producingW: 3200, exportingW: 2100, selfUsingW: 1100 }))
      .toBe('Solar now 3.2\u00A0kW — 1.1\u00A0kW at home, 2.1\u00A0kW exported');
  });

  it('collapses to "all used at home" under the 50 W export threshold', () => {
    expect(formatSolarNowSubline({ producingW: 3200, exportingW: 30, selfUsingW: 3170 }))
      .toBe('Solar now 3.2\u00A0kW — all used at home');
  });
});
