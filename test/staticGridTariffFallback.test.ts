import {
  describe, it, expect, vi,
} from 'vitest';
import {
  GRID_TARIFF_SOURCE_FALLBACK,
  isGridTariffFallbackData,
  shouldUseGridTariffCache,
} from '../lib/price/gridTariffUtils';

// Synthetic fallback table so the day/month/hour expansion logic can be tested
// deterministically, independent of the generated snapshot.
vi.mock('../lib/price/nettleieFallbackData.generated', () => ({
  NETTLEIE_FALLBACK_BY_ORGNR: {
    '111': {
      name: 'Test Nett',
      tariffs: {
        Husholdning: {
          basePrice: 10,
          exceptions: [
            // Weekday daytime peak.
            { hours: [6, 7, 8], price: 20, dayTypes: ['virkedag'] },
            // Winter-only surcharge, all days.
            { hours: [22, 23], price: 5, months: [1, 2] },
            // Holiday-only — never matches (holidays out of scope).
            { hours: [12], price: 99, dayTypes: ['helligdager'] },
          ],
        },
      },
    },
    '222': {
      name: 'Only Fritid',
      tariffs: {
        'Hytter og fritidshus': { basePrice: 7, exceptions: [] },
      },
    },
  },
}));

import { buildStaticGridTariffFallback, resolveGridTariffFallback } from '../lib/price/staticGridTariffFallback';

const feesByHour = (entries: Array<{ time: number; energyFeeExVat: number }>): number[] => {
  const fees = new Array<number>(24).fill(Number.NaN);
  for (const entry of entries) fees[entry.time] = entry.energyFeeExVat;
  return fees;
};

describe('buildStaticGridTariffFallback', () => {
  it('expands weekday peak + winter surcharge for a January weekday', () => {
    // 2026-01-05 is a Monday.
    const entries = buildStaticGridTariffFallback({
      organizationNumber: '111',
      tariffGroup: 'Husholdning',
      date: new Date('2026-01-05T10:00:00Z'),
      timeZone: 'UTC',
    });
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(24);
    expect(entries!.map((e) => e.time)).toEqual(Array.from({ length: 24 }, (_, h) => h));

    const fees = feesByHour(entries!);
    expect(fees[6]).toBe(20); // weekday peak
    expect(fees[8]).toBe(20);
    expect(fees[9]).toBe(10); // base
    expect(fees[12]).toBe(10); // holiday-only exception ignored
    expect(fees[22]).toBe(5); // winter surcharge
    expect(fees[23]).toBe(5);

    const first = entries![0];
    expect(first.source).toBe(GRID_TARIFF_SOURCE_FALLBACK);
    expect(first.dateKey).toBe('2026-01-05T00:00:00');
    expect(first.energyFeeIncVat).toBeCloseTo(first.energyFeeExVat * 1.25, 5);
    expect(first.fixedFeeExVat).toBe(0);
  });

  it('skips the weekday-only peak on a weekend but keeps all-day surcharges', () => {
    // 2026-01-04 is a Sunday.
    const fees = feesByHour(buildStaticGridTariffFallback({
      organizationNumber: '111',
      tariffGroup: 'Husholdning',
      date: new Date('2026-01-04T10:00:00Z'),
      timeZone: 'UTC',
    })!);
    expect(fees[6]).toBe(10); // virkedag exception does not apply on Sunday
    expect(fees[22]).toBe(5); // months-only exception still applies
  });

  it('drops the winter surcharge outside its months', () => {
    // 2026-06-01 is a Monday in June (outside the Jan/Feb surcharge window).
    const fees = feesByHour(buildStaticGridTariffFallback({
      organizationNumber: '111',
      tariffGroup: 'Husholdning',
      date: new Date('2026-06-01T10:00:00Z'),
      timeZone: 'UTC',
    })!);
    expect(fees[6]).toBe(20); // weekday peak still applies
    expect(fees[22]).toBe(10); // surcharge gone in June
  });

  it('returns null for an unknown organization number', () => {
    expect(buildStaticGridTariffFallback({
      organizationNumber: '999',
      tariffGroup: 'Husholdning',
      date: new Date('2026-01-05T10:00:00Z'),
      timeZone: 'UTC',
    })).toBeNull();
  });

  it('falls back to an available tariff group when the requested one is missing', () => {
    // '222' only files a holiday-home tariff; a household request still resolves.
    const fees = feesByHour(buildStaticGridTariffFallback({
      organizationNumber: '222',
      tariffGroup: 'Husholdning',
      date: new Date('2026-01-05T10:00:00Z'),
      timeZone: 'UTC',
    })!);
    expect(fees.every((f) => f === 7)).toBe(true);
  });
});

describe('resolveGridTariffFallback', () => {
  const date = new Date('2026-01-05T10:00:00Z');
  const base = { tariffGroup: 'Husholdning', date, timeZone: 'UTC' };

  it('keeps a real cache even when the operator has no static fallback', () => {
    const outcome = resolveGridTariffFallback({
      ...base, existingData: [{ energyFeeExVat: 11 }], organizationNumber: '999',
    });
    expect(outcome.kind).toBe('keepCache');
  });

  it('seeds the static fallback for a known operator with no cache', () => {
    const outcome = resolveGridTariffFallback({
      ...base, existingData: null, organizationNumber: '111',
    });
    expect(outcome.kind).toBe('store');
  });

  it('keeps existing fallback without rewriting when it already matches today', () => {
    const entries = buildStaticGridTariffFallback({ ...base, organizationNumber: '111' });
    const outcome = resolveGridTariffFallback({ ...base, existingData: entries, organizationNumber: '111' });
    expect(outcome.kind).toBe('fallbackCurrent');
  });

  it('clears stale fallback data when the operator can no longer be served', () => {
    // Fallback cached for one operator, org number switched to an untabled one.
    const outcome = resolveGridTariffFallback({
      ...base, existingData: [{ source: GRID_TARIFF_SOURCE_FALLBACK }], organizationNumber: '999',
    });
    expect(outcome.kind).toBe('clearStaleFallback');
  });

  it('reports noData for an unknown operator with nothing cached', () => {
    const outcome = resolveGridTariffFallback({
      ...base, existingData: null, organizationNumber: '999',
    });
    expect(outcome.kind).toBe('noData');
  });
});

describe('isGridTariffFallbackData', () => {
  it('detects fallback-sourced data', () => {
    expect(isGridTariffFallbackData([{ source: GRID_TARIFF_SOURCE_FALLBACK }])).toBe(true);
  });

  it('rejects real, empty, and null data', () => {
    expect(isGridTariffFallbackData([{ source: 'nve' }])).toBe(false);
    expect(isGridTariffFallbackData([{}])).toBe(false);
    expect(isGridTariffFallbackData([])).toBe(false);
    expect(isGridTariffFallbackData(null)).toBe(false);
  });
});

describe('shouldUseGridTariffCache with fallback data', () => {
  const noop = (): void => {};

  it('never short-circuits NVE retries when the cache is fallback-sourced', () => {
    const fallback = [{ dateKey: '2026-01-05T00:00:00', source: GRID_TARIFF_SOURCE_FALLBACK }];
    expect(shouldUseGridTariffCache(fallback, '2026-01-05', noop)).toBe(false);
  });

  it('still uses a real cache for today and rejects stale real data', () => {
    const real = [{ dateKey: '2026-01-05T00:00:00' }];
    expect(shouldUseGridTariffCache(real, '2026-01-05', noop)).toBe(true);
    expect(shouldUseGridTariffCache(real, '2026-01-06', noop)).toBe(false);
  });
});
