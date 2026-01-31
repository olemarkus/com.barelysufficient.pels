import {
  calculateAveragePrice,
  calculateThresholds,
  getPriceLevelFlags,
  isPriceAtLevel,
} from '../lib/price/priceMath';

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
