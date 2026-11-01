import {
  describe, it, expect, vi,
} from 'vitest';
import {
  GRID_TARIFF_SOURCE_FALLBACK,
  isGridTariffFallbackData,
  shouldUseGridTariffCache,
} from '../../lib/price/gridTariffUtils';

// Synthetic fallback table so the day/month/hour expansion logic can be tested
// deterministically, independent of the generated snapshot.
vi.mock('../../lib/price/nettleieFallbackData.generated', () => ({
  NETTLEIE_FALLBACK_BY_ORGNR: {
    '111': {
      name: 'Test Nett',
      file: 'test.yml',
      tariffs: {
        Husholdning: [{
          from: '2025-01-01',
          until: '2026-07-01',
          basePrice: 10,
          exceptions: [
            // Weekday daytime peak.
            { hours: [6, 7, 8], price: 20, dayTypes: ['virkedag'] },
            // Winter-only surcharge, all days.
            { hours: [22, 23], price: 5, months: [1, 2] },
            // Holiday-only — never matches (holidays out of scope).
            { hours: [12], price: 99, dayTypes: ['helligdager'] },
          ],
        }, {
          // A tariff change announced for 2026-07-01.
          from: '2026-07-01',
          basePrice: 30,
          exceptions: [],
        }],
      },
    },
    '222': {
      name: 'Only Fritid',
      file: 'fritid.yml',
      tariffs: {
        'Hytter og fritidshus': [{ from: '2025-01-01', basePrice: 7, exceptions: [] }],
      },
    },
  },
}));

import { buildStaticGridTariffFallback, resolveGridTariffFallback } from '../../lib/price/staticGridTariffFallback';

// Fri Nettleie rates leave out the Enova fee, which the fallback adds to match NVE.
const ENOVA = 1;

// The fees for the first day the fallback covers: the day of the given date.
const feesByHour = (entries: Array<{ time: number; energyFeeExVat: number; dateKey: string }>): number[] => {
  const fees = new Array<number>(24).fill(Number.NaN);
  for (const entry of entries) {
    if (entry.dateKey === entries[0]?.dateKey) fees[entry.time] = entry.energyFeeExVat;
  }
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
    // Today and tomorrow, a full day each.
    expect(entries).toHaveLength(48);
    expect(entries!.map((e) => e.time)).toEqual([...Array.from({ length: 24 }, (_, h) => h), ...Array.from({ length: 24 }, (_, h) => h)]);
    expect(entries![24]?.dateKey).toBe('2026-01-06T00:00:00');

    const fees = feesByHour(entries!);
    expect(fees[6]).toBe(20 + ENOVA); // weekday peak
    expect(fees[8]).toBe(20 + ENOVA);
    expect(fees[9]).toBe(10 + ENOVA); // base
    expect(fees[12]).toBe(10 + ENOVA); // holiday-only exception ignored
    expect(fees[22]).toBe(5 + ENOVA); // winter surcharge
    expect(fees[23]).toBe(5 + ENOVA);

    const first = entries![0];
    expect(first.source).toBe(GRID_TARIFF_SOURCE_FALLBACK);
    expect(first.dateKey).toBe('2026-01-05T00:00:00');
    expect(first.energyFeeIncVat).toBeCloseTo(first.energyFeeExVat * 1.25, 5);
  });

  it('skips the weekday-only peak on a weekend but keeps all-day surcharges', () => {
    // 2026-01-04 is a Sunday.
    const fees = feesByHour(buildStaticGridTariffFallback({
      organizationNumber: '111',
      tariffGroup: 'Husholdning',
      date: new Date('2026-01-04T10:00:00Z'),
      timeZone: 'UTC',
    })!);
    expect(fees[6]).toBe(10 + ENOVA); // virkedag exception does not apply on Sunday
    expect(fees[22]).toBe(5 + ENOVA); // months-only exception still applies
  });

  it('prices tomorrow on its own day type', () => {
    // 2026-01-04 is a Sunday, so tomorrow is a Monday with the weekday peak.
    const entries = buildStaticGridTariffFallback({
      organizationNumber: '111',
      tariffGroup: 'Husholdning',
      date: new Date('2026-01-04T10:00:00Z'),
      timeZone: 'UTC',
    })!;
    const monday = entries.filter((entry) => entry.dateKey === '2026-01-05T00:00:00');
    expect(feesByHour(monday)[6]).toBe(20 + ENOVA);
    expect(feesByHour(entries)[6]).toBe(10 + ENOVA);
  });

  it('drops the winter surcharge outside its months', () => {
    // 2026-06-01 is a Monday in June (outside the Jan/Feb surcharge window).
    const fees = feesByHour(buildStaticGridTariffFallback({
      organizationNumber: '111',
      tariffGroup: 'Husholdning',
      date: new Date('2026-06-01T10:00:00Z'),
      timeZone: 'UTC',
    })!);
    expect(fees[6]).toBe(20 + ENOVA); // weekday peak still applies
    expect(fees[22]).toBe(10 + ENOVA); // surcharge gone in June
  });

  it('prices each day on the period valid that day', () => {
    // 2026-06-30 is a Tuesday; the new tariff applies from tomorrow, 2026-07-01.
    const entries = buildStaticGridTariffFallback({
      organizationNumber: '111',
      tariffGroup: 'Husholdning',
      date: new Date('2026-06-30T10:00:00Z'),
      timeZone: 'UTC',
    })!;
    expect(feesByHour(entries)[9]).toBe(10 + ENOVA);
    const july = entries.filter((entry) => entry.dateKey === '2026-07-01T00:00:00');
    expect(feesByHour(july).every((fee) => fee === 30 + ENOVA)).toBe(true);
  });

  it('returns null for a day before any period', () => {
    expect(buildStaticGridTariffFallback({
      organizationNumber: '111',
      tariffGroup: 'Husholdning',
      date: new Date('2024-12-31T10:00:00Z'),
      timeZone: 'UTC',
    })).toBeNull();
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
    expect(fees.every((f) => f === 7 + ENOVA)).toBe(true);
  });
});

