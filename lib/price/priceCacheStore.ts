/**
 * The price module's caches in the userdata database: one JSON row per cache.
 *
 * A cache is fetched or derived data the module can always rebuild, so it does
 * not belong in `homey.settings`, where every byte is shipped to Homey core on
 * every write of any key (`notes/settings-key-ownership.md` § "Which store a
 * key lives in"). Here a write costs the bytes written and nothing else.
 *
 * The parsed value is held in memory after the first read or write. The store
 * is the only writer of its rows, so memory and disk agree, and the grid tariff
 * is read on every combined-price build: parsing it from disk each time would
 * put a JSON parse on every plan rebuild. Callers treat the value as read-only.
 *
 * A row that does not parse is the store's own damage: regenerable by
 * definition, it is deleted on read and said once, and the cache reads as
 * empty until the next fetch fills it.
 */
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import { importLegacySettingsKey, isLegacySettingsKeyListed } from '../store/legacySettingsImport';
import type { PreparedStatement, UserdataDatabase } from '../store/userdataDatabase';
import { normalizeError } from '../utils/errorUtils';
import {
  ELECTRICITY_PRICES,
  ELECTRICITY_PRICES_AREA,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  NETTLEIE_DATA,
  POWERHOUR_PRICES_CURRENCY,
  POWERHOUR_PRICES_DEVICE,
  POWERHOUR_PRICES_TODAY,
  POWERHOUR_PRICES_TOMORROW,
} from '../utils/settingsKeys';
import { isGridTariffFallbackData, oneGridTariffEntryPerHour } from './gridTariffUtils';

const storeLogger = getLogger('price/cache-store');

/**
 * The day payloads a payload-fed price source stores (Flow, Homey Energy,
 * Power by the Hour). Each row keeps the name its settings key had, as do the
 * currency and device-marker rows stored beside them.
 */
export type PricePayloadKey =
  | typeof FLOW_PRICES_TODAY | typeof FLOW_PRICES_TOMORROW
  | typeof HOMEY_PRICES_TODAY | typeof HOMEY_PRICES_TOMORROW
  | typeof POWERHOUR_PRICES_TODAY | typeof POWERHOUR_PRICES_TOMORROW;

/** The caches this store holds, one row each. */
export type PriceCacheKey =
  | 'grid_tariff' | 'spot_prices' | 'spot_price_area'
  | PricePayloadKey
  | typeof HOMEY_PRICES_CURRENCY | typeof POWERHOUR_PRICES_CURRENCY | typeof POWERHOUR_PRICES_DEVICE;

