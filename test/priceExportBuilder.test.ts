import { describe, expect, it } from 'vitest';
import { buildPriceExport, priceExportFingerprint } from '../lib/price/priceExportBuilder';
import type { CombinedPriceEntry, CombinedPricesV2, PriceScheme } from '../lib/price/priceTypes';

const TZ = 'Europe/Oslo';

const buildEntry = (overrides: Partial<CombinedPriceEntry> & { startsAt: string; total: number }): CombinedPriceEntry => ({
  isCheap: false,
  isExpensive: false,
  ...overrides,
});

const buildStore = (overrides: Partial<CombinedPricesV2> = {}): CombinedPricesV2 => ({
  version: 2,
  days: {},
  avgPrice: 100,
  lowThreshold: 75,
  highThreshold: 125,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
  ...overrides,
});

const dayEntries = (dateKey: string, count: number): CombinedPriceEntry[] => (
  Array.from({ length: count }, (_, hour) => buildEntry({
    startsAt: `${dateKey}T${String(hour).padStart(2, '0')}:00:00+02:00`,
    total: 50 + hour,
  }))
);

describe('priceExportBuilder', () => {
  it('returns empty arrays and a fallback unit when the store is null', () => {
    const result = buildPriceExport({
      store: null,
      now: new Date('2026-05-17T10:00:00Z'),
      timeZone: TZ,
    });
    expect(result).toEqual({ today: [], tomorrow: [], unit: 'price units' });
  });

  it('emits adjusted hourly totals for today and tomorrow indexed by local hour', () => {
    const store = buildStore({
      days: {
        '2026-05-17': { hours: dayEntries('2026-05-17', 24) },
        '2026-05-18': { hours: dayEntries('2026-05-18', 24) },
      },
    });
    const result = buildPriceExport({
      store,
      now: new Date('2026-05-17T10:00:00+02:00'),
      timeZone: TZ,
    });
    expect(result.today).toHaveLength(24);
    expect(result.today[0]).toBe(50);
    expect(result.today[23]).toBe(73);
    expect(result.tomorrow).toHaveLength(24);
    expect(result.unit).toBe('øre/kWh');
  });

  it('reports tomorrow as an empty array when day-ahead prices are missing', () => {
    const store = buildStore({
      days: { '2026-05-17': { hours: dayEntries('2026-05-17', 24) } },
    });
    const result = buildPriceExport({
      store,
      now: new Date('2026-05-17T08:00:00+02:00'),
      timeZone: TZ,
    });
    expect(result.tomorrow).toEqual([]);
  });

  it('preserves the adjusted total (post grid / tax / VAT / Norgespris)', () => {
    const store = buildStore({
      days: {
        '2026-05-17': {
          hours: [buildEntry({
            startsAt: '2026-05-17T00:00:00+02:00',
            total: 74.2,
            spotPriceExVat: 31,
            gridTariffExVat: 18,
            vatAmount: 15.2,
            norgesprisAdjustment: -5,
          })],
        },
      },
    });
    const result = buildPriceExport({
      store,
      now: new Date('2026-05-17T01:00:00+02:00'),
      timeZone: TZ,
    });
    expect(result.today).toEqual([74.2, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]);
  });

  it('pads missing hours with null so later prices do not shift left', () => {
    const store = buildStore({
      days: {
        '2026-05-17': {
          hours: [
            buildEntry({ startsAt: '2026-05-17T00:00:00+02:00', total: 50 }),
            // 01:00 deliberately missing (sparse Flow input)
            buildEntry({ startsAt: '2026-05-17T02:00:00+02:00', total: 52 }),
            buildEntry({ startsAt: '2026-05-17T23:00:00+02:00', total: 73 }),
          ],
        },
      },
    });
    const result = buildPriceExport({
      store,
      now: new Date('2026-05-17T05:00:00+02:00'),
      timeZone: TZ,
    });
    expect(result.today).toHaveLength(24);
    expect(result.today[0]).toBe(50);
    expect(result.today[1]).toBeNull();
    expect(result.today[2]).toBe(52);
    expect(result.today[23]).toBe(73);
  });

  it('produces a 23-hour array on spring-forward DST and a 25-hour array on fall-back DST', () => {
    // Europe/Oslo spring forward: 2026-03-29 has 23 local hours
    const springStore = buildStore({
      days: {
        '2026-03-29': {
          hours: [
            buildEntry({ startsAt: '2026-03-29T00:00:00+01:00', total: 10 }),
            buildEntry({ startsAt: '2026-03-29T01:00:00+01:00', total: 11 }),
            buildEntry({ startsAt: '2026-03-29T03:00:00+02:00', total: 13 }),
            buildEntry({ startsAt: '2026-03-29T23:00:00+02:00', total: 33 }),
          ],
        },
      },
    });
    const spring = buildPriceExport({
      store: springStore,
      now: new Date('2026-03-29T10:00:00+02:00'),
      timeZone: TZ,
    });
    expect(spring.today).toHaveLength(23);
    expect(spring.today[0]).toBe(10);
    expect(spring.today[1]).toBe(11);
    // hour index 2 in local time is 03:00 (02:00 skipped by DST jump)
    expect(spring.today[2]).toBe(13);
    expect(spring.today[22]).toBe(33);

    // Europe/Oslo fall back: 2026-10-25 has 25 local hours
    const fallStore = buildStore({
      days: {
        '2026-10-25': {
          hours: [
            buildEntry({ startsAt: '2026-10-25T00:00:00+02:00', total: 20 }),
            buildEntry({ startsAt: '2026-10-25T23:00:00+01:00', total: 44 }),
          ],
        },
      },
    });
    const fall = buildPriceExport({
      store: fallStore,
      now: new Date('2026-10-25T12:00:00+01:00'),
      timeZone: TZ,
    });
    expect(fall.today).toHaveLength(25);
    expect(fall.today[0]).toBe(20);
    expect(fall.today[24]).toBe(44);
  });

  it('produces a stable fingerprint for identical content', () => {
    const store = buildStore({
      days: { '2026-05-17': { hours: dayEntries('2026-05-17', 24) } },
    });
    const a = buildPriceExport({
      store,
      now: new Date('2026-05-17T10:00:00+02:00'),
      timeZone: TZ,
    });
    const b = buildPriceExport({
      store,
      now: new Date('2026-05-17T11:00:00+02:00'),
      timeZone: TZ,
    });
    expect(priceExportFingerprint(a)).toBe(priceExportFingerprint(b));
  });

  describe.each<{ scheme: PriceScheme; unit: string }>([
    { scheme: 'norway', unit: 'øre/kWh' },
    { scheme: 'homey', unit: 'EUR/kWh' },
    { scheme: 'flow', unit: 'price units' },
  ])('price scheme: $scheme', ({ scheme, unit }) => {
    it('propagates the scheme-specific unit and adjusted totals through to the export', () => {
      const store = buildStore({
        priceScheme: scheme,
        priceUnit: unit,
        days: {
          '2026-05-17': { hours: dayEntries('2026-05-17', 24) },
          '2026-05-18': { hours: dayEntries('2026-05-18', 24) },
        },
      });
      const result = buildPriceExport({
        store,
        now: new Date('2026-05-17T10:00:00+02:00'),
        timeZone: TZ,
      });
      expect(result.unit).toBe(unit);
      expect(result.today).toHaveLength(24);
      expect(result.tomorrow).toHaveLength(24);
      expect(result.today[0]).toBe(50);
    });

    it('returns an empty tomorrow array when day-ahead is not published', () => {
      const store = buildStore({
        priceScheme: scheme,
        priceUnit: unit,
        days: { '2026-05-17': { hours: dayEntries('2026-05-17', 24) } },
      });
      const result = buildPriceExport({
        store,
        now: new Date('2026-05-17T08:00:00+02:00'),
        timeZone: TZ,
      });
      expect(result.tomorrow).toEqual([]);
      expect(result.unit).toBe(unit);
    });
  });

  it('produces a different fingerprint when totals change', () => {
    const a = buildPriceExport({
      store: buildStore({ days: { '2026-05-17': { hours: dayEntries('2026-05-17', 24) } } }),
      now: new Date('2026-05-17T10:00:00+02:00'),
      timeZone: TZ,
    });
    const bumped = dayEntries('2026-05-17', 24).map((entry) => ({ ...entry, total: entry.total + 1 }));
    const b = buildPriceExport({
      store: buildStore({ days: { '2026-05-17': { hours: bumped } } }),
      now: new Date('2026-05-17T10:00:00+02:00'),
      timeZone: TZ,
    });
    expect(priceExportFingerprint(a)).not.toBe(priceExportFingerprint(b));
  });
});
