import { describe, expect, it } from 'vitest';
import { summarizePriceLevels, suggestPriceThreshold } from '../../lib/price/priceLevelSummary';
import { resolvePriceLevelTimeline, type PriceLevelBand } from '../../lib/price/priceLevelUtils';
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
  const periods = [9.4, 10.1, 10.1, 10.4].map((price) => period(price));
  expect(suggestPriceThreshold({ periods, lines: linesFor(periods) }, BAND))
    .toEqual({ kind: 'lower_threshold', percent: 5, cheapUpTo: 9.4 });
});

it('suggests no threshold that would also mark a price expensive', () => {
  // At 5 % the expensive line is 10.5, so 10.6 would turn expensive.
  const periods = [9.4, 10, 10, 10.6].map((price) => period(price));
  expect(suggestPriceThreshold({ periods, lines: linesFor(periods) }, BAND)).toEqual({ kind: 'none' });
});

// The live classifier's levels and lines for hourly prices at a band.
const classified = (prices: number[], band: PriceLevelBand) => {
  const timeline = resolvePriceLevelTimeline(prices.map((totalPrice, hour) => ({
    startsAt: new Date(Date.UTC(2026, 9, 13, hour)).toISOString(), durationMinutes: 60, totalPrice,
  })), band);
  return {
    lines: timeline.lines,
    periods: timeline.periods.map((p) => period(p.totalPrice, p.level)),
  };
};

describe('suggestPriceThreshold, minimum difference', () => {
  // An owner's Norgespris days: the grid tariff alone moves the price, 73.84
  // øre from 22 to 06 and 87.84 øre by day; average 83.17. At 10 % the cheap
  // line would be 74.86, but the 10 øre minimum difference holds it at 73.17.
  const OWNER_DAYS = [...Array(16).fill(73.84), ...Array(32).fill(87.84)];
  const OWNER_BAND = { thresholdPercent: 10, minDiff: 10 };

  it('suggests the largest whole minimum difference that makes the cheapest quarter cheap', () => {
    const owner = classified(OWNER_DAYS, OWNER_BAND);
    expect(owner.periods.every((p) => p.level === 'normal')).toBe(true);

    expect(suggestPriceThreshold(owner, OWNER_BAND))
      .toEqual({ kind: 'lower_min_difference', minDifference: 9, cheapUpTo: 73.84 });
  });

  it('makes the nights cheap and nothing expensive at the suggested value', () => {
    const atNine = classified(OWNER_DAYS, { ...OWNER_BAND, minDiff: 9 });
    expect(atNine.periods.filter((p) => p.level === 'cheap')).toHaveLength(16);
    expect(atNine.periods.some((p) => p.level === 'expensive')).toBe(false);
  });

  it('keeps the percent suggestion when the percent is what keeps the prices normal', () => {
    const band = { thresholdPercent: 25, minDiff: 5 };
    expect(suggestPriceThreshold(classified(OWNER_DAYS, band), band))
      .toEqual({ kind: 'lower_threshold', percent: 11, cheapUpTo: 73.84 });
  });

  it('suggests nothing when both settings keep the prices normal, as no one change would do it', () => {
    const band = { thresholdPercent: 25, minDiff: 10 };
    expect(suggestPriceThreshold(classified(OWNER_DAYS, band), band)).toEqual({ kind: 'none' });
  });

  it('suggests nothing that would also mark a price expensive', () => {
    // Average 10: at a minimum difference of 2, 8 is cheap but 12 is expensive.
    const band = { thresholdPercent: 10, minDiff: 3 };
    const prices = [8, 8, 10, 10, 10, 10, 12, 12];
    const series = classified(prices, band);
    expect(series.periods.every((p) => p.level === 'normal')).toBe(true);
    expect(suggestPriceThreshold(series, band)).toEqual({ kind: 'none' });
  });

  it('suggests a step below a whole unit on a source priced in a currency', () => {
    // EUR: average 0.3975, the cheapest quarter at 0.320 is 0.0775 below it.
    const band = { thresholdPercent: 10, minDiff: 0.1 };
    const series = classified([...Array(6).fill(0.32), ...Array(18).fill(0.4233333333)], band);
    expect(suggestPriceThreshold(series, band)).toEqual({ kind: 'lower_min_difference', minDifference: 0.07, cheapUpTo: 0.32 });
  });
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
