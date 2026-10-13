import { describe, expect, it } from 'vitest';
import { summarizePriceLevels, suggestPriceThreshold } from '../../lib/price/priceLevelSummary';
import type { PriceTimelinePeriod } from '../../packages/contracts/src/priceTimeline';

const period = (importPrice: number, level: PriceTimelinePeriod['level'] = 'normal'): PriceTimelinePeriod => ({
  startsAt: '2026-10-13T00:00:00.000Z', durationMinutes: 60, importPrice, level,
});

// Norgespris in NO4: a fixed electricity price, so only the grid tariff moves
// the price: about 68 øre at night and 79 øre by day.
const NORGESPRIS_DAY = [...Array(8).fill(68), ...Array(16).fill(79)].map((price) => period(price));
const average = (prices: number[]) => prices.reduce((sum, price) => sum + price, 0) / prices.length;
const linesFor = (periods: PriceTimelinePeriod[]) => {
  const avg = average(periods.map((p) => p.importPrice));
  return { average: avg, cheapAtOrBelow: avg * 0.75, expensiveFrom: avg * 1.25 };
};
const BAND = { thresholdPercent: 25, minDiff: 0 };

describe('suggestPriceThreshold', () => {
  it('suggests the threshold at which the cheapest quarter counts as cheap when nothing does', () => {
    const suggestion = suggestPriceThreshold({ periods: NORGESPRIS_DAY, lines: linesFor(NORGESPRIS_DAY) }, BAND);

    // Average 75.33; 68 is 9.7 % below it.
    expect(suggestion).toEqual({ kind: 'lower_threshold', percent: 9, cheapUpTo: 68 });
  });

  it('suggests nothing while some price already counts as cheap or expensive', () => {
    const periods = [period(40, 'cheap'), ...NORGESPRIS_DAY.slice(1)];
    expect(suggestPriceThreshold({ periods, lines: linesFor(periods) }, BAND)).toEqual({ kind: 'none' });
  });

  it('suggests nothing for prices too flat to separate, or that the minimum difference keeps normal', () => {
    const flat = Array.from({ length: 24 }, (_, hour) => period(hour < 6 ? 74 : 76));
    expect(suggestPriceThreshold({ periods: flat, lines: linesFor(flat) }, BAND)).toEqual({ kind: 'none' });
    expect(suggestPriceThreshold({ periods: NORGESPRIS_DAY, lines: linesFor(NORGESPRIS_DAY) }, { ...BAND, minDiff: 10 }))
      .toEqual({ kind: 'none' });
  });
});

it('suggests only a threshold the classifier agrees with on the exact boundary', () => {
  // Average 10; 9.4 is exactly 6 % below it, but in floating point the 6 % line
  // lands a hair under 9.4, so 6 % would still leave it normal.
  const periods = [9.4, 10, 10, 10.6].map((price) => period(price));
  expect(suggestPriceThreshold({ periods, lines: linesFor(periods) }, BAND))
    .toEqual({ kind: 'lower_threshold', percent: 5, cheapUpTo: 9.4 });
});

describe('summarizePriceLevels', () => {
  it('states the lines, what the prices reach and which levels occur', () => {
    const periods = [period(40, 'cheap'), period(70), period(120, 'expensive')];
    const lines = linesFor(periods);

    expect(summarizePriceLevels({ periods, lines, priceUnit: 'øre/kWh' }, BAND)).toEqual({
      lines,
      lowest: 40,
      highest: 120,
      hasCheap: true,
      hasExpensive: true,
      priceUnit: 'øre/kWh',
      suggestion: { kind: 'none' },
    });
  });
});
