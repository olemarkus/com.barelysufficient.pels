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
import { NETTLEIE_DATA } from '../utils/settingsKeys';
import { isGridTariffFallbackData, oneGridTariffEntryPerHour } from './gridTariffUtils';

const storeLogger = getLogger('price/cache-store');

/** The caches this store holds, one row each. */
export type PriceCacheKey = 'grid_tariff';

export type PriceCacheStore = {
  /** The cached value, or `null` when the store holds none. Throws only on I/O. */
  read(key: PriceCacheKey): unknown;
  /** Replace the cached value. A value equal to the one held writes nothing. */
  write(key: PriceCacheKey, value: unknown): void;
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

/**
 * The one-shot import of the legacy `nettleie_data` settings key, run at boot
 * before the price service first reads the tariff. Rules and their reasons:
 * `lib/store/legacySettingsImport.ts`. A tariff fetched from NVE since the
 * upgrade wins and the key is just retired; otherwise the key's rows are
 * adopted, one per hour, over whatever stopgap the store holds.
 */
export const importLegacyGridTariff = (settings: SettingsPort, cache: PriceCacheStore): void => {
  if (isLegacySettingsKeyListed(settings, NETTLEIE_DATA) !== true) return;
  const result = importLegacySettingsKey(settings, NETTLEIE_DATA, {
    holds: () => holdsFetchedTariff(cache.read('grid_tariff')),
    adopt: (raw) => {
      if (!Array.isArray(raw)) return false;
      cache.write('grid_tariff', oneGridTariffEntryPerHour(raw as Array<Record<string, unknown>>));
      return true;
    },
  });
  if (result.outcome === 'imported') {
    storeLogger.info({ event: 'legacy_grid_tariff_imported' });
  } else if (result.outcome === 'retired') {
    storeLogger.info({ event: 'legacy_grid_tariff_key_retired', reason: result.reason });
  } else {
    storeLogger.warn({
      event: 'legacy_grid_tariff_import_deferred',
      reason: result.reason,
      ...(result.error === undefined ? {} : { err: normalizeError(result.error) }),
    });
  }
};
