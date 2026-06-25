import {
  calculateAveragePrice,
  calculateThresholds,
  getPriceLevelFlags,
  isPriceAtLevel,
} from '../../lib/price/priceMath';

describe('priceMath', () => {
  it('calculates average price with non-finite filtering', () => {
    const avg = calculateAveragePrice(
      [{ v: 10 }, { v: NaN }, { v: 20 }, { v: Infinity }],
      (entry) => entry.v,
    );
    expect(avg).toBe(15);
  });

  it('returns zero average for empty inputs', () => {
    const avg = calculateAveragePrice([], () => 123);
    expect(avg).toBe(0);
  });

  it('calculates thresholds using percent', () => {
    const thresholds = calculateThresholds(100, 25);
    expect(thresholds.low).toBe(75);
    expect(thresholds.high).toBe(125);
  });

  it('keeps the cheap/expensive band ordered when the average is negative', () => {
    // NL midday negative spot under heavy solar: avg < 0 must not invert the
    // band. half-width = |avg| * pct, so low < high and the most-negative hour
    // is still "cheap".
    const thresholds = calculateThresholds(-10, 25);
    expect(thresholds.low).toBe(-12.5);
    expect(thresholds.high).toBe(-7.5);
    expect(thresholds.low).toBeLessThan(thresholds.high);

    const veryNegative = getPriceLevelFlags({
      price: -15,
      avgPrice: -10,
      thresholds,
      minDiff: 0,
    });
    expect(veryNegative.isCheap).toBe(true);
    expect(veryNegative.isExpensive).toBe(false);

    const lessNegative = getPriceLevelFlags({
      price: -5,
      avgPrice: -10,
      thresholds,
      minDiff: 0,
    });
    expect(lessNegative.isCheap).toBe(false);
    expect(lessNegative.isExpensive).toBe(true);
  });

  it('treats a zero average as a degenerate band gated by minDiff', () => {
    const thresholds = calculateThresholds(0, 25);
    expect(thresholds.low).toBe(0);
    expect(thresholds.high).toBe(0);
  });

  it('respects minDiff when resolving cheap/expensive', () => {
    const thresholds = { low: 75, high: 125 };
    const cheap = getPriceLevelFlags({
      price: 70,
      avgPrice: 100,
      thresholds,
      minDiff: 10,
    });
    expect(cheap.isCheap).toBe(true);
    expect(cheap.isExpensive).toBe(false);

    const blockedByMinDiff = getPriceLevelFlags({
      price: 74,
      avgPrice: 100,
      thresholds,
      minDiff: 30,
    });
    expect(blockedByMinDiff.isCheap).toBe(false);
    expect(blockedByMinDiff.isExpensive).toBe(false);

    const expensive = getPriceLevelFlags({
      price: 130,
      avgPrice: 100,
      thresholds,
      minDiff: 10,
    });
    expect(expensive.isCheap).toBe(false);
    expect(expensive.isExpensive).toBe(true);
  });

  it('isPriceAtLevel matches cheap/expensive', () => {
    const thresholds = { low: 75, high: 125 };
    expect(isPriceAtLevel({
      price: 70,
      avgPrice: 100,
      thresholds,
      minDiff: 10,
      level: 'cheap',
    })).toBe(true);
    expect(isPriceAtLevel({
      price: 130,
      avgPrice: 100,
      thresholds,
      minDiff: 10,
      level: 'expensive',
    })).toBe(true);
    expect(isPriceAtLevel({
      price: 80,
      avgPrice: 100,
      thresholds,
      minDiff: 30,
      level: 'cheap',
    })).toBe(false);
  });
});