export type PriceCacheStore = {
  /** The cached value, or `null` when the store holds none. Throws only on I/O. */
  read(key: PriceCacheKey): unknown;
  /** Replace the cached value. A value equal to the one held writes nothing. */
  write(key: PriceCacheKey, value: unknown): void;
  /** Drop the cached value, so a read answers `null`. */
  remove(key: PriceCacheKey): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS price_cache (
  key TEXT PRIMARY KEY NOT NULL, value_json TEXT NOT NULL
) WITHOUT ROWID;
`;

type Statements = { load: PreparedStatement; upsert: PreparedStatement; remove: PreparedStatement };

type Held = { json: string; value: unknown };

export const createPriceCacheStore = (db: UserdataDatabase): PriceCacheStore => {
  db.exec(SCHEMA);
  const s: Statements = {
    load: db.prepare('SELECT value_json FROM price_cache WHERE key = ?'),
    upsert: db.prepare('INSERT INTO price_cache (key, value_json) VALUES (?, ?) '
      + 'ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json'),
    remove: db.prepare('DELETE FROM price_cache WHERE key = ?'),
  };
  const held = new Map<PriceCacheKey, Held | null>();

  const load = (key: PriceCacheKey): Held | null => {
    const row = s.load.get(key) as { value_json: string } | undefined;
    if (row === undefined) return null;
    try {
      return { json: row.value_json, value: JSON.parse(row.value_json) as unknown };
    } catch {
      storeLogger.error({ event: 'price_cache_row_quarantined', key });
      s.remove.run(key);
      return null;
    }
  };

  const heldFor = (key: PriceCacheKey): Held | null => {
    if (!held.has(key)) held.set(key, load(key));
    return held.get(key) ?? null;
  };

  return {
    read: (key) => heldFor(key)?.value ?? null,
    write: (key, value) => {
      const json = JSON.stringify(value);
      if (heldFor(key)?.json === json) return;
      s.upsert.run(key, json);
      held.set(key, { json, value: JSON.parse(json) as unknown });
    },
    remove: (key) => {
      if (held.has(key) && held.get(key) === null) return;
      s.remove.run(key);
      held.set(key, null);
    },
  };
};

/**
 * Whether the store holds a tariff fetched from NVE. The static fallback and an
 * empty tariff do not count: a fallback is a stopgap that never outranks a real
 * tariff (`resolveGridTariffFallback` keeps a real cache over it), and the boot
 * price refresh can write one into an empty store before a deferred import has
 * run, so treating it as held would retire the real tariff unread.
 */
const holdsFetchedTariff = (value: unknown): boolean => (
  Array.isArray(value) && value.length > 0 && !isGridTariffFallbackData(value as Array<{ source?: unknown }>)
);

/** One legacy settings key and the cache row it moves into. */
type LegacyPriceCache = {
  settingsKey: string;
  cacheKey: PriceCacheKey;
  /**
   * Whether what the store holds already beats the key, which is then retired
   * unread: a value fetched since the upgrade is newer than anything the key
   * could hold.
   */
  storeWins: (held: unknown) => boolean;
  /** The key's value in the stored shape, or `null` when it holds nothing usable. */
  toStored: (raw: unknown) => unknown;
};

const payloadCache = (key: PricePayloadKey): LegacyPriceCache => ({
  settingsKey: key,
  cacheKey: key,
  storeWins: (held) => held !== null,
  toStored: (raw) => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null),
});

const markerCache = (
  key: typeof HOMEY_PRICES_CURRENCY | typeof POWERHOUR_PRICES_CURRENCY | typeof POWERHOUR_PRICES_DEVICE,
): LegacyPriceCache => ({
  settingsKey: key,
  cacheKey: key,
  storeWins: (held) => typeof held === 'string',
  toStored: (raw) => (typeof raw === 'string' ? raw : null),
});

const LEGACY_PRICE_CACHES: readonly LegacyPriceCache[] = [
  {
    settingsKey: NETTLEIE_DATA,
    cacheKey: 'grid_tariff',
    storeWins: holdsFetchedTariff,
    toStored: (raw) => (Array.isArray(raw) ? oneGridTariffEntryPerHour(raw as Array<Record<string, unknown>>) : null),
  },
  {
    settingsKey: ELECTRICITY_PRICES,
    cacheKey: 'spot_prices',
    storeWins: (held) => Array.isArray(held) && held.length > 0,
    toStored: (raw) => (Array.isArray(raw) ? raw : null),
  },
  {
    settingsKey: ELECTRICITY_PRICES_AREA,
    cacheKey: 'spot_price_area',
    storeWins: (held) => typeof held === 'string' && held !== '',
    toStored: (raw) => (typeof raw === 'string' && raw !== '' ? raw : null),
  },
  payloadCache(FLOW_PRICES_TODAY),
  payloadCache(FLOW_PRICES_TOMORROW),
  payloadCache(HOMEY_PRICES_TODAY),
  payloadCache(HOMEY_PRICES_TOMORROW),
  payloadCache(POWERHOUR_PRICES_TODAY),
  payloadCache(POWERHOUR_PRICES_TOMORROW),
  markerCache(HOMEY_PRICES_CURRENCY),
  markerCache(POWERHOUR_PRICES_CURRENCY),
  markerCache(POWERHOUR_PRICES_DEVICE),
];

/**
 * Retire the key unread when the store already holds a value that beats it.
 * Checked before the key is read, so a key the old code left holding `null`
 * (the Flow and Homey rotations cleared days that way) is retired once a newer
 * row lands, instead of deferring as a possible transient miss on every boot.
 */
const retireBeatenKey = (settings: SettingsPort, cache: PriceCacheStore, legacy: LegacyPriceCache): boolean => {
  try {
    if (!legacy.storeWins(cache.read(legacy.cacheKey))) return false;
    settings.unset(legacy.settingsKey);
  } catch {
    return false;
  }
  storeLogger.info({
    event: 'legacy_price_cache_key_retired', settingsKey: legacy.settingsKey, reason: 'store_already_holds',
  });
  return true;
};

const importLegacyPriceCache = (settings: SettingsPort, cache: PriceCacheStore, legacy: LegacyPriceCache): void => {
  const { settingsKey, cacheKey } = legacy;
  if (isLegacySettingsKeyListed(settings, settingsKey) !== true) return;
  if (retireBeatenKey(settings, cache, legacy)) return;
  const result = importLegacySettingsKey(settings, settingsKey, {
    holds: () => legacy.storeWins(cache.read(cacheKey)),
    adopt: (raw) => {
      const stored = legacy.toStored(raw);
      if (stored === null) return false;
      cache.write(cacheKey, stored);
      return true;
    },
  });
  if (result.outcome === 'imported') {
    storeLogger.info({ event: 'legacy_price_cache_imported', settingsKey });
  } else if (result.outcome === 'retired') {
    storeLogger.info({ event: 'legacy_price_cache_key_retired', settingsKey, reason: result.reason });
  } else {
    storeLogger.warn({
      event: 'legacy_price_cache_import_deferred',
      settingsKey,
      reason: result.reason,
      ...(result.error === undefined ? {} : { err: normalizeError(result.error) }),
    });
  }
};

/**
 * The one-shot import of the legacy price-cache settings keys, run at boot
 * before the price service first reads them. Rules and their reasons:
 * `lib/store/legacySettingsImport.ts`. Each key is decided on its own: a value
 * fetched since the upgrade wins and the key is just retired; otherwise the
 * key's value is adopted, over whatever stopgap the store holds.
 */
export const importLegacyPriceCaches = (settings: SettingsPort, cache: PriceCacheStore): void => {
  for (const legacy of LEGACY_PRICE_CACHES) importLegacyPriceCache(settings, cache, legacy);
};

/**
 * Retry the import of one cache's legacy key, for a reader that finds no row
 * while the key may still be pending. A no-op once the key is gone.
 */
export const importPendingLegacyPriceCache = (
  settings: SettingsPort,
  cache: PriceCacheStore,
  cacheKey: PriceCacheKey,
): void => {
  const legacy = LEGACY_PRICE_CACHES.find((entry) => entry.cacheKey === cacheKey);
  if (legacy !== undefined) importLegacyPriceCache(settings, cache, legacy);
};
