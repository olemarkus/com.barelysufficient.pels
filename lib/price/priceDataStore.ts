import type { SettingsPort } from '../ports/homeyRuntime';
import {
  COMBINED_PRICES,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  POWERHOUR_PRICES_CURRENCY,
  POWERHOUR_PRICES_DEVICE,
  POWERHOUR_PRICES_TODAY,
  POWERHOUR_PRICES_TOMORROW,
} from '../utils/settingsKeys';
import type { SpotPriceEntry } from './spotPriceFetch';
import {
  DEFAULT_PERIOD_MINUTES,
  type FlowPricePayload,
  type FlowPricePeriod,
} from '../../packages/shared-domain/src/price/flowPriceUtils';
import { readPowerhourDeviceIdSetting } from '../../packages/shared-domain/src/settings/priceScheme';
import type {
  PowerhourCache, PowerhourCacheDevice, PowerhourCachedDay, PowerhourDay,
} from './powerhourScheme';
import type { CombinedPricesV2 } from './priceTypes';
import { importPendingLegacyPriceCache, type PriceCacheStore, type PricePayloadKey } from './priceCacheStore';
import { isLegacySettingsKeyListed } from '../store/legacySettingsImport';

/**
 * The persisted form of a priced period. The duration is omitted when the
 * period is an hour long, because that is exactly what the read boundary gives
 * a period that carries none (`normalizeFlowSlotEntries`) — so an hourly source
 * stores what it always stored, and only a sub-hourly source pays the bytes for
 * saying how long its periods are.
 */
type StoredFlowPricePeriod = {
  startsAt: string;
  totalPrice: number;
  durationMinutes?: number;
};

type StoredFlowPricePayload = Omit<FlowPricePayload, 'pricesBySlot' | 'pricesByPeriod'> & {
  pricesBySlot?: StoredFlowPricePeriod[];
  pricesByPeriod?: StoredFlowPricePeriod[];
};

const toStoredPeriods = (periods: FlowPricePeriod[]): StoredFlowPricePeriod[] => (
  periods.map(({ startsAt, totalPrice, durationMinutes }) => (
    durationMinutes === DEFAULT_PERIOD_MINUTES
      ? { startsAt, totalPrice }
      : { startsAt, totalPrice, durationMinutes }
  ))
);

const toStoredFlowPayload = (payload: FlowPricePayload | null): StoredFlowPricePayload | null => {
  if (!payload) return payload;
  return {
    ...payload,
    ...(payload.pricesBySlot ? { pricesBySlot: toStoredPeriods(payload.pricesBySlot) } : {}),
    ...(payload.pricesByPeriod ? { pricesByPeriod: toStoredPeriods(payload.pricesByPeriod) } : {}),
  };
};

/**
 * A Power by the Hour row the cache does not hold, while its legacy settings
 * key may still be pending its one-shot import: the old key's own
 * classification, so the merge guards behave exactly as they did before the
 * move. A key that reads back `undefined` settles nothing (`unreadable`); a
 * listed `null` is absence, which is what the SDK answers for an unset key and
 * what reading it otherwise turned into a home that never got prices again.
 */
const classifyPendingLegacyKey = (settings: SettingsPort, key: string): 'absent' | 'unreadable' => {
  try {
    if (isLegacySettingsKeyListed(settings, key) === false) return 'absent';
    return settings.get(key) === undefined ? 'unreadable' : 'absent';
  } catch {
    return 'unreadable';
  }
};

/**
 * One Power by the Hour cache row. The source MERGES into the day it already
 * holds, so "nothing came back" has to be told apart from "nothing is there".
 * A read that throws is `unreadable`. A missing row first retries the key's
 * import (a boot whose read of the old key came back empty leaves it pending),
 * so a day PELS still holds only in the old key is never written over with the
 * app's future-only answer.
 */
