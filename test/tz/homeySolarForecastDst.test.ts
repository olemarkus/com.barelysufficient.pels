import { describe, expect, it } from 'vitest';
import { getDateKeyStartMs, shiftDateKey } from '../../lib/utils/dateUtils';
import { HomeyEnergySolarForecastSource } from '../../lib/solar/homeyEnergySolarForecast';

// The Homey solar forecast is queried by LOCAL calendar date but its points are
// UTC-stamped, so the two queried dates must cover every hour of a 23-hour
// spring-forward day (Oslo 2026-03-29) and a 25-hour fall-back day
// (2026-10-25) with UTC-keyed buckets and no gap or overlap at the seam.
const OSLO = 'Europe/Oslo';
const HOUR_MS = 3_600_000;
const QUARTER_MS = 15 * 60_000;

/** A full day of 15-min points spanning the LOCAL day (92/96/100 points on 23/24/25 h days). */
const dayBody = (dateKey: string): unknown => {
  const startMs = getDateKeyStartMs(dateKey, OSLO);
  const endMs = getDateKeyStartMs(shiftDateKey(dateKey, 1), OSLO);
  const points = [];
  for (let atMs = startMs; atMs < endMs; atMs += QUARTER_MS) {
    points.push({ t: new Date(atMs).toISOString(), watts: 1000 });
  }
  return { resolution: 15, points, totalWh: null };
};

const makeSource = (): HomeyEnergySolarForecastSource => new HomeyEnergySolarForecastSource({
  fetchForecastDay: async (dateKey) => ({ kind: 'resolved', body: dayBody(dateKey) }),
  getTimeZone: () => OSLO,
  getNowMs: () => 0,
});

const coveredHours = async (dateKey: string): Promise<number> => {
  const source = makeSource();
  const nowMs = getDateKeyStartMs(dateKey, OSLO);
  await source.refresh(nowMs);
  const endMs = getDateKeyStartMs(shiftDateKey(dateKey, 2), OSLO);
  const hourStarts = [];
  for (let atMs = nowMs; atMs < endMs; atMs += HOUR_MS) hourStarts.push(atMs);
  const forecast = source.forecast(hourStarts);
  // Every queried hour must be covered exactly once with the 1 kW mean.
  expect(forecast.every((hour) => hour.generationKwh === 1)).toBe(true);
  return forecast.length;
};

describe('Homey solar forecast across DST transitions (Europe/Oslo)', () => {
  it('covers all 23 + 24 hours across the spring-forward day pair', async () => {
    expect(await coveredHours('2026-03-29')).toBe(23 + 24);
  });

  it('covers all 25 + 24 hours across the fall-back day pair', async () => {
    expect(await coveredHours('2026-10-25')).toBe(25 + 24);
  });

  it('covers a plain 24 + 24 hour pair', async () => {
    expect(await coveredHours('2026-01-10')).toBe(48);
  });
});
