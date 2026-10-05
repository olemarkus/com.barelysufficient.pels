// Unit coverage for the live cheap/expensive level classification
// (`resolveCurrentPricePeriodLevel`) over the IMPORT price (`totalPrice`).
// This feeds thermostat price-opt deltas, the `price_level` flow trigger, and the
// pels_insights level capability. Solar never changes a level: a solar home's
// planning price (`budgetPrice`) is carried on the same entries for the
// schedulers, and these pins prove the classifier ignores it.
import { describe, expect, it } from 'vitest';
import {
  resolveCurrentPricePeriodLevel,
  resolvePriceLevelChangesWithin,
  resolvePriceLevelTimeline,
} from '../../lib/price/priceLevelUtils';
import { PriceLevel } from '../../lib/price/priceLevels';

const HOUR_MS = 60 * 60 * 1000;
const BASE_MS = Date.parse('2026-06-01T00:00:00Z');

const entry = (hour: number, totalPrice: number, budgetPrice?: number): {
  startsAt: string;
  totalPrice: number;
  durationMinutes: number;
  budgetPrice?: number;
} => ({
  startsAt: new Date(BASE_MS + hour * HOUR_MS).toISOString(),
  totalPrice,
  durationMinutes: 60,
  ...(budgetPrice === undefined ? {} : { budgetPrice }),
});

const classify = (prices: Array<ReturnType<typeof entry>>, level: 'cheap' | 'expensive'): boolean => (
  resolveCurrentPricePeriodLevel(
    prices,
    { thresholdPercent: 25, minDiff: 0 },
    BASE_MS + 30 * 60 * 1000, // mid hour 0
  ) === (level === 'cheap' ? PriceLevel.CHEAP : PriceLevel.EXPENSIVE)
);

describe('resolveCurrentPricePeriodLevel — import price only', () => {
  it('ignores a low planning price on the current hour: a flat-total day stays normal', () => {
    // Totals are flat, so no hour is cheap on the import price, even though
    // hour 0 carries a solar-lowered planning price.
    const prices = [entry(0, 100, 10), entry(1, 100), entry(2, 100), entry(3, 100)];
    expect(classify(prices, 'cheap')).toBe(false);
    expect(classify(prices, 'expensive')).toBe(false);
  });

  it('ignores a <= 0 planning price', () => {
    const prices = [entry(0, 100, -5), entry(1, 100), entry(2, 100), entry(3, 100)];
    expect(classify(prices, 'cheap')).toBe(false);
  });

  it('other hours’ planning prices do not move the average', () => {
    // On planning prices the average would drop to 32.5 and hour 0 would turn
    // expensive; on the import price every hour is 100 and nothing is.
    const prices = [entry(0, 100), entry(1, 100, 10), entry(2, 100, 10), entry(3, 100, 10)];
    expect(classify(prices, 'expensive')).toBe(false);
  });

  it('classifies the import price as before: avg 85, low 63.75 ⇒ hour 0 (40) is cheap', () => {
    expect(classify([entry(0, 40), entry(1, 100), entry(2, 100), entry(3, 100)], 'cheap')).toBe(true);
    expect(classify([entry(0, 100), entry(1, 100), entry(2, 100), entry(3, 100)], 'cheap')).toBe(false);
    expect(classify([entry(0, 100), entry(1, 100), entry(2, 100), entry(3, 100)], 'expensive')).toBe(false);
  });

  it('an import-cheap hour stays cheap whatever its planning price', () => {
    const prices = [entry(0, 40, 200), entry(1, 100, 10), entry(2, 100), entry(3, 100)];
    expect(classify(prices, 'cheap')).toBe(true);
  });
});

