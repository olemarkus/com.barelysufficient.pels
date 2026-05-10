import { describe, expect, test } from 'vitest';
import { buildCombinedPricePayload, pruneCombinedPricesV2 } from '../../../lib/price/priceServiceCombined';
import type { CombinedHourlyPrice, CombinedPricesV2 } from '../../../lib/price/priceTypes';

const TZ = 'Europe/Oslo';

const makeHour = (iso: string, total: number): CombinedHourlyPrice => ({
  startsAt: iso,
  totalPrice: total,
});

const buildHours = (startMs: number, count: number, baseTotal = 100): CombinedHourlyPrice[] => (
  Array.from({ length: count }, (_, i) => makeHour(new Date(startMs + i * 3600_000).toISOString(), baseTotal + i))
);

describe('buildCombinedPricePayload (V2)', () => {
  test('groups hours by local date key and emits version 2', () => {
    // Local Oslo midnight 2026-03-19 = 2026-03-18T23:00Z
    const start = Date.UTC(2026, 2, 18, 23, 0, 0);
    const payload = buildCombinedPricePayload({
      combined: buildHours(start, 48),
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      now: new Date(start + 5 * 3600_000),
      timeZone: TZ,
    });
    expect(payload.version).toBe(2);
    expect(Object.keys(payload.days).sort()).toEqual(['2026-03-19', '2026-03-20']);
    expect(payload.days['2026-03-19'].hours).toHaveLength(24);
    expect(payload.days['2026-03-20'].hours).toHaveLength(24);
    expect(payload.lastFetched).toBeDefined();
  });

  test('drops hours outside yesterday/today/tomorrow window', () => {
    const start = Date.UTC(2026, 2, 14, 23, 0, 0); // 2026-03-15 local
    const hours = buildHours(start, 24 * 7);
    const now = new Date(Date.UTC(2026, 2, 18, 12, 0, 0)); // local 2026-03-18
    const payload = buildCombinedPricePayload({
      combined: hours,
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      now,
      timeZone: TZ,
    });
    expect(Object.keys(payload.days).sort()).toEqual(['2026-03-17', '2026-03-18', '2026-03-19']);
  });

  test('returns empty days for empty input', () => {
    const payload = buildCombinedPricePayload({
      combined: [],
      priceScheme: 'flow',
      priceUnit: 'EUR/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      now: new Date('2026-05-10T00:00:00.000Z'),
      timeZone: TZ,
    });
    expect(payload.version).toBe(2);
    expect(payload.days).toEqual({});
  });

  test('handles DST spring-forward (23-hour day)', () => {
    // Europe/Oslo spring forward: 2026-03-29 02:00 local → 03:00 local
    // Local 2026-03-29 covers 2026-03-28T23:00Z through 2026-03-29T22:00Z = 23 hours
    const start = Date.UTC(2026, 2, 28, 23, 0, 0);
    const payload = buildCombinedPricePayload({
      combined: buildHours(start, 23),
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      now: new Date(start + 12 * 3600_000),
      timeZone: TZ,
    });
    expect(payload.days['2026-03-29']?.hours).toHaveLength(23);
  });

  test('handles DST fall-back (25-hour day)', () => {
    // Europe/Oslo fall back: 2026-10-25 03:00 local → 02:00 local
    // Local 2026-10-25 covers 2026-10-24T22:00Z through 2026-10-25T22:00Z = 25 hours
    const start = Date.UTC(2026, 9, 24, 22, 0, 0);
    const payload = buildCombinedPricePayload({
      combined: buildHours(start, 25),
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      now: new Date(start + 12 * 3600_000),
      timeZone: TZ,
    });
    expect(payload.days['2026-10-25']?.hours).toHaveLength(25);
  });
});

describe('pruneCombinedPricesV2', () => {
  test('drops dates outside the rolling 3-day window', () => {
    const store: CombinedPricesV2 = {
      version: 2,
      days: {
        '2026-05-05': { hours: [] },
        '2026-05-09': { hours: [] },
        '2026-05-10': { hours: [] },
        '2026-05-11': { hours: [] },
        '2026-05-15': { hours: [] },
      },
      avgPrice: 0,
      lowThreshold: 0,
      highThreshold: 0,
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
    };
    const pruned = pruneCombinedPricesV2(store, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(Object.keys(pruned.days).sort()).toEqual(['2026-05-09', '2026-05-10', '2026-05-11']);
  });
});
