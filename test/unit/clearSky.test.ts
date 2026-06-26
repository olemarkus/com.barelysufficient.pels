import { describe, expect, it } from 'vitest';
import {
  clearSkyGhiHourly,
  clearSkyGhiWm2,
  dayOfYearUtc,
  equationOfTimeMin,
  solarDeclinationRad,
} from '../../packages/shared-domain/src/solar/clearSky';

// Reference locations.
const OSLO = { lat: 59.91, lon: 10.75 };
const EQUATOR = { lat: 0, lon: 0 };
const SVALBARD = { lat: 78.22, lon: 15.65 };

const DEG = Math.PI / 180;

describe('solar geometry primitives', () => {
  it('day of year is 1 on Jan 1 and ~172 on Jun 21 (UTC)', () => {
    expect(dayOfYearUtc(Date.UTC(2026, 0, 1, 12))).toBe(1);
    expect(dayOfYearUtc(Date.UTC(2026, 5, 21, 12))).toBe(172);
  });

  it('declination is ~+23.45° near the June solstice and ~−23.45° near December', () => {
    expect(solarDeclinationRad(172) / DEG).toBeCloseTo(23.45, 0); // ±0.5°
    expect(solarDeclinationRad(355) / DEG).toBeCloseTo(-23.45, 0);
    // Near the equinoxes declination passes through ~0.
    expect(Math.abs(solarDeclinationRad(80) / DEG)).toBeLessThan(2);
  });

  it('equation of time stays within its ±~16 min envelope', () => {
    for (let n = 1; n <= 365; n += 1) {
      expect(Math.abs(equationOfTimeMin(n))).toBeLessThan(17);
    }
  });
});

describe('clearSkyGhiWm2', () => {
  it('is zero when the sun is below the horizon (Oslo, local midnight)', () => {
    // 2026-01-15 23:00 UTC ≈ 00:00 local Oslo — deep night.
    expect(clearSkyGhiWm2(OSLO.lat, OSLO.lon, Date.UTC(2026, 0, 15, 23))).toBe(0);
  });

  it('peaks near the Haurwitz maximum at the equator on the equinox at solar noon', () => {
    // Equator, ~equinox, solar noon at lon 0 (≈12:08 UTC) → sun nearly overhead.
    const noon = clearSkyGhiWm2(EQUATOR.lat, EQUATOR.lon, Date.UTC(2026, 2, 20, 12, 8));
    expect(noon).toBeGreaterThan(1000);
    expect(noon).toBeLessThanOrEqual(1098); // Haurwitz A — the absolute ceiling
  });

  it('is far higher at summer noon than winter noon at high latitude (Oslo)', () => {
    // Oslo solar noon ≈ 11:18 UTC (lon 10.75, small EoT either season).
    const summerNoon = clearSkyGhiWm2(OSLO.lat, OSLO.lon, Date.UTC(2026, 5, 21, 11, 18));
    const winterNoon = clearSkyGhiWm2(OSLO.lat, OSLO.lon, Date.UTC(2026, 11, 21, 11, 18));
    expect(summerNoon).toBeGreaterThan(600);
    expect(winterNoon).toBeGreaterThan(0);
    expect(winterNoon).toBeLessThan(200); // low winter sun
    expect(summerNoon).toBeGreaterThan(winterNoon * 4);
  });

  it('rises from morning toward solar noon (Oslo summer)', () => {
    const morning = clearSkyGhiWm2(OSLO.lat, OSLO.lon, Date.UTC(2026, 5, 21, 6)); // ~08:00 local
    const noon = clearSkyGhiWm2(OSLO.lat, OSLO.lon, Date.UTC(2026, 5, 21, 11, 18));
    expect(noon).toBeGreaterThan(morning);
    expect(morning).toBeGreaterThan(0);
  });

  it('is symmetric about solar noon (equator, ±3h)', () => {
    const before = clearSkyGhiWm2(EQUATOR.lat, EQUATOR.lon, Date.UTC(2026, 2, 20, 9, 8));
    const after = clearSkyGhiWm2(EQUATOR.lat, EQUATOR.lon, Date.UTC(2026, 2, 20, 15, 8));
    expect(before).toBeGreaterThan(0);
    expect(before).toBeCloseTo(after, -1); // within ~10 W/m²·scale
    expect(Math.abs(before - after) / before).toBeLessThan(0.05);
  });

  it('returns zero all day during high-Arctic polar night (Svalbard, December)', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(clearSkyGhiWm2(SVALBARD.lat, SVALBARD.lon, Date.UTC(2026, 11, 21, hour))).toBe(0);
    }
  });
});

describe('clearSkyGhiHourly', () => {
  it('preserves order/length and zeroes night hours while peaking midday (Oslo summer)', () => {
    const dayStart = Date.UTC(2026, 5, 21, 0); // UTC day; Oslo is UTC+2 in summer
    const hourStarts = Array.from({ length: 24 }, (_, h) => dayStart + h * 3_600_000);
    const series = clearSkyGhiHourly(OSLO.lat, OSLO.lon, hourStarts);

    expect(series).toHaveLength(24);
    // A deep-night UTC hour is zero; the solar-noon hour (~11 UTC) is the max.
    expect(series[1]).toBe(0); // 01:00 UTC ≈ 03:00 local
    const maxVal = Math.max(...series);
    const maxIdx = series.indexOf(maxVal);
    expect(maxVal).toBeGreaterThan(600);
    expect(maxIdx).toBeGreaterThanOrEqual(10);
    expect(maxIdx).toBeLessThanOrEqual(12);
  });
});