// The look-ahead behind the `price_level_changes_within` condition: which levels
// the price switches TO inside a window, classified against the same series
// average as the current level.
describe('resolvePriceLevelChangesWithin', () => {
  const BAND = { thresholdPercent: 25, minDiff: 0 };
  // Average 100 over the day; with a 25% band, 50 is cheap, 100 normal, 150 expensive.
  const day = [100, 100, 150, 150, 100, 50, 50, 100].map((total, hour) => entry(hour, total));
  const changes = (prices: Array<ReturnType<typeof entry>>, nowHours: number, horizonHours: number) => (
    resolvePriceLevelChangesWithin(prices, BAND, {
      nowMs: BASE_MS + nowHours * HOUR_MS,
      horizonMs: horizonHours * HOUR_MS,
    })
  );
  const resolved = (levels: PriceLevel[]) => ({ state: 'resolved', levels });

  it('reports each change in time order', () => {
    expect(changes(day, 0.5, 6)).toEqual(resolved([PriceLevel.EXPENSIVE, PriceLevel.NORMAL, PriceLevel.CHEAP]));
  });

  it('does not count the period in force, nor a following period at the same level', () => {
    // In hour 2 (expensive): hour 3 is expensive too, so it is no change.
    expect(changes(day, 2.5, 1)).toEqual(resolved([]));
    expect(changes(day, 2.5, 2)).toEqual(resolved([PriceLevel.NORMAL]));
  });

  it('includes a change starting exactly at the end of the window and excludes one starting now', () => {
    expect(changes(day, 1, 1)).toEqual(resolved([PriceLevel.EXPENSIVE]));
    expect(changes(day, 2, 1)).toEqual(resolved([]));
  });

  it('reports nothing past the last known price', () => {
    expect(changes(day, 7.5, 24)).toEqual(resolved([]));
  });

  it('counts a period after a gap in the prices as a change', () => {
    const withGap = day.filter((_, hour) => hour !== 4);
    // Hour 5 has no predecessor, so it is a change to cheap; hour 6 continues it.
    expect(changes(withGap, 3.5, 3)).toEqual(resolved([PriceLevel.CHEAP]));
  });

  it('follows quarter-hour periods', () => {
    const quarters = [100, 100, 150, 100, 50, 100, 100, 100].map((total, quarter) => ({
      startsAt: new Date(BASE_MS + quarter * 15 * 60 * 1000).toISOString(),
      totalPrice: total,
      durationMinutes: 15,
    }));
    expect(changes(quarters, 0.1, 1)).toEqual(resolved([PriceLevel.EXPENSIVE, PriceLevel.NORMAL, PriceLevel.CHEAP]));
  });

  it('is unavailable when no price period is in force now', () => {
    // A source that cannot price this period yields no periods, not an error;
    // that must not read as "no change is coming".
    expect(changes([], 0.5, 6)).toEqual({ state: 'unavailable' });
    expect(changes(day.slice(2), 0.5, 6)).toEqual({ state: 'unavailable' });
    expect(changes(day, 8.5, 6)).toEqual({ state: 'unavailable' });
  });

  it('reads the series in time order whatever order it arrives in', () => {
    expect(changes([...day].reverse(), 0.5, 6)).toEqual(changes(day, 0.5, 6));
  });

  it('agrees with the current level once each change starts', () => {
    for (let hour = 1; hour < day.length; hour += 1) {
      const startMs = BASE_MS + hour * HOUR_MS;
      const reported = changes(day, hour - 0.5, 0.5);
      const before = resolveCurrentPricePeriodLevel(day, BAND, startMs - 1);
      const after = resolveCurrentPricePeriodLevel(day, BAND, startMs);
      expect(reported).toEqual(resolved(before === after ? [] : [after]));
    }
  });
});

describe('resolvePriceLevelTimeline — the lines it states decide every level', () => {
  const series = [10, 35, 50, 60, 64, 66, 80, 100, 120, 140].map((price, hour) => entry(hour, price));

  it('classifies every period exactly as the stated lines say', () => {
    for (const band of [
      { thresholdPercent: 25, minDiff: 0 },
      { thresholdPercent: 10, minDiff: 30 },
      { thresholdPercent: 40, minDiff: 5 },
    ]) {
      const { periods, lines } = resolvePriceLevelTimeline(series, band);
      for (const period of periods) {
        let expected: 'cheap' | 'normal' | 'expensive' = 'normal';
        if (period.totalPrice <= lines.cheapAtOrBelow) expected = 'cheap';
        else if (period.totalPrice >= lines.expensiveFrom) expected = 'expensive';
        expect(period.level).toBe(expected);
      }
    }
  });

  it('moves a line out to the minimum difference when that is stricter than the percentage', () => {
    // Average 72.5: 10% puts the lines at 65.25 / 79.75, a 30 minimum difference
    // at 42.5 / 102.5, and a price must pass both.
    const { lines } = resolvePriceLevelTimeline(series, { thresholdPercent: 10, minDiff: 30 });
    expect(lines.average).toBeCloseTo(72.5, 9);
    expect(lines.cheapAtOrBelow).toBeCloseTo(42.5, 9);
    expect(lines.expensiveFrom).toBeCloseTo(102.5, 9);
  });

  it('agrees with the current level for the period in force', () => {
    const band = { thresholdPercent: 25, minDiff: 0 };
    const { periods } = resolvePriceLevelTimeline(series, band);
    expect(resolveCurrentPricePeriodLevel(series, band, BASE_MS + 30 * 60 * 1000)).toBe(periods[0]?.level);
  });
});

describe('resolvePriceLevelTimeline — negative prices', () => {
  it('keeps the lines ordered and consistent around a negative average', () => {
    // Average -10: 25% puts the band at -12.5 / -7.5, a minimum difference of 5
    // at -15 / -5, and a price must pass both.
    const series = [-30, -15, -12, -10, -8, -5, 10].map((price, hour) => entry(hour, price));
    const negativeAverage = [...series, entry(7, -10 * 8 - series.reduce((sum, item) => sum + item.totalPrice, 0))];
    const { periods, lines } = resolvePriceLevelTimeline(negativeAverage, { thresholdPercent: 25, minDiff: 5 });
    expect(lines.average).toBeCloseTo(-10, 9);
    expect(lines.cheapAtOrBelow).toBeCloseTo(-15, 9);
    expect(lines.expensiveFrom).toBeCloseTo(-5, 9);
    for (const period of periods) {
      let expected: 'cheap' | 'normal' | 'expensive' = 'normal';
      if (period.totalPrice <= lines.cheapAtOrBelow) expected = 'cheap';
      else if (period.totalPrice >= lines.expensiveFrom) expected = 'expensive';
      expect(period.level).toBe(expected);
    }
  });
});
