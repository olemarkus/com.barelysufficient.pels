/**
 * The weather history's rows in the userdata database, behind the port the
 * collector persists through.
 *
 * The state is one daily record per calendar day (two years of them — the
 * 180 kB that used to ride `homey.settings` as one blob) plus a handful of
 * small fields: the in-progress accumulators, the cached MET forecast, the
 * backfill markers, the latest fit and suggestion. Each record is one row and
 * each other field is one JSON row, so a persist writes the day that changed
 * and the fields that changed, not the two years around them. `read` answers
 * `null` when the store holds nothing — an affirmative answer, unlike the
 * settings blob's absence: only a throw is a transient here, and the
 * collector classifies that as absent so its grace window covers it.
 *
 * Rows come back as the raw objects that went in; the collector normalises
 * on read (`normalizeWeatherHistoryState`), which is where a malformed record
 * is dropped. A row that does not even parse is the store's own damage:
 * regenerable by ruling, it is deleted on read and said once, so it neither
 * costs the rows around it nor lingers to be re-logged on every boot.
 */
import type { WeatherDailyRecord, WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import {
  hasLegacyImportMark,
  importLegacySettingsKey,
  isLegacySettingsKeyListed,
  type MarkedLegacyImport,
  writeLegacyImportMark,
} from '../store/legacySettingsImport';
import { createJsonRowTable } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { normalizeError } from '../utils/errorUtils';
import { WEATHER_HISTORY_STATE } from '../utils/settingsKeys';
import { normalizeWeatherHistoryState } from './weatherHistory';

const storeLogger = getLogger('weather/history-store');

/**
 * Port over the persisted weather history. The collector receives this typed
 * store and never touches persistence itself; `createWeatherHistoryStore`
 * below is its one production implementation.
 */
export type WeatherHistoryStore = {
  /** The stored state as raw rows, or `null` when the store holds nothing. Throws only on I/O. */
  read(): unknown;
  /** Persist `state`, touching only the rows that differ from what the store holds. */
  write(state: WeatherHistoryState): void;
};

/** The store as this module builds it: the collector's port, and the legacy import's. */
export type WeatherHistoryRepository = WeatherHistoryStore & MarkedLegacyImport<WeatherHistoryState>;

export const createWeatherHistoryStore = (db: UserdataDatabase): WeatherHistoryRepository => {
  const days = createJsonRowTable(
    db, 'weather_history_days', ['date_key', 'record_json'], (record) => record as WeatherDailyRecord,
  );
  const fields = createJsonRowTable(db, 'weather_history_fields', ['key', 'value_json'], (value) => value);
  const writeRows = (state: WeatherHistoryState): void => {
    days.write(new Map(state.records.map((record) => [record.dateKey, record])));
    fields.write(new Map(Object.entries(state).filter(([key, value]) => key !== 'records' && value !== undefined)));
  };
  return {
    read: () => db.transaction(() => {
      const records = [...days.read().values()];
      const stored = fields.read();
      if (records.length === 0 && stored.size === 0) return null;
      return { ...Object.fromEntries(stored), records };
    }),
    write: (state) => db.transaction(() => writeRows(state)),
    hasImportedLegacy: () => hasLegacyImportMark(db, WEATHER_HISTORY_STATE),
    writeLegacyImport: (state) => db.transaction(() => {
      writeRows(state);
      writeLegacyImportMark(db, WEATHER_HISTORY_STATE);
    }),
  };
};

/**
 * The legacy blob UNDER what the store holds: every day the store already has
 * and every field it owns are the newer truth (a boot whose import deferred
 * let the collector write since), and the blob only fills in the days the
 * store lacks. Not the collector's recovery merge, whose recovered side is
 * the authoritative one — here that side is the store.
 */
const withLegacyUnder = (stored: WeatherHistoryState, legacy: WeatherHistoryState): WeatherHistoryState => {
  const storedDays = new Set(stored.records.map((record) => record.dateKey));
  const records = [...stored.records, ...legacy.records.filter((record) => !storedDays.has(record.dateKey))]
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  return { ...legacy, ...stored, records };
};

/**
 * The one-shot import of the legacy `weather_history_state` settings blob
 * into the store, run at boot before the collector starts. Rules and their
 * reasons: `lib/store/legacySettingsImport.ts`. The blob goes UNDER whatever
 * the store already holds: a boot whose import deferred lets the collector
 * write the days since, and the next boot's import must keep both — the two
 * years of records from the blob, the new days and every store-owned field
 * from the store. Only the import's own mark retires the key: the blob fills
 * every field the store lacks, so merging it again after an import whose
 * unset failed would bring back what the collector has dropped since, such
 * as the fit and the budget pressure a meter switch strips
 * (`stripMeterScopeDerivedState`).
 */
export const importLegacyWeatherHistory = (settings: SettingsPort, store: WeatherHistoryRepository): void => {
  if (isLegacySettingsKeyListed(settings, WEATHER_HISTORY_STATE) !== true) return;
  const result = importLegacySettingsKey(settings, WEATHER_HISTORY_STATE, {
    holds: () => store.hasImportedLegacy(),
    adopt: (raw) => {
      const legacy = normalizeWeatherHistoryState(raw);
      if (legacy === null) return false;
      const stored = normalizeWeatherHistoryState(store.read());
      store.writeLegacyImport(stored === null ? legacy : withLegacyUnder(stored, legacy));
      return true;
    },
  });
  if (result.outcome === 'imported') {
    storeLogger.info({ event: 'legacy_weather_history_imported' });
  } else if (result.outcome === 'retired') {
    storeLogger.info({ event: 'legacy_weather_history_key_retired', reason: result.reason });
  } else {
    storeLogger.warn({
      event: 'legacy_weather_history_import_deferred',
      reason: result.reason,
      ...(result.error === undefined ? {} : { err: normalizeError(result.error) }),
    });
  }
};
