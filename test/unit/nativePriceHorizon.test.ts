import { describe, expect, it } from 'vitest';
import { buildMeteredPricePeriods, buildPriceHorizonFromPeriods, retainServedMeteredPeriods } from '../../lib/price/priceHorizon';
import type { MeteredPricePeriod } from '../../packages/planner-types/src/priceHorizon';
import type { CombinedPricePeriod } from '../../lib/price/priceTypes';

const MINUTE_MS = 60_000;
const QUARTER_MS = 15 * MINUTE_MS;
const BASE = Date.parse('2026-10-25T00:00:00Z');

const period = (offsetMinutes: number, price: number, durationMinutes = 15): CombinedPricePeriod => ({
  startsAt: new Date(BASE + offsetMinutes * MINUTE_MS).toISOString(),
  durationMinutes,
  totalPrice: price,
});

describe('native Smart-task price horizon', () => {
  it('preserves separate cheap quarters, negative prices and import money prices', () => {
    const periods = [period(0, 10), period(15, -2), period(30, 9), { ...period(45, 8), budgetPrice: -3 }];
    expect(buildPriceHorizonFromPeriods(periods, BASE, BASE + 4 * QUARTER_MS)).toEqual([
      { startMs: BASE, endMs: BASE + QUARTER_MS, price: 10, moneyPrice: 10 },
      { startMs: BASE + QUARTER_MS, endMs: BASE + 2 * QUARTER_MS, price: -2, moneyPrice: -2 },
      { startMs: BASE + 2 * QUARTER_MS, endMs: BASE + 3 * QUARTER_MS, price: 9, moneyPrice: 9 },
      { startMs: BASE + 3 * QUARTER_MS, endMs: BASE + 4 * QUARTER_MS, price: -3, moneyPrice: 8 },
    ]);
  });

  it('returns intersecting periods with their original bounds and does not bridge a missing quarter', () => {
    const periods = [period(0, 1), period(15, 2), period(45, 4), period(60, 5)];
    expect(buildPriceHorizonFromPeriods(periods, BASE + 20 * MINUTE_MS, BASE + 52 * MINUTE_MS)).toEqual([
      { startMs: BASE + QUARTER_MS, endMs: BASE + 2 * QUARTER_MS, price: 2, moneyPrice: 2 },
      { startMs: BASE + 3 * QUARTER_MS, endMs: BASE + 4 * QUARTER_MS, price: 4, moneyPrice: 4 },
    ]);
  });

  it('retains hourly periods and fractional-offset source boundaries', () => {
    const startMs = Date.parse('2026-01-01T00:00:00+05:45');
    const source = [{ startsAt: new Date(startMs).toISOString(), durationMinutes: 60, totalPrice: 2 }];
    expect(buildPriceHorizonFromPeriods(source, startMs, startMs + 60 * MINUTE_MS)).toEqual([
      { startMs, endMs: startMs + 60 * MINUTE_MS, price: 2, moneyPrice: 2 },
    ]);
  });

  it.each([
    ['2026-03-29T00:00:00+01:00', '2026-03-30T00:00:00+02:00', 92],
    ['2026-10-25T00:00:00+02:00', '2026-10-26T00:00:00+01:00', 100],
  ])('preserves every quarter of the DST day beginning %s', (start, end, count) => {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    const periods = Array.from({ length: count }, (_, index) => ({
      startsAt: new Date(startMs + index * QUARTER_MS).toISOString(),
      durationMinutes: 15,
      totalPrice: index,
    }));
    const horizon = buildPriceHorizonFromPeriods(periods, startMs, endMs);
    expect(horizon).toHaveLength(count);
    expect(horizon.at(-1)?.endMs).toBe(endMs);
    expect(horizon.reduce((duration, entry) => duration + entry.endMs - entry.startMs, 0)).toBe(endMs - startMs);
  });
});

describe('native metered prices', () => {
  it('uses import prices and import levels even when solar makes an expensive quarter attractive', () => {
    const prices = [period(0, -2), period(15, 4), { ...period(45, 10), budgetPrice: -5 }];
    const costDisplay = { unit: 'SEK', divisor: 1 };
    expect(buildMeteredPricePeriods(prices, { thresholdPercent: 25, minDiff: 0 }, costDisplay)).toEqual([
      { startMs: BASE, endMs: BASE + QUARTER_MS, priceValue: -2, tone: 'cheap', costDisplay },
      {
        startMs: BASE + QUARTER_MS,
        endMs: BASE + 2 * QUARTER_MS,
        priceValue: 4,
        tone: 'normal',
        costDisplay,
      },
      {
        startMs: BASE + 3 * QUARTER_MS,
        endMs: BASE + 4 * QUARTER_MS,
        priceValue: 10,
        tone: 'expensive',
        costDisplay,
      },
    ]);
  });
});

describe('served metered prices', () => {
  const NOK = { unit: 'kr', divisor: 1 };
  const metered = (offsetMinutes: number, priceValue: number, costDisplay = NOK): MeteredPricePeriod => ({
    startMs: BASE + offsetMinutes * MINUTE_MS,
    endMs: BASE + (offsetMinutes + 15) * MINUTE_MS,
    priceValue,
    tone: 'normal',
    costDisplay,
  });

  it('keeps a started period whose day left the series, as it was served', () => {
    const retained = retainServedMeteredPeriods([metered(-15, 9), metered(0, 4)], [metered(0, 1)], BASE + MINUTE_MS);
    expect(retained).toEqual([metered(-15, 9), metered(0, 1)]);
  });

  it('drops a withdrawn future period, a period past retention and a period in another currency', () => {
    const nowMs = BASE + MINUTE_MS;
    expect(retainServedMeteredPeriods([metered(15, 7)], [metered(0, 1)], nowMs)).toEqual([metered(0, 1)]);
    expect(retainServedMeteredPeriods([metered(-25 * 60, 7)], [metered(0, 1)], nowMs)).toEqual([metered(0, 1)]);
    const ore = { unit: 'øre', divisor: 100 };
    expect(retainServedMeteredPeriods([metered(-15, 9)], [metered(0, 1, ore)], nowMs)).toEqual([metered(0, 1, ore)]);
  });
});
