// Unit coverage for `buildPriceHorizonFromCombined` — the deferred-objective
// allocation horizon's price source (decoupled from the daily-budget snapshot).
// Locks the behaviors the runtime-reality review flagged as untested, especially
// the RAW-instant (fractional-offset-safe) grid that keeps the horizon
// phase-aligned with the daily-budget overlay.
import { describe, expect, it } from 'vitest';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';
import type { CombinedPriceEntry, CombinedPricesV2 } from '../../lib/price/priceTypes';

const HOUR_MS = 60 * 60 * 1000;

const entry = (startsAt: string, total: number, budgetPrice?: number): CombinedPriceEntry => ({
  startsAt,
  total,
  ...(budgetPrice === undefined ? {} : { budgetPrice }),
  isCheap: false,
  isExpensive: false,
});

const store = (hours: CombinedPriceEntry[]): CombinedPricesV2 => ({
  version: 2,
  days: { day: { hours } },
  avgPrice: 0,
  lowThreshold: 0,
  highThreshold: 0,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

describe('buildPriceHorizonFromCombined', () => {
  it('returns an empty horizon for a null store (transient SDK read gap)', () => {
    expect(buildPriceHorizonFromCombined(null, 0, HOUR_MS)).toEqual([]);
  });

  it('carries the RAW hour-start instant for fractional-offset zones (not floored to the epoch hour)', () => {
    // UTC+05:30 local midnight = 18:30 UTC the day before — a :30-past-the-hour instant.
    const startsAt = '2026-01-01T00:00:00+05:30';
    const rawInstant = Date.parse(startsAt);
    const flooredHour = Math.floor(rawInstant / HOUR_MS) * HOUR_MS;
    expect(rawInstant).not.toBe(flooredHour); // sanity: it really is off-grid

    const horizon = buildPriceHorizonFromCombined(
      store([entry(startsAt, 42), entry('2026-01-01T01:00:00+05:30', 43)]),
      rawInstant,
      rawInstant + 2 * HOUR_MS,
    );

    expect(horizon).toEqual([
      { startMs: rawInstant, price: 42 },
      { startMs: rawInstant + HOUR_MS, price: 43 },
    ]);
  });

  it('filters to hours overlapping [nowMs, deadlineAtMs) and sorts ascending', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const hours = [0, 1, 2, 3].map((h) => entry(new Date(base + h * HOUR_MS).toISOString(), 10 + h));
    // now mid-hour-1, deadline mid-hour-2: hour 1 (overlaps now) + hour 2 only.
    const horizon = buildPriceHorizonFromCombined(
      store(hours),
      base + HOUR_MS + 30 * 60 * 1000,
      base + 2 * HOUR_MS + 30 * 60 * 1000,
    );
    expect(horizon).toEqual([
      { startMs: base + HOUR_MS, price: 11 },
      { startMs: base + 2 * HOUR_MS, price: 12 },
    ]);
  });

  it('dedupes by epoch hour, first-write-wins', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const horizon = buildPriceHorizonFromCombined(
      store([entry(new Date(base).toISOString(), 50), entry(new Date(base).toISOString(), 99)]),
      base,
      base + HOUR_MS,
    );
    expect(horizon).toEqual([{ startMs: base, price: 50 }]);
  });

  describe('planning price (budgetPrice ?? total)', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const iso = (h: number): string => new Date(base + h * HOUR_MS).toISOString();

    it('carries the budgetPrice when present — a <= 0 planning price is legal', () => {
      const horizon = buildPriceHorizonFromCombined(
        store([entry(iso(0), 100, -2.5), entry(iso(1), 100)]),
        base,
        base + 2 * HOUR_MS,
      );
      expect(horizon).toEqual([
        { startMs: base, price: -2.5 },
        { startMs: base + HOUR_MS, price: 100 },
      ]);
    });

    it('falls back to total when budgetPrice is present but non-finite (boundary junk)', () => {
      const horizon = buildPriceHorizonFromCombined(
        store([entry(iso(0), 42, Number.NaN)]),
        base,
        base + HOUR_MS,
      );
      expect(horizon).toEqual([{ startMs: base, price: 42 }]);
    });

    it('keeps an hour whose total is junk but whose budgetPrice is finite (resolved-value gate)', () => {
      const horizon = buildPriceHorizonFromCombined(
        store([entry(iso(0), Number.NaN, 7)]),
        base,
        base + HOUR_MS,
      );
      expect(horizon).toEqual([{ startMs: base, price: 7 }]);
    });

    it('skips an hour with no finite price at all (as before)', () => {
      const horizon = buildPriceHorizonFromCombined(
        store([entry(iso(0), Number.NaN, Number.NaN), entry(iso(1), 10)]),
        base,
        base + 2 * HOUR_MS,
      );
      expect(horizon).toEqual([{ startMs: base + HOUR_MS, price: 10 }]);
    });

    it('invariance: budgetPrice === total is byte-identical to entries without budgetPrice', () => {
      const withEqual = buildPriceHorizonFromCombined(
        store([entry(iso(0), 42, 42), entry(iso(1), 43, 43)]),
        base,
        base + 2 * HOUR_MS,
      );
      const without = buildPriceHorizonFromCombined(
        store([entry(iso(0), 42), entry(iso(1), 43)]),
        base,
        base + 2 * HOUR_MS,
      );
      expect(withEqual).toEqual(without);
      expect(withEqual).toEqual([
        { startMs: base, price: 42 },
        { startMs: base + HOUR_MS, price: 43 },
      ]);
    });
  });
});
