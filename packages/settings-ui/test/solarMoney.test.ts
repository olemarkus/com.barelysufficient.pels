import { describe, expect, it } from 'vitest';
import { resolveSolarMoneyToday } from '../../shared-domain/src/solar/solarMoney.ts';

const HOUR_MS = 60 * 60 * 1000;
const H0 = Date.UTC(2026, 5, 15, 10, 0, 0);
const H1 = H0 + HOUR_MS;
const H2 = H0 + 2 * HOUR_MS;

const iso = (ms: number) => new Date(ms).toISOString();

describe('resolveSolarMoneyToday', () => {
  it('computes avoided (self-used × total) and signed earned (exported × exportPrice) per hour', () => {
    const result = resolveSolarMoneyToday({
      priceRows: [
        { startsAt: iso(H0), total: 100, exportPrice: 40 },
        { startsAt: iso(H1), total: 200, exportPrice: 50 },
      ],
      generationKWhByHourMs: new Map([[H0, 2], [H1, 1]]),
      exportKWhByHourMs: new Map([[H0, 0.5], [H1, 0.25]]),
      todayHourStartsMs: [H0, H1],
    });
    // avoided: (2−0.5)×100 + (1−0.25)×200 = 150 + 150
    expect(result.avoidedMinor).toBeCloseTo(300, 6);
    // earned: 0.5×40 + 0.25×50 = 20 + 12.5
    expect(result.earnedMinor).toBeCloseTo(32.5, 6);
    expect(result.unpricedSolarHours).toBe(0);
  });

  it('shows negative earnings for a negative feed-in price', () => {
    const result = resolveSolarMoneyToday({
      priceRows: [{ startsAt: iso(H0), total: 100, exportPrice: -30 }],
      generationKWhByHourMs: new Map([[H0, 1]]),
      exportKWhByHourMs: new Map([[H0, 1]]),
      todayHourStartsMs: [H0],
    });
    expect(result.earnedMinor).toBeCloseTo(-30, 6);
    // Battery-hour floor: self-used never goes negative → avoided 0 here.
    expect(result.avoidedMinor).toBe(0);
  });

  it('per-hour floor: an export-exceeds-generation hour contributes zero self-use', () => {
    const result = resolveSolarMoneyToday({
      priceRows: [
        { startsAt: iso(H0), total: 100 },
        { startsAt: iso(H1), total: 100 },
      ],
      generationKWhByHourMs: new Map([[H0, 1], [H1, 2]]),
      exportKWhByHourMs: new Map([[H0, 3], [H1, 0]]),
      todayHourStartsMs: [H0, H1],
    });
    // Hour 0: max(0, 1−3) = 0; hour 1: 2 × 100.
    expect(result.avoidedMinor).toBeCloseTo(200, 6);
  });

  it('import-only prices yield avoided only (earned null)', () => {
    const result = resolveSolarMoneyToday({
      priceRows: [{ startsAt: iso(H0), total: 120 }],
      generationKWhByHourMs: new Map([[H0, 1]]),
      exportKWhByHourMs: new Map(),
      todayHourStartsMs: [H0],
    });
    expect(result.avoidedMinor).toBeCloseTo(120, 6);
    expect(result.earnedMinor).toBeNull();
  });

  it('no prices at all yields nulls', () => {
    const result = resolveSolarMoneyToday({
      priceRows: [],
      generationKWhByHourMs: new Map([[H0, 1]]),
      exportKWhByHourMs: new Map([[H0, 0.5]]),
      todayHourStartsMs: [H0],
    });
    expect(result).toEqual({
      avoidedMinor: null,
      earnedMinor: null,
      unpricedSolarHours: 1,
      unpricedExportHours: 1,
    });
  });

  it('counts unpriced solar hours under partial coverage and skips non-solar hours', () => {
    const result = resolveSolarMoneyToday({
      priceRows: [{ startsAt: iso(H0), total: 100 }],
      generationKWhByHourMs: new Map([[H0, 1], [H1, 1]]),
      exportKWhByHourMs: new Map(),
      todayHourStartsMs: [H0, H1, H2], // H2 has no solar → not counted as unpriced
    });
    expect(result.avoidedMinor).toBeCloseTo(100, 6);
    expect(result.unpricedSolarHours).toBe(1);
  });

  it('tracks export-price coverage on its own axis (fully import-priced, partially export-priced)', () => {
    const result = resolveSolarMoneyToday({
      priceRows: [
        { startsAt: iso(H0), total: 100, exportPrice: 40 },
        { startsAt: iso(H1), total: 100 }, // import priced, export NOT priced
      ],
      generationKWhByHourMs: new Map([[H0, 2], [H1, 2]]),
      exportKWhByHourMs: new Map([[H0, 1], [H1, 1]]),
      todayHourStartsMs: [H0, H1],
    });
    // Import axis fully covered — the avoided line has no unpriced hours…
    expect(result.unpricedSolarHours).toBe(0);
    expect(result.avoidedMinor).toBeCloseTo(200, 6);
    // …while the earned line silently missing H1's export must be flagged.
    expect(result.earnedMinor).toBeCloseTo(40, 6);
    expect(result.unpricedExportHours).toBe(1);
  });

  it('does not flag export coverage for hours without export', () => {
    const result = resolveSolarMoneyToday({
      priceRows: [
        { startsAt: iso(H0), total: 100, exportPrice: 40 },
        { startsAt: iso(H1), total: 100 }, // generation-only hour, no export
      ],
      generationKWhByHourMs: new Map([[H0, 2], [H1, 2]]),
      exportKWhByHourMs: new Map([[H0, 1]]),
      todayHourStartsMs: [H0, H1],
    });
    expect(result.unpricedExportHours).toBe(0);
  });

  it('joins on the epoch instant regardless of the startsAt offset spelling', () => {
    // 12:00 +02:00 === 10:00 UTC — the tracker key.
    const result = resolveSolarMoneyToday({
      priceRows: [{ startsAt: '2026-06-15T12:00:00.000+02:00', total: 100 }],
      generationKWhByHourMs: new Map([[H0, 1]]),
      exportKWhByHourMs: new Map(),
      todayHourStartsMs: [H0],
    });
    expect(result.avoidedMinor).toBeCloseTo(100, 6);
  });
});