const readPowerhourRow = (
  settings: SettingsPort,
  cache: PriceCacheStore,
  key: typeof POWERHOUR_PRICES_TODAY | typeof POWERHOUR_PRICES_TOMORROW | typeof POWERHOUR_PRICES_DEVICE,
): { kind: 'stored'; value: unknown } | { kind: 'absent' } | { kind: 'unreadable' } => {
  let value: unknown;
  try {
    value = cache.read(key);
    if (value === null) {
      importPendingLegacyPriceCache(settings, cache, key);
      value = cache.read(key);
    }
  } catch {
    return { kind: 'unreadable' };
  }
  return value === null ? { kind: classifyPendingLegacyKey(settings, key) } : { kind: 'stored', value };
};

/**
 * The stored combined prices. A missing row first retries the old key's import:
 * a boot whose read of `combined_prices` came back empty leaves the key pending,
 * and until then the prices the owner had are still only there.
 */
const readCombinedRow = (settings: SettingsPort, cache: PriceCacheStore): unknown => {
  const value = cache.read(COMBINED_PRICES);
  if (value !== null) return value;
  importPendingLegacyPriceCache(settings, cache, COMBINED_PRICES);
  return cache.read(COMBINED_PRICES);
};

const readCachedDay = (
  settings: SettingsPort,
  cache: PriceCacheStore,
  key: typeof POWERHOUR_PRICES_TODAY | typeof POWERHOUR_PRICES_TOMORROW,
): PowerhourCachedDay => {
  const row = readPowerhourRow(settings, cache, key);
  return row.kind === 'stored' ? { kind: 'stored', payload: row.value } : row;
};

const readCacheDevice = (settings: SettingsPort, cache: PriceCacheStore): PowerhourCacheDevice => {
  const row = readPowerhourRow(settings, cache, POWERHOUR_PRICES_DEVICE);
  if (row.kind !== 'stored') return row;
  const deviceId = readPowerhourDeviceIdSetting(row.value);
  return deviceId === null ? { kind: 'absent' } : { kind: 'device', deviceId };
};

const readPowerhourCacheFrom = (settings: SettingsPort, cache: PriceCacheStore): PowerhourCache => ({
  today: readCachedDay(settings, cache, POWERHOUR_PRICES_TODAY),
  tomorrow: readCachedDay(settings, cache, POWERHOUR_PRICES_TOMORROW),
  device: readCacheDevice(settings, cache),
});

