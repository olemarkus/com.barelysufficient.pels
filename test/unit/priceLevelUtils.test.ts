// Unit coverage for the live cheap/expensive level classification
// (`isCurrentHourAtLevel`) over the PLANNING price (`budgetPrice ?? totalPrice`).
// This feeds thermostat price-opt deltas, the `price_level` flow trigger, and the
// pels_insights level capability — all deliberately scheduling-consistent with the
// planner. Includes the non-prosumer invariance pins: absent or total-equal
// budgetPrice must classify byte-identically to the historical total-only path.
import { describe, expect, it } from 'vitest';
import { isCurrentHourAtLevel } from '../../lib/price/priceLevelUtils';

const HOUR_MS = 60 * 60 * 1000;
const BASE_MS = Date.parse('2026-06-01T00:00:00Z');

const entry = (hour: number, totalPrice: number, budgetPrice?: number): {
  startsAt: string;
  totalPrice: number;
  budgetPrice?: number;
} => ({
  startsAt: new Date(BASE_MS + hour * HOUR_MS).toISOString(),
  totalPrice,
  ...(budgetPrice === undefined ? {} : { budgetPrice }),
});

const classify = (prices: Array<ReturnType<typeof entry>>, level: 'cheap' | 'expensive'): boolean => (
  isCurrentHourAtLevel({
    prices,
    level,
    thresholdPercent: 25,
    minDiff: 0,
    nowMs: BASE_MS + 30 * 60 * 1000, // mid hour 0
  })
);

describe('isCurrentHourAtLevel — planning price', () => {
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
