import { describe, expect, it } from 'vitest';
import { forecastPvKwh } from '../../packages/shared-domain/src/solar/pvForecast';

const GAIN = 0.0005;

describe('forecastPvKwh', () => {
  it('is gain × irradiance', () => {
    expect(forecastPvKwh(GAIN, 800)).toBeCloseTo(GAIN * 800, 9);
    expect(forecastPvKwh(GAIN, 250)).toBeCloseTo(GAIN * 250, 9);
  });

  it('is zero at night / no irradiance', () => {
    expect(forecastPvKwh(GAIN, 0)).toBe(0);
  });

  it('never goes negative and tolerates bad inputs', () => {
    expect(forecastPvKwh(GAIN, -100)).toBe(0); // negative irradiance clamped
    expect(forecastPvKwh(-1, 800)).toBe(0); // negative gain ⇒ no negative generation
    expect(forecastPvKwh(GAIN, Number.NaN)).toBe(0);
  });
});
