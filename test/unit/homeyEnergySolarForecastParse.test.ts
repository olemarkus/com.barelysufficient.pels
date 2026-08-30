import { describe, expect, it } from 'vitest';
import { parseSolarForecastDay } from '../../lib/solar/homeyEnergySolarForecast';

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 7, 25); // 2026-08-25T00:00:00Z

const isoAt = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const quarterPoints = (hourOffset: number, watts: number[]): Array<{ t: string; watts: number }> => (
  watts.map((w, index) => ({ t: isoAt(hourOffset * HOUR_MS + index * 15 * 60_000), watts: w }))
);

describe('parseSolarForecastDay', () => {
  it('buckets a full 96-point day into 24 hourly mean kWh values', () => {
    const points = Array.from({ length: 96 }, (_, index) => ({
      t: isoAt(index * 15 * 60_000),
      watts: 1000,
    }));
    const day = parseSolarForecastDay({ resolution: 15, points, totalWh: 24_000 });
    expect(Object.keys(day.kwhByHourStart)).toHaveLength(24);
    expect(day.kwhByHourStart[String(T0)]).toBe(1);
    expect(day.kwhByHourStart[String(T0 + 23 * HOUR_MS)]).toBe(1);
    expect(day.totalWh).toEqual({ kind: 'reported', wh: 24_000 });
  });

  it('averages the points within each hour (mean watts / 1000 = kWh)', () => {
    const day = parseSolarForecastDay({
      points: quarterPoints(6, [100, 200, 300, 400]),
    });
    expect(day.kwhByHourStart[String(T0 + 6 * HOUR_MS)]).toBeCloseTo(0.25);
  });

  it('averages over only the valid points of a ragged hour', () => {
    const day = parseSolarForecastDay({
      points: [
        { t: isoAt(6 * HOUR_MS), watts: 400 },
        { t: isoAt(6 * HOUR_MS + 15 * 60_000), watts: 200 },
      ],
    });
    expect(day.kwhByHourStart[String(T0 + 6 * HOUR_MS)]).toBeCloseTo(0.3);
  });

  it('drops junk points instead of fabricating values', () => {
    const day = parseSolarForecastDay({
      points: [
        { t: 'not-a-date', watts: 100 },
        { t: isoAt(0), watts: Number.NaN },
        { t: isoAt(0), watts: Number.POSITIVE_INFINITY },
        { t: isoAt(0), watts: -5 },
        { t: isoAt(0) }, // missing watts
        42, // not even an object
        { t: isoAt(HOUR_MS), watts: 500 }, // the one valid point
      ],
      totalWh: 'junk',
    });
    expect(day.kwhByHourStart).toEqual({ [String(T0 + HOUR_MS)]: 0.5 });
    expect(day.totalWh).toEqual({ kind: 'absent' });
  });

  it('yields an empty map (never zeros) for empty or malformed bodies', () => {
    expect(parseSolarForecastDay({ points: [] }).kwhByHourStart).toEqual({});
    expect(parseSolarForecastDay({}).kwhByHourStart).toEqual({});
    expect(parseSolarForecastDay(null).kwhByHourStart).toEqual({});
    expect(parseSolarForecastDay('html error page').kwhByHourStart).toEqual({});
    expect(parseSolarForecastDay([1, 2, 3]).kwhByHourStart).toEqual({});
  });

  it('keeps a zero-watts hour as an explicit 0 (night hours are data, not absence)', () => {
    const day = parseSolarForecastDay({ points: quarterPoints(0, [0, 0, 0, 0]) });
    expect(day.kwhByHourStart[String(T0)]).toBe(0);
  });
});