/** A stored currency label, or `null` when none is stored or it is blank. */
const readCurrency = (
  cache: PriceCacheStore,
  key: typeof HOMEY_PRICES_CURRENCY | typeof POWERHOUR_PRICES_CURRENCY,
): string | null => {
  const value = cache.read(key);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

/**
 * Producer-side typed boundary for PriceService's cached price data
 * (spot prices, grid tariff, the flow/homey/powerhour flow-price slot payloads,
 * and the homey- and powerhour-prices currencies). Writes are typed so a wrong shape can't be persisted;
 * reads return the raw persisted value (callers validate/cast as before). The
 * flow methods are keyed because the same purge path serves both the
 * FLOW_PRICES_* and HOMEY_PRICES_* slot pairs.
 *
 * It also owns the COMBINED_PRICES producer read-back/write that PriceService
 * uses when rebuilding the cache. `readCombinedRaw` returns the persisted
 * COMBINED_PRICES value verbatim — un-migrated and un-pruned — because
 * PriceService fingerprints it and runs the transient-read data-safety guard
 * against the raw bytes (migration/pruning is the separate combined-prices
 * reader's job for consumers). `writeCombined` persists the freshly-built V2
 * payload.
 */
export type PriceDataStore = {
  readSpotPrices(): unknown;
  writeSpotPrices(prices: SpotPriceEntry[]): void;
  readSpotPriceArea(): unknown;
  writeSpotPriceArea(area: string): void;
  readNettleie(): unknown;
  writeNettleie(data: Array<Record<string, unknown>>): void;
  readFlowPayload(key: PricePayloadKey): unknown;
  writeFlowPayload(key: PricePayloadKey, payload: FlowPricePayload | null): void;
  readHomeyPricesCurrency(): string | null;
  writeHomeyPricesCurrency(unit: string): void;
  readPowerhourCurrency(): string | null;
  writePowerhourCurrency(unit: string | null): void;
  /** Everything already stored from the Power by the Hour source, as one concept. */
  readPowerhourCache(): PowerhourCache;
  writePowerhourDay(day: PowerhourDay, payload: FlowPricePayload | null): void;
  writePowerhourCacheDevice(deviceId: string | null): void;
  readCombinedRaw(): unknown;
  writeCombined(payload: CombinedPricesV2): void;
  /** Drop the stored combined prices, for a payload no reader can use. */
  clearCombined(): void;
};

/**
 * The {@link PriceDataStore} over settings and the userdata price cache. It
 * lives beside the port it implements because the reads and the keys they use
 * are the price module's own: `setup/` hands over a {@link SettingsPort} and the
 * cache and knows nothing about which store backs which field. Every price
 * cache, the combined prices included, is in the userdata store
 * (`priceCacheStore.ts`); settings are read only for legacy keys whose import
 * may still be pending.
 */
export const createPriceDataStore = (settings: SettingsPort, cache: PriceCacheStore): PriceDataStore => {
  // A missing Flow day may still be in a legacy key whose boot read failed.
  const readFlowPayload = (key: PricePayloadKey): unknown => {
    const value = cache.read(key);
    if (value !== null || (key !== FLOW_PRICES_TODAY && key !== FLOW_PRICES_TOMORROW)) return value;
    // Even an empty key list can be a transient SDK miss; retry while no row exists.
    importPendingLegacyPriceCache(settings, cache, key);
    return cache.read(key);
  };

  return {
    readSpotPrices: () => cache.read('spot_prices'),
    writeSpotPrices: (prices) => cache.write('spot_prices', prices),
    readSpotPriceArea: () => cache.read('spot_price_area'),
    writeSpotPriceArea: (area) => cache.write('spot_price_area', area),
    readNettleie: () => cache.read('grid_tariff'),
    writeNettleie: (data) => cache.write('grid_tariff', data),
    readFlowPayload,
    // A cleared day or marker is no row at all, never a stored `null`.
    writeFlowPayload: (key, payload) => (
      payload === null ? cache.remove(key) : cache.write(key, toStoredFlowPayload(payload))
    ),
    readHomeyPricesCurrency: () => readCurrency(cache, HOMEY_PRICES_CURRENCY),
    writeHomeyPricesCurrency: (unit) => cache.write(HOMEY_PRICES_CURRENCY, unit),
    readPowerhourCurrency: () => readCurrency(cache, POWERHOUR_PRICES_CURRENCY),
    writePowerhourCurrency: (unit) => (
      unit === null ? cache.remove(POWERHOUR_PRICES_CURRENCY) : cache.write(POWERHOUR_PRICES_CURRENCY, unit)
    ),
    readPowerhourCache: () => readPowerhourCacheFrom(settings, cache),
    writePowerhourDay: (day, payload) => {
      const key = day === 'today' ? POWERHOUR_PRICES_TODAY : POWERHOUR_PRICES_TOMORROW;
      if (payload === null) cache.remove(key);
      else cache.write(key, toStoredFlowPayload(payload));
    },
    writePowerhourCacheDevice: (deviceId) => (
      deviceId === null ? cache.remove(POWERHOUR_PRICES_DEVICE) : cache.write(POWERHOUR_PRICES_DEVICE, deviceId)
    ),
    readCombinedRaw: () => readCombinedRow(settings, cache),
    writeCombined: (payload) => cache.write(COMBINED_PRICES, payload),
    clearCombined: () => cache.remove(COMBINED_PRICES),
  };
};
