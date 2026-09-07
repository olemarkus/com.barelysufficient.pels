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
import { importLegacySettingsKey, isLegacySettingsKeyListed } from '../store/legacySettingsImport';
import type { PreparedStatement, UserdataDatabase } from '../store/userdataDatabase';
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS weather_history_days (
  date_key TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS weather_history_fields (
  key TEXT PRIMARY KEY NOT NULL, value_json TEXT NOT NULL
) WITHOUT ROWID;
`;

type Statements = {
  upsertDay: PreparedStatement; deleteDay: PreparedStatement; loadDays: PreparedStatement;
  upsertField: PreparedStatement; deleteField: PreparedStatement; loadFields: PreparedStatement;
};

const prepareStatements = (db: UserdataDatabase): Statements => ({
  upsertDay: db.prepare('INSERT INTO weather_history_days (date_key, record_json) VALUES (?, ?) '
    + 'ON CONFLICT (date_key) DO UPDATE SET record_json = excluded.record_json'),
  deleteDay: db.prepare('DELETE FROM weather_history_days WHERE date_key = ?'),
  loadDays: db.prepare('SELECT date_key, record_json FROM weather_history_days ORDER BY date_key'),
  upsertField: db.prepare('INSERT INTO weather_history_fields (key, value_json) VALUES (?, ?) '
    + 'ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json'),
  deleteField: db.prepare('DELETE FROM weather_history_fields WHERE key = ?'),
  loadFields: db.prepare('SELECT key, value_json FROM weather_history_fields'),
});

const parseRow = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
};

/** What the store holds, as the diff base of the next write. */
type Held = { days: Map<string, WeatherDailyRecord>; fields: Map<string, unknown> };

const heldOf = (state: WeatherHistoryState): Held => ({
  days: new Map(state.records.map((record) => [record.dateKey, record])),
  fields: new Map(Object.entries(state).filter(([key, value]) => key !== 'records' && value !== undefined)),
});

const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export const createWeatherHistoryStore = (db: UserdataDatabase): WeatherHistoryStore => {
  db.exec(SCHEMA);
  const s = prepareStatements(db);
  let held: Held | null = null;

  /** Runs inside a transaction: an unparseable row is deleted as it is read. */
  const load = (): WeatherHistoryState | null => {
    const dayRows = s.loadDays.all() as Array<{ date_key: string; record_json: string }>;
    const fieldRows = s.loadFields.all() as Array<{ key: string; value_json: string }>;
    if (dayRows.length === 0 && fieldRows.length === 0) return null;
    const records = dayRows.flatMap((row) => {
      const record = parseRow(row.record_json);
      if (record !== undefined) return [record as WeatherDailyRecord];
      storeLogger.error({ event: 'weather_history_row_quarantined', where: `day ${row.date_key}` });
      s.deleteDay.run(row.date_key);
      return [];
    });
    const fields = Object.fromEntries(fieldRows.flatMap((row) => {
      const value = parseRow(row.value_json);
      if (value !== undefined) return [[row.key, value] as const];
      storeLogger.error({ event: 'weather_history_row_quarantined', where: `field ${row.key}` });
      s.deleteField.run(row.key);
      return [];
    }));
    if (records.length === 0 && Object.keys(fields).length === 0) return null;
    return { ...fields, records };
  };

  const writeDays = (next: Map<string, WeatherDailyRecord>, previous: Held | null): void => {
    for (const [dateKey, record] of next) {
      const before = previous?.days.get(dateKey);
      if (before === undefined || !sameJson(before, record)) s.upsertDay.run(dateKey, JSON.stringify(record));
    }
    for (const dateKey of previous?.days.keys() ?? []) {
      if (!next.has(dateKey)) s.deleteDay.run(dateKey);
    }
  };

  const writeFields = (next: Map<string, unknown>, previous: Held | null): void => {
    for (const [key, value] of next) {
      const before = previous?.fields.get(key);
      if (before === undefined || !sameJson(before, value)) s.upsertField.run(key, JSON.stringify(value));
    }
    for (const key of previous?.fields.keys() ?? []) {
      if (!next.has(key)) s.deleteField.run(key);
    }
  };

  const writeDiff = (next: WeatherHistoryState, previous: Held | null): void => {
    const target = heldOf(next);
    writeDays(target.days, previous);
    writeFields(target.fields, previous);
  };

  return {
    read: () => db.transaction(() => {
      const state = load();
      held = state === null ? null : heldOf(state);
      return state;
    }),
    write: (state) => {
      db.transaction(() => {
        // A store that has neither read nor written diffs against its rows
        // on disk, so a write can always delete what `state` dropped.
        const previous = held ?? (() => {
          const stored = load();
          return stored === null ? null : heldOf(stored);
        })();
        writeDiff(state, previous);
      });
      held = heldOf(state);
    },
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
 * from the store.
 */
export const importLegacyWeatherHistory = (settings: SettingsPort, store: WeatherHistoryStore): void => {
  if (isLegacySettingsKeyListed(settings, WEATHER_HISTORY_STATE) !== true) return;
  const result = importLegacySettingsKey(settings, WEATHER_HISTORY_STATE, {
    holds: () => false,
    adopt: (raw) => {
      const legacy = normalizeWeatherHistoryState(raw);
      if (legacy === null) return false;
      const stored = normalizeWeatherHistoryState(store.read());
      store.write(stored === null ? legacy : withLegacyUnder(stored, legacy));
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
