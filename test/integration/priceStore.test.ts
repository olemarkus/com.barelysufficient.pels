import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  __resetRefetchGuardForTest,
  combinedPriceDataFromStore,
  flattenAllHours,
  readPriceStore,
} from '../../lib/price/priceStore';
import type { CombinedPricesV2 } from '../../lib/price/priceTypes';
import { buildPelsStatus } from '../../lib/plan/pelsStatus';
import { PriceLevel } from '../../lib/price/priceLevels';
import type { DevicePlan } from '../../lib/plan/planTypes';

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

  test('migrates legacy V1 payload to V2 in place and returns the V2 store', () => {
    const legacy = {
      prices: [
        { startsAt: '2026-05-08T22:00:00.000Z', total: 1, isCheap: true, isExpensive: false },
        { startsAt: '2026-05-09T22:00:00.000Z', total: 2, isCheap: false, isExpensive: false },
        { startsAt: '2026-05-10T22:00:00.000Z', total: 3, isCheap: false, isExpensive: true },
      ],
      avgPrice: 2,
      lowThreshold: 1,
      highThreshold: 3,
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
      thresholdPercent: 25,
      minDiffOre: 0,
      lastFetched: '2026-05-10T00:00:00.000Z',
    };
    const homey = buildHomey(legacy);
    const requestRefetch = vi.fn();
    const result = readPriceStore({ homey: homey as never, requestRefetch }, new Date('2026-05-10T12:00:00.000Z'), TZ);

    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(Object.keys(result!.days).sort()).toEqual(['2026-05-09', '2026-05-10', '2026-05-11']);
    expect(result!.priceScheme).toBe('norway');
    expect(result!.priceUnit).toBe('NOK/kWh');
    expect(result!.lastFetched).toBe('2026-05-10T00:00:00.000Z');
    // The migration must persist V2 to settings so subsequent direct reads
    // (planStatusWriter.getCombinedPrices, settingsUiApi, widget) see V2 too.
    expect(homey.settings.set).toHaveBeenCalledTimes(1);
    const written = homey.settings.set.mock.calls[0][1] as { version: number };
    expect(written.version).toBe(2);
    // No refetch needed: V1 has all the entries already, the migration is
    // self-contained.
    expect(requestRefetch).not.toHaveBeenCalled();
  });

  test('migration of empty V1 payload produces a V2 store and requests refetch', () => {
    // V1 with empty prices (or all entries outside the 3-day window) migrates
    // to an empty V2 store. Without a refetch, price_level would stay UNKNOWN
    // until an external refresh, since the periodic refresher can skip the
    // combined-prices rebuild for non-Norway schemes.
    const legacy = {
      prices: [],
      avgPrice: 0,
      lowThreshold: 0,
      highThreshold: 0,
      priceScheme: 'flow',
      priceUnit: 'price units',
    };
    const homey = buildHomey(legacy);
    const requestRefetch = vi.fn();
    const result = readPriceStore({ homey: homey as never, requestRefetch }, new Date('2026-05-10T12:00:00.000Z'), TZ);

    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.days).toEqual({});
    expect(result!.priceScheme).toBe('flow');
    expect(homey.settings.set).toHaveBeenCalledTimes(1);
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

  test('refetch guard prevents re-entrant refetch when malformed payload triggers it', () => {
    // A truly malformed payload (not V2 and not V1-shaped) must still drop and
    // request a refetch. The guard prevents recursion if the refetcher reads
    // synchronously.
    const homey = buildHomey({ unrelated: 'shape' });
    const requestRefetch = vi.fn(() => {
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

describe('readPriceStore + buildPelsStatus integration', () => {
  // Bug Unit 3 regression: if readPriceStore returns null on legacy V1, the
  // status writer's `hasPrices` check (which only knows V2 `.days`) returns
  // false and price level falls back to UNKNOWN -- causing a spurious
  // `price_level_changed` flow trigger in the post-upgrade window.
  test('legacy V1 payload resolves price level immediately on first read', () => {
    const homey = buildHomey({
      prices: [
        { startsAt: '2026-05-10T10:00:00.000Z', total: 1.2, isCheap: true, isExpensive: false },
      ],
      avgPrice: 1.2,
      lowThreshold: 1,
      highThreshold: 2,
      priceScheme: 'norway',
      priceUnit: 'NOK/kWh',
    });
    const requestRefetch = vi.fn();
    const migrated = readPriceStore(
      { homey: homey as never, requestRefetch },
      new Date('2026-05-10T12:00:00.000Z'),
      TZ,
    );

    const plan: DevicePlan = {
      meta: {
        totalKw: 0,
        softLimitKw: 5,
        softLimitSource: 'capacity',
        headroomKw: 5,
        powerKnown: true,
      },
      devices: [],
    };
    const { status } = buildPelsStatus({
      plan,
      isCheap: true,
      isExpensive: false,
      combinedPrices: migrated,
      lastPowerUpdate: Date.UTC(2026, 4, 10, 12, 0, 0),
    });
    expect(status.priceLevel).toBe(PriceLevel.CHEAP);
  });
});
