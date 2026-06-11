import { getDateKeyInTimeZone, getDateKeyStartMs } from '../../lib/utils/dateUtils';
import { resolveDailyKwh } from '../../lib/weather/dailyKwhResolve';
import { getLocalHourKey, rollupDay } from '../../lib/weather/weatherHistory';
import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';

// Weather rollups key everything by Homey-local calendar days, so both Oslo
// DST transitions are exercised:
//   - Spring-forward: 2026-03-29 has 23 local hours.
//   - Fall-back:      2026-10-25 has 25 local hours.
const OSLO = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;

const dayLengthHours = (dateKey: string, nextDateKey: string): number => (
  (getDateKeyStartMs(nextDateKey, OSLO) - getDateKeyStartMs(dateKey, OSLO)) / HOUR_MS
);

const stateWithAccumulator = (dateKey: string, count: number): WeatherHistoryState => ({
  records: [],
  accumulators: { [dateKey]: { sumC: 0, count, minC: -1, maxC: 1 } },
});

describe('weather history across DST transitions (Europe/Oslo)', () => {
  it('derives 23- and 25-hour day lengths from local day boundaries', () => {
    expect(dayLengthHours('2026-03-29', '2026-03-30')).toBe(23);
    expect(dayLengthHours('2026-10-25', '2026-10-26')).toBe(25);
    expect(dayLengthHours('2026-01-10', '2026-01-11')).toBe(24);
  });

  it('scales the partial-temperature threshold with the local day length', () => {
    // 23-hour day: threshold is 17 samples.
    const springFull = rollupDay(stateWithAccumulator('2026-03-29', 17), {
      dateKey: '2026-03-29', dayLengthHours: 23, kwhTotal: 30, unreliablePower: false,
    });
    expect(springFull.records[0].quality.partialTemp).toBe(false);
    const springPartial = rollupDay(stateWithAccumulator('2026-03-29', 16), {
      dateKey: '2026-03-29', dayLengthHours: 23, kwhTotal: 30, unreliablePower: false,
    });
    expect(springPartial.records[0].quality.partialTemp).toBe(true);

    // 25-hour day: threshold is 19 samples — 18 hourly samples is not enough.
    const fallPartial = rollupDay(stateWithAccumulator('2026-10-25', 18), {
      dateKey: '2026-10-25', dayLengthHours: 25, kwhTotal: 30, unreliablePower: false,
    });
    expect(fallPartial.records[0].quality.partialTemp).toBe(true);
    const fallFull = rollupDay(stateWithAccumulator('2026-10-25', 19), {
      dateKey: '2026-10-25', dayLengthHours: 25, kwhTotal: 30, unreliablePower: false,
    });
    expect(fallFull.records[0].quality.partialTemp).toBe(false);
  });

  it('maps both occurrences of the repeated fall-back hour to the same local hour key', () => {
    // 2026-10-25 02:30 happens twice in Oslo: CEST (00:30Z) and CET (01:30Z).
    expect(getLocalHourKey(new Date(Date.UTC(2026, 9, 25, 0, 30, 0)), OSLO)).toBe('02');
    expect(getLocalHourKey(new Date(Date.UTC(2026, 9, 25, 1, 30, 0)), OSLO)).toBe('02');
  });

  it('sums exactly the 23/25 UTC-hour buckets of a DST-transition local day', () => {
    const bucketsForDay = (dateKey: string, nextDateKey: string): Record<string, number> => {
      const startMs = getDateKeyStartMs(dateKey, OSLO);
      const endMs = getDateKeyStartMs(nextDateKey, OSLO);
      const entries: Array<[string, number]> = [];
      for (let ts = startMs; ts < endMs; ts += HOUR_MS) {
        entries.push([new Date(ts).toISOString(), 1]);
      }
      return Object.fromEntries(entries);
    };
    const spring = resolveDailyKwh({
      dateKey: '2026-03-29',
      timeZone: OSLO,
      source: { buckets: bucketsForDay('2026-03-29', '2026-03-30') },
    });
    expect(spring.total).toBe(23);
    const fall = resolveDailyKwh({
      dateKey: '2026-10-25',
      timeZone: OSLO,
      source: { buckets: bucketsForDay('2026-10-25', '2026-10-26') },
    });
    expect(fall.total).toBe(25);
  });

  it('maps a +24h forecast target to the correct local day and hour across spring-forward', () => {
    // Saturday 12:15 CET + 24 h = Sunday 13:15 CEST (the clock jumped forward).
    const nowMs = Date.UTC(2026, 2, 28, 11, 15, 0);
    const target = new Date(nowMs + 24 * HOUR_MS);
    expect(getDateKeyInTimeZone(target, OSLO)).toBe('2026-03-29');
    expect(getLocalHourKey(target, OSLO)).toBe('13');
  });
});
