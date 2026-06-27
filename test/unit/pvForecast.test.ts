import { describe, expect, it } from 'vitest';
import { forecastPvKwh, forecastPvSeries } from '../../packages/shared-domain/src/solar/pvForecast';

const GAIN = 0.0005;

describe('forecastPvKwh', () => {
  it('is gain × clear-sky × clearness', () => {
    expect(forecastPvKwh(GAIN, 800, 0)).toBeCloseTo(GAIN * 800, 9);
    expect(forecastPvKwh(GAIN, 800, 0.25)).toBeCloseTo(GAIN * 800 * 0.75, 9);
  });

  it('is zero at night and under full overcast', () => {
    expect(forecastPvKwh(GAIN, 0, 0)).toBe(0); // night
    expect(forecastPvKwh(GAIN, 900, 1)).toBe(0); // overcast
  });

  it('never goes negative and tolerates bad inputs', () => {
    expect(forecastPvKwh(GAIN, -100, 0)).toBe(0); // negative clear-sky clamped
    expect(forecastPvKwh(-1, 800, 0)).toBe(0); // negative gain ⇒ no negative generation
    expect(forecastPvKwh(GAIN, 800, Number.NaN)).toBe(0); // unknown cloud ⇒ assume overcast
  });
});

describe('forecastPvSeries', () => {
  it('forecasts each forward hour in order', () => {
    const series = forecastPvSeries(GAIN, [
      { clearSkyWm2: 0, cloudFraction: 0 }, // night
      { clearSkyWm2: 600, cloudFraction: 0.5 },
      { clearSkyWm2: 1000, cloudFraction: 0 },
    ]);
    expect(series).toEqual([0, GAIN * 600 * 0.5, GAIN * 1000]);
  });
});
