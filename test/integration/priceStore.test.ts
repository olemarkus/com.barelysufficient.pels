import { describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  combinedPriceDataFromStore,
  flattenAllHours,
} from '../../lib/price/priceStore';
import { createCombinedPricesReader } from '../../lib/price/combinedPricesReader';
import type { CombinedPricesV2 } from '../../lib/price/priceTypes';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';

const TZ = 'Europe/Oslo';

// Each call builds a fresh reader (instance-scoped refetch guard) — equivalent
// to the production singleton for non-re-entrant reads. The re-entrancy test
// below deliberately reuses one reader instance.
const readStore = (settings: SettingsPort, requestRefetch: () => void, now: Date, tz: string) =>
  createCombinedPricesReader(settings, requestRefetch).readStore(now, tz);

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

/** Every member of the port, spied, each spy carrying that member's own signature. */
type SettingsPortStub = { [K in keyof SettingsPort]: Mock<SettingsPort[K]> };

/**
 * A LIVE settings double: a write is visible to the next read, as the real
 * store is. The mapped return type rather than a trailing `satisfies` is what
 * holds each spy to the port's own signature — see the reasoning in
 * `test/mocks/deviceDiagnosticsRecorder.ts`.
 */
const buildSettings = (initial: unknown): SettingsPortStub => {
  let value = initial;
  return {
    get: vi.fn((_key: string) => value),
    set: vi.fn((_key: string, next: unknown) => { value = next; }),
    unset: vi.fn((_key: string) => { value = undefined; }),
    getKeys: vi.fn(() => []),
  };
};

describe('readStore', () => {
  test('returns the V2 store, pruned in place', () => {
    const settings = buildSettings({ ...buildStore(), days: { ...buildStore().days, '2026-05-01': { hours: [] } } });
    const requestRefetch = vi.fn();
    const result = readStore(settings, requestRefetch, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.days).sort()).toEqual(['2026-05-09', '2026-05-10', '2026-05-11']);
    expect(requestRefetch).not.toHaveBeenCalled();
  });

  // Regression for #646 review: a malformed-but-versioned payload like
  // `{ version: 2, days: { '...': null } }` previously passed `isCombinedPricesV2`
  // and then crashed `flattenAllHours` when it dereferenced `day.hours`.
  test('treats malformed V2 day entries as non-V2 and triggers recovery', () => {
    const settings = buildSettings({
      version: 2,
      days: { '2026-05-10': null },
      avgPrice: 1, lowThreshold: 0, highThreshold: 2,
      priceScheme: 'norway', priceUnit: 'NOK/kWh',
    });
    const requestRefetch = vi.fn();
    const result = readStore(settings, requestRefetch, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(result).toBeNull();
    expect(settings.set).toHaveBeenCalledWith('combined_prices', null);
    expect(requestRefetch).toHaveBeenCalledTimes(1);
  });

  test('treats V2 payload missing top-level metadata as non-V2', () => {
    const settings = buildSettings({ version: 2, days: {} });
    const requestRefetch = vi.fn();
    const result = readStore(settings, requestRefetch, new Date('2026-05-10T12:00:00.000Z'), TZ);
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
    const settings = buildSettings(legacy);
    const requestRefetch = vi.fn();
    const result = readStore(settings, requestRefetch, new Date('2026-05-10T12:00:00.000Z'), TZ);

    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(Object.keys(result!.days).sort()).toEqual(['2026-05-09', '2026-05-10', '2026-05-11']);
    expect(result!.priceScheme).toBe('norway');
    expect(result!.priceUnit).toBe('NOK/kWh');
    expect(result!.lastFetched).toBe('2026-05-10T00:00:00.000Z');
    // The migration must persist V2 to settings so subsequent direct reads
    // (settingsUiApi, widget) see V2 too.
    expect(settings.set).toHaveBeenCalledTimes(1);
    const written = settings.set.mock.calls[0][1] as { version: number };
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
    const settings = buildSettings(legacy);
    const requestRefetch = vi.fn();
    const result = readStore(settings, requestRefetch, new Date('2026-05-10T12:00:00.000Z'), TZ);

    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.days).toEqual({});
    expect(result!.priceScheme).toBe('flow');
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(requestRefetch).toHaveBeenCalledTimes(1);
  });

  test('returns null and does not refetch when settings is null', () => {
    const settings = buildSettings(null);
    const requestRefetch = vi.fn();
    const result = readStore(settings, requestRefetch, new Date('2026-05-10T12:00:00.000Z'), TZ);
    expect(result).toBeNull();
    expect(settings.set).not.toHaveBeenCalled();
    expect(requestRefetch).not.toHaveBeenCalled();
  });

  test('refetch guard prevents re-entrant refetch when malformed payload triggers it', () => {
    // A truly malformed payload (not V2 and not V1-shaped) must still drop and
    // request a refetch. The guard prevents recursion if the refetcher reads
    // synchronously.
    // NOT the live double: the recovery path writes `null` before it calls the
    // refetcher, so a live read would answer the re-entrant call with `null`
    // and return early — `guardedRequestRefetch` would never be re-entered and
    // this test would pass whether or not the guard existed. Answering the
    // malformed payload every time is what drives the re-entrant read back
    // into the refetch, leaving the guard as the only thing ending it.
    const settings: SettingsPortStub = {
      get: vi.fn((_key: string) => ({ unrelated: 'shape' })),
      set: vi.fn(),
      unset: vi.fn(),
      getKeys: vi.fn(() => []),
    };
    // Re-entrancy must go through the SAME reader instance for the guard to
    // engage (it is instance-scoped); production shares one reader on AppContext.
    const requestRefetch = vi.fn(() => {
      reader.readStore(new Date('2026-05-10T12:00:00.000Z'), TZ);
    });
    const reader = createCombinedPricesReader(settings, requestRefetch);
    reader.readStore(new Date('2026-05-10T12:00:00.000Z'), TZ);
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
