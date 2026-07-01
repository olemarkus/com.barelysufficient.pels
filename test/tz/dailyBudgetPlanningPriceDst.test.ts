// DST regression for the daily-budget planning-price series: on a 23h
// (spring-forward) and a 25h (fall-back) local day, `buildPriceSeriesPair`
// must join per-hour price entries onto the DST-sized bucket grid 1:1 — money
// on `total`, planning on `budgetPrice ?? total` — including the repeated
// local hour on fall-back. Runs across the tz lane's host TZ values (the
// bucket math takes an explicit app timeZone, so results must not depend on
// the host zone).
import { describe, expect, it } from 'vitest';
import { buildPriceSeriesPair } from '../../lib/dailyBudget/dailyBudgetPrices';
import { buildLocalDayBuckets, getDateKeyStartMs, getNextLocalDayStartUtcMs } from '../../lib/utils/dateUtils';

const OSLO = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;

const bucketsForLocalDay = (dateKey: string): number[] => {
  const dayStartUtcMs = getDateKeyStartMs(dateKey, OSLO);
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, OSLO);
  return buildLocalDayBuckets({ dayStartUtcMs, nextDayStartUtcMs, timeZone: OSLO }).bucketStartUtcMs;
};

describe('buildPriceSeriesPair — DST-sized local days (Europe/Oslo app zone)', () => {
  it.each([
    { label: 'spring-forward 23h day', dateKey: '2026-03-29', expectedBuckets: 23 },
    { label: 'fall-back 25h day', dateKey: '2026-10-25', expectedBuckets: 25 },
  ])('joins every bucket of the $label, planning price only where budgetPrice diverges', ({
    dateKey,
    expectedBuckets,
  }) => {
    const bucketStartUtcMs = bucketsForLocalDay(dateKey);
    expect(bucketStartUtcMs).toHaveLength(expectedBuckets); // sanity: DST day size

    // One entry per DST-day hour; the LAST bucket (deep into the odd-length
    // day, past any duplicated/skipped local hour) carries a diverging
    // planning price.
    const surplusIndex = expectedBuckets - 1;
    const combinedPrices = {
      prices: bucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: 100,
        ...(index === surplusIndex ? { budgetPrice: 10 } : {}),
      })),
    };

    const pair = buildPriceSeriesPair({ bucketStartUtcMs, combinedPrices });
    expect(pair?.prices).toEqual(Array.from({ length: expectedBuckets }, () => 100));
    expect(pair?.planningPrices).toEqual(
      Array.from({ length: expectedBuckets }, (_, index) => (index === surplusIndex ? 10 : 100)),
    );
  });

  it('fall-back: the two entries of the repeated local hour keep distinct planning prices', () => {
    const bucketStartUtcMs = bucketsForLocalDay('2026-10-25');
    // Oslo falls back 03:00 → 02:00: local 02:xx occurs twice, at UTC 00:00 and 01:00.
    const firstTwoAmUtcMs = getDateKeyStartMs('2026-10-25', OSLO) + 2 * HOUR_MS;
    const secondTwoAmUtcMs = firstTwoAmUtcMs + HOUR_MS;
    const combinedPrices = {
      prices: bucketStartUtcMs.map((ts) => ({
        startsAt: new Date(ts).toISOString(),
        total: 100,
        // Only the FIRST occurrence of the repeated local hour has surplus.
        ...(ts === firstTwoAmUtcMs ? { budgetPrice: 5 } : {}),
      })),
    };
    const pair = buildPriceSeriesPair({ bucketStartUtcMs, combinedPrices });
    const firstIndex = bucketStartUtcMs.indexOf(firstTwoAmUtcMs);
    const secondIndex = bucketStartUtcMs.indexOf(secondTwoAmUtcMs);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBe(firstIndex + 1);
    expect(pair?.planningPrices?.[firstIndex]).toBe(5);
    expect(pair?.planningPrices?.[secondIndex]).toBe(100); // the repeat is NOT smeared
    expect(pair?.prices?.[firstIndex]).toBe(100);
  });
});