describe('resolveGridTariffFallback', () => {
  const date = new Date('2026-01-05T10:00:00Z');
  const base = { tariffGroup: 'Husholdning', date, timeZone: 'UTC' };

  it('keeps an undated real cache when the operator has no static fallback', () => {
    const outcome = resolveGridTariffFallback({
      ...base, existingData: [{ energyFeeExVat: 11 } as { source?: unknown }], organizationNumber: '999',
    });
    expect(outcome.kind).toBe('keepCache');
  });

  it('keeps a real cache that covers today over the static fallback', () => {
    const outcome = resolveGridTariffFallback({
      ...base, existingData: [{ dateKey: '2026-01-05T00:00:00' }], organizationNumber: '111',
    });
    expect(outcome.kind).toBe('keepCache');
  });

  it('replaces a real cache from an earlier day with the static fallback for today', () => {
    // Cached Friday and Saturday; on Monday, Monday's own day type and period apply.
    const outcome = resolveGridTariffFallback({
      ...base,
      existingData: [{ dateKey: '2026-01-02T00:00:00' }, { dateKey: '2026-01-03T00:00:00' }],
      organizationNumber: '111',
    });
    expect(outcome).toEqual({
      kind: 'store',
      entries: buildStaticGridTariffFallback({ ...base, organizationNumber: '111' }),
    });
  });

  it('keeps a real cache from an earlier day when the operator has no static fallback', () => {
    const outcome = resolveGridTariffFallback({
      ...base, existingData: [{ dateKey: '2026-01-02T00:00:00' }], organizationNumber: '999',
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
  it('never short-circuits NVE retries when the cache is fallback-sourced', () => {
    const fallback = [{ dateKey: '2026-01-05T00:00:00', source: GRID_TARIFF_SOURCE_FALLBACK }];
    expect(shouldUseGridTariffCache(fallback, { today: '2026-01-05', tomorrow: '2026-01-06' })).toBe(false);
  });

  it('uses a real cache covering today and tomorrow and rejects stale real data', () => {
    const real = [{ dateKey: '2026-01-05T00:00:00' }, { dateKey: '2026-01-06T00:00:00' }];
    expect(shouldUseGridTariffCache(real, { today: '2026-01-05', tomorrow: '2026-01-06' })).toBe(true);
    expect(shouldUseGridTariffCache(real, { today: '2026-01-06', tomorrow: '2026-01-07' })).toBe(false);
  });

  it('refetches a real cache that holds only today', () => {
    const todayOnly = [{ dateKey: '2026-01-05T00:00:00' }];
    expect(shouldUseGridTariffCache(todayOnly, { today: '2026-01-05', tomorrow: '2026-01-06' })).toBe(false);
  });
});
