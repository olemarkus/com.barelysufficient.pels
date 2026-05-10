import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  __resetRefetchGuardForTest,
  combinedPriceDataFromStore,
  flattenAllHours,
  readPriceStore,
} from '../../../lib/price/priceStore';
import type { CombinedPricesV2 } from '../../../lib/price/priceTypes';

const TZ = 'Europe/Oslo';

const buildStore = (): CombinedPricesV2 => ({
  version: 2,
  days: {
    '2026-05-09': { hours: [{ startsAt: '2026-05-08T22:00:00.000Z', total: 1, isCheap: false, isExpensive: false }] },
    '2026-05-10': { hours: [{ startsAt: '2026-05-09T22:00:00.000Z', total: 2, isCheap: false, isExpensive: false }] },
    '2026-05-11': { hours: [{ startsAt: '2026-05-10T22:00:00.000Z', total: 3, isCheap: false, isExpensive: false }] },
  },
  avgPrice: 2,
  lowThreshold: 1,
  highThreshold: 3,
  priceScheme: 'norway',
  priceUnit: 'NOK/kWh',
  lastFetched: '2026-05-10T00:00:00.000Z',
});

const buildHomey = (initial: unknown) => {
  let value = initial;
  return {
    settings: {
      get: vi.fn(() => value),
      set: vi.fn((_key: string, next: unknown) => { value = next; }),
    },
  };
};

afterEach(() => {
  __resetRefetchGuardForTest();
});

describe('readPriceStore', () => {
  test('returns the V2 store, pruned in place', () => {
    const homey = buildHomey({ ...buildStore(), days: { ...buildStore().days, '2026-05-01': { hours: [] } } });
    const requestRefetch = vi.fn();
    const result = readPriceStore({ homey: homey as never, requestRefetch }, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.days).sort()).toEqual(['2026-05-09', '2026-05-10', '2026-05-11']);
    expect(requestRefetch).not.toHaveBeenCalled();
  });

  // Regression for #646 review: a malformed-but-versioned payload like
  // `{ version: 2, days: { '...': null } }` previously passed `isCombinedPricesV2`
  // and then crashed `flattenAllHours` when it dereferenced `day.hours`.
  test('treats malformed V2 day entries as non-V2 and triggers recovery', () => {
    const homey = buildHomey({
      version: 2,
      days: { '2026-05-10': null },
      avgPrice: 1, lowThreshold: 0, highThreshold: 2,
      priceScheme: 'norway', priceUnit: 'NOK/kWh',
    });
    const requestRefetch = vi.fn();
    const result = readPriceStore({ homey: homey as never, requestRefetch }, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(result).toBeNull();
    expect(homey.settings.set).toHaveBeenCalledWith('combined_prices', null);
    expect(requestRefetch).toHaveBeenCalledTimes(1);
  });

  test('treats V2 payload missing top-level metadata as non-V2', () => {
    const homey = buildHomey({ version: 2, days: {} });
    const requestRefetch = vi.fn();
    const result = readPriceStore({ homey: homey as never, requestRefetch }, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(result).toBeNull();
    expect(requestRefetch).toHaveBeenCalledTimes(1);
  });

  test('clears legacy V1 payload and triggers refetch', () => {
    const legacy = {
      prices: [{ startsAt: '2026-05-10T00:00:00.000Z', total: 1, isCheap: false, isExpensive: false }],
      avgPrice: 1,
      lowThreshold: 0,
      highThreshold: 2,
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
    };
    const homey = buildHomey(legacy);
    const requestRefetch = vi.fn();
    const result = readPriceStore({ homey: homey as never, requestRefetch }, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(result).toBeNull();
    expect(homey.settings.set).toHaveBeenCalledWith('combined_prices', null);
    expect(requestRefetch).toHaveBeenCalledTimes(1);
  });

  test('returns null and does not refetch when settings is null', () => {
    const homey = buildHomey(null);
    const requestRefetch = vi.fn();
    const result = readPriceStore({ homey: homey as never, requestRefetch }, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(result).toBeNull();
    expect(homey.settings.set).not.toHaveBeenCalled();
    expect(requestRefetch).not.toHaveBeenCalled();
  });

  test('refetch guard prevents re-entrant refetch when legacy payload triggers it', () => {
    const homey = buildHomey({ prices: [] });
    const requestRefetch = vi.fn(() => {
      // simulate refetch triggering another read recursively
      readPriceStore({ homey: homey as never, requestRefetch }, new Date('2026-05-10T12:00:00.000Z'), TZ);
    });
    readPriceStore({ homey: homey as never, requestRefetch }, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(requestRefetch).toHaveBeenCalledTimes(1);
  });
});

describe('flatten helpers', () => {
  test('flattenAllHours concatenates and sorts', () => {
    const flat = flattenAllHours(buildStore());
    expect(flat.map((h) => h.total)).toEqual([1, 2, 3]);
  });

  test('combinedPriceDataFromStore preserves lastFetched and priceUnit', () => {
    const data = combinedPriceDataFromStore(buildStore());
    expect(data?.lastFetched).toBe('2026-05-10T00:00:00.000Z');
    expect(data?.priceUnit).toBe('NOK/kWh');
    expect(data?.prices).toHaveLength(3);
  });
});
