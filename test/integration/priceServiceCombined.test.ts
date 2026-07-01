import { describe, expect, test } from 'vitest';
import {
  buildCombinedPricePayload,
  combinedPayloadHasActionablePriceEntries,
  pruneCombinedPricesV2,
  shouldCatchUpCombinedPricesRotation,
} from '../../lib/price/priceServiceCombined';
import type { CombinedHourlyPrice, CombinedPricesV2 } from '../../lib/price/priceTypes';

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

  test('carries exportPrice (incl negative) onto the persisted entry, omits when absent', () => {
    const start = Date.UTC(2026, 2, 18, 23, 0, 0); // local Oslo 2026-03-19 00:00
    const withExport: CombinedHourlyPrice = {
      startsAt: new Date(start).toISOString(),
      totalPrice: 100,
      exportPrice: -5,
    };
    const withoutExport: CombinedHourlyPrice = {
      startsAt: new Date(start + 3600_000).toISOString(),
      totalPrice: 120,
    };
    const payload = buildCombinedPricePayload({
      combined: [withExport, withoutExport],
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      now: new Date(start + 5 * 3600_000),
      timeZone: TZ,
    });
    const hours = payload.days['2026-03-19'].hours;
    expect(hours[0].exportPrice).toBe(-5);
    expect(hours[1].exportPrice).toBeUndefined();
  });

  test('carries budgetPrice + exportPrice (incl negative budgetPrice) into the persisted V2 entry', () => {
    const start = Date.UTC(2026, 2, 18, 23, 0, 0); // local Oslo 2026-03-19 00:00
    const payload = buildCombinedPricePayload({
      combined: [
        { startsAt: new Date(start).toISOString(), totalPrice: 100, exportPrice: 4, budgetPrice: -2.5 },
        { startsAt: new Date(start + 3600_000).toISOString(), totalPrice: 120 },
        { startsAt: new Date(start + 2 * 3600_000).toISOString(), totalPrice: 110, budgetPrice: Number.NaN },
      ],
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      now: new Date(start + 5 * 3600_000),
      timeZone: TZ,
    });
    const hours = payload.days['2026-03-19'].hours;
    // Negative planning prices are legal and persisted unclamped; `total` stays
    // the import money price.
    expect(hours[0].budgetPrice).toBe(-2.5);
    expect(hours[0].exportPrice).toBe(4);
    expect(hours[0].total).toBe(100);
    expect(hours[1].budgetPrice).toBeUndefined();
    // Non-finite budgetPrice is dropped at the persistence boundary.
    expect(hours[2].budgetPrice).toBeUndefined();
  });

  test('computes avg/thresholds/tier flags over the planning price (budgetPrice ?? totalPrice)', () => {
    const start = Date.UTC(2026, 2, 18, 23, 0, 0); // local Oslo 2026-03-19 00:00
    const payload = buildCombinedPricePayload({
      combined: [
        // Highest total but a surplus-blended planning price of 10.
        { startsAt: new Date(start).toISOString(), totalPrice: 200, budgetPrice: 10 },
        { startsAt: new Date(start + 3600_000).toISOString(), totalPrice: 100 },
      ],
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      now: new Date(start + 5 * 3600_000),
      timeZone: TZ,
    });
    // Planning avg = (10 + 100) / 2 = 55; low = 41.25, high = 68.75.
    expect(payload.avgPrice).toBeCloseTo(55, 9);
    expect(payload.lowThreshold).toBeCloseTo(41.25, 9);
    expect(payload.highThreshold).toBeCloseTo(68.75, 9);
    const hours = payload.days['2026-03-19'].hours;
    // Total-based flags would call the 200-total hour expensive-vs-avg-150 —
    // the planning-price flags instead classify the blend it schedules at.
    expect(hours[0].isCheap).toBe(true);
    expect(hours[0].isExpensive).toBe(false);
    expect(hours[1].isCheap).toBe(false);
    expect(hours[1].isExpensive).toBe(true);
  });

  test('invariance: no budgetPrice (or budgetPrice === totalPrice) yields the historical flags', () => {
    const start = Date.UTC(2026, 2, 18, 23, 0, 0); // local Oslo 2026-03-19 00:00
    const build = (withEqualBudget: boolean) => buildCombinedPricePayload({
      combined: [
        { startsAt: new Date(start).toISOString(), totalPrice: 50, ...(withEqualBudget ? { budgetPrice: 50 } : {}) },
        { startsAt: new Date(start + 3600_000).toISOString(), totalPrice: 100, ...(withEqualBudget ? { budgetPrice: 100 } : {}) },
        { startsAt: new Date(start + 2 * 3600_000).toISOString(), totalPrice: 150, ...(withEqualBudget ? { budgetPrice: 150 } : {}) },
      ],
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      now: new Date(start + 5 * 3600_000),
      timeZone: TZ,
    });
    for (const payload of [build(false), build(true)]) {
      // Historical total-based classification: avg 100, low 75, high 125.
      expect(payload.avgPrice).toBe(100);
      expect(payload.lowThreshold).toBe(75);
      expect(payload.highThreshold).toBe(125);
      const hours = payload.days['2026-03-19'].hours;
      expect(hours.map((h) => h.isCheap)).toEqual([true, false, false]);
      expect(hours.map((h) => h.isExpensive)).toEqual([false, false, true]);
    }
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

describe('shouldCatchUpCombinedPricesRotation', () => {
  test('true when lastFetched is an earlier local day than now', () => {
    const now = new Date('2026-05-11T06:00:00.000Z'); // 2026-05-11 local
    const payload = { lastFetched: '2026-05-10T20:00:00.000Z' }; // 2026-05-10 local
    expect(shouldCatchUpCombinedPricesRotation(payload, now, TZ)).toBe(true);
  });

  test('false when lastFetched is the same local day as now', () => {
    const now = new Date('2026-05-11T06:00:00.000Z');
    // 2026-05-11T03:00Z is 05:00 local — still 2026-05-11.
    const payload = { lastFetched: '2026-05-11T03:00:00.000Z' };
    expect(shouldCatchUpCombinedPricesRotation(payload, now, TZ)).toBe(false);
  });

  test('false at a same-local-day boundary that crosses the UTC day (DST-safe key compare)', () => {
    // Just after local midnight on 2026-03-29 (CEST spring-forward day, a 23h day).
    // 2026-03-28T23:30Z is 2026-03-29 00:30 local; both stamps are the same local day.
    const now = new Date('2026-03-29T01:00:00.000Z'); // 03:00 local (post spring-forward)
    const payload = { lastFetched: '2026-03-28T23:30:00.000Z' }; // 00:30 local same day
    expect(shouldCatchUpCombinedPricesRotation(payload, now, TZ)).toBe(false);
  });

  test('false when lastFetched is a future local day (clock/NTP skew — do not rotate)', () => {
    const now = new Date('2026-05-11T06:00:00.000Z'); // 2026-05-11 local
    const payload = { lastFetched: '2026-05-12T20:00:00.000Z' }; // 2026-05-12 local (future)
    expect(shouldCatchUpCombinedPricesRotation(payload, now, TZ)).toBe(false);
  });

  test('false for missing payload, missing/non-string lastFetched, and unparseable timestamp', () => {
    const now = new Date('2026-05-11T06:00:00.000Z');
    expect(shouldCatchUpCombinedPricesRotation(undefined, now, TZ)).toBe(false);
    expect(shouldCatchUpCombinedPricesRotation(null, now, TZ)).toBe(false);
    expect(shouldCatchUpCombinedPricesRotation({}, now, TZ)).toBe(false);
    expect(shouldCatchUpCombinedPricesRotation({ lastFetched: 123 }, now, TZ)).toBe(false);
    expect(shouldCatchUpCombinedPricesRotation({ lastFetched: 'not-a-date' }, now, TZ)).toBe(false);
    expect(shouldCatchUpCombinedPricesRotation([], now, TZ)).toBe(false);
  });
});

describe('combinedPayloadHasActionablePriceEntries', () => {
  const NOW = new Date('2026-05-11T06:00:00.000Z'); // 2026-05-11 local
  const v2WithDays = (days: Record<string, { hours: Array<{ startsAt: string }> }>): CombinedPricesV2 => ({
    version: 2,
    days: days as CombinedPricesV2['days'],
    avgPrice: 0.5,
    lowThreshold: 0.3,
    highThreshold: 0.7,
    priceScheme: 'flow',
    priceUnit: 'øre/kWh',
  });
  const hour = (iso: string) => ({ startsAt: iso, total: 0.5, isCheap: false, isExpensive: true });

  test('V2: true when today has entries', () => {
    const payload = v2WithDays({ '2026-05-11': { hours: [hour('2026-05-11T00:00:00.000Z')] } });
    expect(combinedPayloadHasActionablePriceEntries(payload, NOW, TZ)).toBe(true);
  });

  test('V2: true when tomorrow has entries', () => {
    const payload = v2WithDays({ '2026-05-12': { hours: [hour('2026-05-12T00:00:00.000Z')] } });
    expect(combinedPayloadHasActionablePriceEntries(payload, NOW, TZ)).toBe(true);
  });

  test('V2: false when only yesterday (out-of-window) has entries', () => {
    const payload = v2WithDays({ '2026-05-10': { hours: [hour('2026-05-10T22:00:00.000Z')] } });
    expect(combinedPayloadHasActionablePriceEntries(payload, NOW, TZ)).toBe(false);
  });

  test('V2: false when days are empty', () => {
    expect(combinedPayloadHasActionablePriceEntries(v2WithDays({}), NOW, TZ)).toBe(false);
  });

  test('V1: true when a price entry falls on today/tomorrow', () => {
    const payload = {
      prices: [hour('2026-05-11T05:00:00.000Z')],
      avgPrice: 0.5,
      lowThreshold: 0.3,
      highThreshold: 0.7,
      priceScheme: 'flow' as const,
      priceUnit: 'øre/kWh',
    };
    expect(combinedPayloadHasActionablePriceEntries(payload, NOW, TZ)).toBe(true);
  });

  test('V1: false when all price entries are out-of-window', () => {
    const payload = {
      prices: [hour('2026-05-10T05:00:00.000Z')],
      avgPrice: 0.5,
      lowThreshold: 0.3,
      highThreshold: 0.7,
      priceScheme: 'flow' as const,
      priceUnit: 'øre/kWh',
    };
    expect(combinedPayloadHasActionablePriceEntries(payload, NOW, TZ)).toBe(false);
  });

  test('false for non-payload values (missing/empty/invalid read)', () => {
    expect(combinedPayloadHasActionablePriceEntries(undefined, NOW, TZ)).toBe(false);
    expect(combinedPayloadHasActionablePriceEntries(null, NOW, TZ)).toBe(false);
    expect(combinedPayloadHasActionablePriceEntries({}, NOW, TZ)).toBe(false);
    expect(combinedPayloadHasActionablePriceEntries([], NOW, TZ)).toBe(false);
  });
});
