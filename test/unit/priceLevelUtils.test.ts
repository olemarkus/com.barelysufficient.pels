// Unit coverage for the live cheap/expensive level classification
// (`resolveCurrentPricePeriodLevel`) over the PLANNING price (`budgetPrice ?? totalPrice`).
// This feeds thermostat price-opt deltas, the `price_level` flow trigger, and the
// pels_insights level capability — all deliberately scheduling-consistent with the
// planner. Includes the non-prosumer invariance pins: absent or total-equal
// budgetPrice must classify byte-identically to the historical total-only path.
import { describe, expect, it } from 'vitest';
import { resolveCurrentPricePeriodLevel, resolvePriceLevelChangesWithin } from '../../lib/price/priceLevelUtils';
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

describe('resolveCurrentPricePeriodLevel — planning price', () => {
  it('classifies over budgetPrice when present: a flat-total hour with surplus becomes cheap', () => {
    // Totals are flat (no hour is cheap on total), but hour 0 carries a low
    // planning price. Average over planning prices = (10+100+100+100)/4 = 77.5;
    // low threshold = 58.125 ⇒ hour 0 (10) is cheap.
    const prices = [entry(0, 100, 10), entry(1, 100), entry(2, 100), entry(3, 100)];
    expect(classify(prices, 'cheap')).toBe(true);
    expect(classify(prices, 'expensive')).toBe(false);
  });

  it('a <= 0 planning price is legal and classifies as cheap (never clamped)', () => {
    const prices = [entry(0, 100, -5), entry(1, 100), entry(2, 100), entry(3, 100)];
    expect(classify(prices, 'cheap')).toBe(true);
  });

  it('other hours’ budgetPrice moves the average even when the current hour has none', () => {
    // Current hour total 100; other hours plan at 10 ⇒ planning avg =
    // (100+10+10+10)/4 = 32.5, high threshold = 40.625 ⇒ hour 0 is expensive.
    const prices = [entry(0, 100), entry(1, 100, 10), entry(2, 100, 10), entry(3, 100, 10)];
    expect(classify(prices, 'expensive')).toBe(true);
  });

  it('a non-finite budgetPrice falls back to the total (boundary junk cannot flip the level)', () => {
    const junk = [entry(0, 100, Number.NaN), entry(1, 100), entry(2, 100), entry(3, 100)];
    expect(classify(junk, 'cheap')).toBe(false);
    expect(classify(junk, 'expensive')).toBe(false);
  });

  it('invariance: entries without budgetPrice classify exactly as the total-only path', () => {
    // Historical behaviour pin: avg = (40+100+100+100)/4 = 85, low = 63.75 ⇒
    // hour 0 (40) cheap; and a flat series is neither cheap nor expensive.
    expect(classify([entry(0, 40), entry(1, 100), entry(2, 100), entry(3, 100)], 'cheap')).toBe(true);
    expect(classify([entry(0, 100), entry(1, 100), entry(2, 100), entry(3, 100)], 'cheap')).toBe(false);
    expect(classify([entry(0, 100), entry(1, 100), entry(2, 100), entry(3, 100)], 'expensive')).toBe(false);
  });

  it('invariance: budgetPrice === totalPrice on every entry is byte-identical to no budgetPrice', () => {
    const totals = [40, 100, 100, 100];
    const withEqualBudget = totals.map((total, hour) => entry(hour, total, total));
    const without = totals.map((total, hour) => entry(hour, total));
    for (const level of ['cheap', 'expensive'] as const) {
      expect(classify(withEqualBudget, level)).toBe(classify(without, level));
    }
    expect(classify(withEqualBudget, 'cheap')).toBe(true);
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

  it('reports each change in time order', () => {
    expect(changes(day, 0.5, 6)).toEqual([PriceLevel.EXPENSIVE, PriceLevel.NORMAL, PriceLevel.CHEAP]);
  });

  it('does not count the period in force, nor a following period at the same level', () => {
    // In hour 2 (expensive): hour 3 is expensive too, so it is no change.
    expect(changes(day, 2.5, 1)).toEqual([]);
    expect(changes(day, 2.5, 2)).toEqual([PriceLevel.NORMAL]);
  });

  it('includes a change starting exactly at the end of the window and excludes one starting now', () => {
    expect(changes(day, 1, 1)).toEqual([PriceLevel.EXPENSIVE]);
    expect(changes(day, 2, 1)).toEqual([]);
  });

  it('reports nothing past the last known price', () => {
    expect(changes(day, 7.5, 24)).toEqual([]);
  });

  it('counts a period after a gap in the prices as a change', () => {
    const withGap = day.filter((_, hour) => hour !== 4);
    // Hour 5 has no predecessor, so it is a change to cheap; hour 6 continues it.
    expect(changes(withGap, 3.5, 3)).toEqual([PriceLevel.CHEAP]);
  });

  it('follows quarter-hour periods', () => {
    const quarters = [100, 100, 150, 100, 50, 100, 100, 100].map((total, quarter) => ({
      startsAt: new Date(BASE_MS + quarter * 15 * 60 * 1000).toISOString(),
      totalPrice: total,
      durationMinutes: 15,
    }));
    expect(changes(quarters, 0.1, 1)).toEqual([PriceLevel.EXPENSIVE, PriceLevel.NORMAL, PriceLevel.CHEAP]);
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
      expect(reported).toEqual(before === after ? [] : [after]);
    }
  });
});
