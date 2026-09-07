/**
 * The power tracker's rows in the userdata database.
 *
 * Ownership: the only module that knows how a `PowerTrackerState` is laid out
 * on disk. The in-memory model is unchanged — `tracker.ts`, ingest and every
 * consumer still hold one state object per home — and this store is the seam
 * `homeTrackerPersistence.ts` writes through instead of `homey.settings`.
 *
 * The layout is one row per (series, key) rather than one JSON blob, because
 * the blob is what made persistence expensive: 663 kB re-serialised on every
 * write for a change of a few hundred bytes. `save` diffs the new state
 * against the last one it wrote and touches only the rows that changed; a
 * family whose object reference is unchanged (the tracker builds states by
 * spreading, so an untouched family keeps its identity) costs one comparison.
 *
 * A family that has no rows comes back ABSENT from `load`, never as `{}`. The
 * solar families are sparse by contract — a non-solar home's state stays
 * deep-equal with the pre-solar shape — and the same rule kept for every
 * family means a round trip through the store is the identity.
 */
import type { PreparedStatement, UserdataDatabase } from '../store/userdataDatabase';
import type { HomeId } from '../utils/settingsKeys';
import type { PowerTrackerState } from './trackerTypes';
import { isPlausiblePowerTrackerState, sanitizePowerTrackerSolarFields } from '../utils/appTypeGuards';

type NumberSeries = Record<string, number>;
type AverageSeries = Record<string, { sum: number; count: number }>;

/** Families keyed by UTC hour: `Record<hourKey, number>`. */
const HOURLY_FAMILIES = [
  'buckets',
  'hourlySampleCounts',
  'hourlyBudgets',
  'dailyBudgetCaps',
  'controlledBuckets',
  'uncontrolledBuckets',
  'exemptBuckets',
  'generationBuckets',
  'exportBuckets',
] as const;

/** Families keyed by local calendar date: `Record<dateKey, number>`. */
const DAILY_FAMILIES = [
  'dailyTotals',
  'controlledDailyTotals',
  'uncontrolledDailyTotals',
  'exemptDailyTotals',
  'generationDailyTotals',
  'exportDailyTotals',
] as const;

/** Families of running averages: `Record<slotKey, { sum, count }>`. */
const AVERAGE_FAMILIES = [
  'hourlyAverages',
  'controlledHourlyAverages',
  'uncontrolledHourlyAverages',
  'exemptHourlyAverages',
] as const;

/** Everything else is small and stored as one JSON value per key. */
const SCALAR_KEYS = [
  'meterIdentity',
  'lastPowerW',
  'lastControlledPowerW',
  'lastUncontrolledPowerW',
  'lastExemptPowerW',
  'lastGenerationW',
  'lastTimestamp',
  'lastDevicePowerWById',
  'unreliablePeriods',
  'objectiveProfiles',
] as const;

type HourlyFamily = (typeof HOURLY_FAMILIES)[number];
type DailyFamily = (typeof DAILY_FAMILIES)[number];
type AverageFamily = (typeof AVERAGE_FAMILIES)[number];

export type TrackerStore = {
  /**
   * The home's state as stored; `null` when the store holds no rows for it.
   * Throws when the rows do not reconstruct a plausible state, so a damaged
   * home is fenced by the caller rather than adopted.
   */
  load(homeId: HomeId): PowerTrackerState | null;
  /**
   * Write `next`, touching only rows that differ from `previous` — the state
   * this store last wrote or loaded for the home. Pass `null` to write every
   * row (a first write, or an owner reset that must not trust the diff).
   */
  save(homeId: HomeId, next: PowerTrackerState, previous: PowerTrackerState | null): void;
  /** Drop every row the home has and write `next` whole, in one transaction. */
  replace(homeId: HomeId, next: PowerTrackerState): void;
  /** Drop every row the home has. */
  clear(homeId: HomeId): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS power_tracker_hourly (
  home_id TEXT NOT NULL, series TEXT NOT NULL, hour_key TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (home_id, series, hour_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS power_tracker_daily (
  home_id TEXT NOT NULL, series TEXT NOT NULL, date_key TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (home_id, series, date_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS power_tracker_averages (
  home_id TEXT NOT NULL, series TEXT NOT NULL, slot_key TEXT NOT NULL, sum REAL NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (home_id, series, slot_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS power_tracker_device_hourly (
  home_id TEXT NOT NULL, device_id TEXT NOT NULL, hour_key TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (home_id, device_id, hour_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS power_tracker_scalars (
  home_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
  PRIMARY KEY (home_id, key)
) WITHOUT ROWID;
`;

type Statements = {
  upsertHourly: PreparedStatement; deleteHourly: PreparedStatement; loadHourly: PreparedStatement;
  upsertDaily: PreparedStatement; deleteDaily: PreparedStatement; loadDaily: PreparedStatement;
  upsertAverage: PreparedStatement; deleteAverage: PreparedStatement; loadAverages: PreparedStatement;
  upsertDevice: PreparedStatement; deleteDevice: PreparedStatement; loadDevices: PreparedStatement;
  upsertScalar: PreparedStatement; deleteScalar: PreparedStatement; loadScalars: PreparedStatement;
  clearAll: PreparedStatement[];
};

const prepareStatements = (db: UserdataDatabase): Statements => ({
  upsertHourly: db.prepare('INSERT INTO power_tracker_hourly (home_id, series, hour_key, value) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT (home_id, series, hour_key) DO UPDATE SET value = excluded.value'),
  deleteHourly: db.prepare('DELETE FROM power_tracker_hourly WHERE home_id = ? AND series = ? AND hour_key = ?'),
  loadHourly: db.prepare('SELECT series, hour_key AS key, value FROM power_tracker_hourly WHERE home_id = ?'),
  upsertDaily: db.prepare('INSERT INTO power_tracker_daily (home_id, series, date_key, value) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT (home_id, series, date_key) DO UPDATE SET value = excluded.value'),
  deleteDaily: db.prepare('DELETE FROM power_tracker_daily WHERE home_id = ? AND series = ? AND date_key = ?'),
  loadDaily: db.prepare('SELECT series, date_key AS key, value FROM power_tracker_daily WHERE home_id = ?'),
  upsertAverage: db.prepare('INSERT INTO power_tracker_averages (home_id, series, slot_key, sum, count) '
    + 'VALUES (?, ?, ?, ?, ?) ON CONFLICT (home_id, series, slot_key) DO UPDATE SET sum = excluded.sum, '
    + 'count = excluded.count'),
  deleteAverage: db.prepare('DELETE FROM power_tracker_averages WHERE home_id = ? AND series = ? AND slot_key = ?'),
  loadAverages: db.prepare('SELECT series, slot_key AS key, sum, count FROM power_tracker_averages WHERE home_id = ?'),
  upsertDevice: db.prepare('INSERT INTO power_tracker_device_hourly (home_id, device_id, hour_key, value) '
    + 'VALUES (?, ?, ?, ?) ON CONFLICT (home_id, device_id, hour_key) DO UPDATE SET value = excluded.value'),
  deleteDevice: db.prepare('DELETE FROM power_tracker_device_hourly WHERE home_id = ? AND device_id = ? '
    + 'AND hour_key = ?'),
  loadDevices: db.prepare('SELECT device_id, hour_key, value FROM power_tracker_device_hourly WHERE home_id = ?'),
  upsertScalar: db.prepare('INSERT INTO power_tracker_scalars (home_id, key, value_json) VALUES (?, ?, ?) '
    + 'ON CONFLICT (home_id, key) DO UPDATE SET value_json = excluded.value_json'),
  deleteScalar: db.prepare('DELETE FROM power_tracker_scalars WHERE home_id = ? AND key = ?'),
  loadScalars: db.prepare('SELECT key, value_json FROM power_tracker_scalars WHERE home_id = ?'),
  clearAll: [
    'power_tracker_hourly', 'power_tracker_daily', 'power_tracker_averages',
    'power_tracker_device_hourly', 'power_tracker_scalars',
  ].map((table) => db.prepare(`DELETE FROM ${table} WHERE home_id = ?`)),
});

const EMPTY: Readonly<Record<string, never>> = Object.freeze({});

/**
 * Upsert the entries of `next` that differ from `previous` and delete the ones
 * `previous` had that `next` no longer does. `write`/`remove` are the row
 * operations for one family; `same` says whether two entries are equal.
 *
 * The `next === previous` shortcut is the store's one assumption about its
 * callers: a family is REPLACED, never mutated in place (every writer in
 * `tracker.ts`, `sampleIngest.ts` and the prune spreads or rebuilds it). A
 * writer that ever did `state.buckets[key] = value` would keep the reference
 * and silently stop persisting that family.
 */
const diffRecord = <V>(
  next: Record<string, V> | undefined,
  previous: Record<string, V> | undefined,
  same: (a: V, b: V) => boolean,
  write: (key: string, value: V) => void,
  remove: (key: string) => void,
): void => {
  if (next === previous) return;
  const nextRecord = next ?? EMPTY;
  const previousRecord = previous ?? EMPTY;
  for (const [key, value] of Object.entries(nextRecord)) {
    const before = previousRecord[key];
    if (before === undefined || !same(before, value)) write(key, value);
  }
  for (const key of Object.keys(previousRecord)) {
    if (!(key in nextRecord)) remove(key);
  }
};

const sameNumber = (a: number, b: number): boolean => a === b;

/**
 * A REAL column stores a bound NaN as NULL, which the NOT NULL constraint then
 * refuses — and one such value would fail every persist for the home until
 * the bucket aged out. Ingest gates finiteness upstream; this is the store's
 * own guarantee that one bad number costs one row, never a month of history.
 */
const writeFinite = (upsert: (value: number) => void, remove: () => void) => (value: number): void => {
  if (Number.isFinite(value)) upsert(value);
  else remove();
};
const sameAverage = (a: { sum: number; count: number }, b: { sum: number; count: number }): boolean => (
  a.sum === b.sum && a.count === b.count
);

const readNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const loadState = (s: Statements, homeId: HomeId): PowerTrackerState | null => {
  const state: Record<string, unknown> = {};
  let rows = 0;
  const family = <V>(name: string): Record<string, V> => {
    const existing = state[name];
    if (existing !== undefined) return existing as Record<string, V>;
    const created: Record<string, V> = {};
    state[name] = created;
    return created;
  };
  for (const row of s.loadHourly.all(homeId) as Array<{ series: string; key: string; value: number }>) {
    family<number>(row.series)[row.key] = row.value;
    rows += 1;
  }
  for (const row of s.loadDaily.all(homeId) as Array<{ series: string; key: string; value: number }>) {
    family<number>(row.series)[row.key] = row.value;
    rows += 1;
  }
  type AverageRow = { series: string; key: string; sum: number; count: number };
  for (const row of s.loadAverages.all(homeId) as AverageRow[]) {
    family<{ sum: number; count: number }>(row.series)[row.key] = { sum: row.sum, count: row.count };
    rows += 1;
  }
  for (const row of s.loadDevices.all(homeId) as Array<{ device_id: string; hour_key: string; value: number }>) {
    const devices = family<NumberSeries>('deviceBuckets');
    (devices[row.device_id] ??= {})[row.hour_key] = row.value;
    rows += 1;
  }
  for (const row of s.loadScalars.all(homeId) as Array<{ key: string; value_json: string }>) {
    state[row.key] = JSON.parse(row.value_json) as unknown;
    rows += 1;
  }
  if (rows === 0) return null;
  // Numbers come back as REAL; anything that is not a finite number in a
  // numeric family was never written by this store and is dropped on read.
  const dropNonNumbers = (name: string): void => {
    const series = state[name] as NumberSeries | undefined;
    if (series === undefined) return;
    for (const [key, value] of Object.entries(series)) {
      if (readNumber(value) === null) delete series[key];
    }
  };
  for (const name of HOURLY_FAMILIES) dropNonNumbers(name);
  for (const name of DAILY_FAMILIES) dropNonNumbers(name);
  // Rows re-entering from disk are a persisted blob like any other: the same
  // shape guard the legacy settings read applies decides here, once, and a
  // state that fails it is a read failure — the caller fences rather than
  // adopting a malformed scalar or profile as truth.
  const sanitized = sanitizePowerTrackerSolarFields(state);
  if (!isPlausiblePowerTrackerState(sanitized)) {
    throw new Error(`tracker rows for ${homeId} do not reconstruct a plausible tracker state`);
  }
  return sanitized;
};

export const createTrackerStore = (db: UserdataDatabase): TrackerStore => {
  db.exec(SCHEMA);
  const s = prepareStatements(db);

  const saveHourly = (
    homeId: HomeId, family: HourlyFamily, next: NumberSeries | undefined, previous: NumberSeries | undefined,
  ): void => {
    diffRecord(next, previous, sameNumber,
      (key, value) => writeFinite(
        (finite) => s.upsertHourly.run(homeId, family, key, finite),
        () => s.deleteHourly.run(homeId, family, key),
      )(value),
      (key) => s.deleteHourly.run(homeId, family, key));
  };
  const saveDaily = (
    homeId: HomeId, family: DailyFamily, next: NumberSeries | undefined, previous: NumberSeries | undefined,
  ): void => {
    diffRecord(next, previous, sameNumber,
      (key, value) => writeFinite(
        (finite) => s.upsertDaily.run(homeId, family, key, finite),
        () => s.deleteDaily.run(homeId, family, key),
      )(value),
      (key) => s.deleteDaily.run(homeId, family, key));
  };
  const saveAverages = (
    homeId: HomeId, family: AverageFamily, next: AverageSeries | undefined, previous: AverageSeries | undefined,
  ): void => {
    diffRecord(next, previous, sameAverage,
      (key, value) => s.upsertAverage.run(homeId, family, key, value.sum, value.count),
      (key) => s.deleteAverage.run(homeId, family, key));
  };
  const saveDevices = (
    homeId: HomeId,
    next: Record<string, NumberSeries> | undefined,
    previous: Record<string, NumberSeries> | undefined,
  ): void => {
    if (next === previous) return;
    const nextRecord = next ?? EMPTY;
    const previousRecord = previous ?? EMPTY;
    for (const [deviceId, hours] of Object.entries(nextRecord)) {
      diffRecord(hours, previousRecord[deviceId], sameNumber,
        (key, value) => writeFinite(
          (finite) => s.upsertDevice.run(homeId, deviceId, key, finite),
          () => s.deleteDevice.run(homeId, deviceId, key),
        )(value),
        (key) => s.deleteDevice.run(homeId, deviceId, key));
    }
    for (const [deviceId, hours] of Object.entries(previousRecord)) {
      if (deviceId in nextRecord) continue;
      for (const key of Object.keys(hours)) s.deleteDevice.run(homeId, deviceId, key);
    }
  };
  const saveScalars = (homeId: HomeId, next: PowerTrackerState, previous: PowerTrackerState | null): void => {
    for (const key of SCALAR_KEYS) {
      const value = next[key];
      const before = previous?.[key];
      if (value === undefined) {
        if (before !== undefined) s.deleteScalar.run(homeId, key);
        continue;
      }
      const json = JSON.stringify(value);
      if (before !== undefined && JSON.stringify(before) === json) continue;
      s.upsertScalar.run(homeId, key, json);
    }
  };

  const writeDiff = (homeId: HomeId, next: PowerTrackerState, previous: PowerTrackerState | null): void => {
    for (const name of HOURLY_FAMILIES) saveHourly(homeId, name, next[name], previous?.[name]);
    for (const name of DAILY_FAMILIES) saveDaily(homeId, name, next[name], previous?.[name]);
    for (const name of AVERAGE_FAMILIES) saveAverages(homeId, name, next[name], previous?.[name]);
    saveDevices(homeId, next.deviceBuckets, previous?.deviceBuckets);
    saveScalars(homeId, next, previous);
  };
  const clearRows = (homeId: HomeId): void => {
    for (const statement of s.clearAll) statement.run(homeId);
  };

  return {
    load: (homeId) => loadState(s, homeId),
    save: (homeId, next, previous) => db.transaction(() => writeDiff(homeId, next, previous)),
    replace: (homeId, next) => db.transaction(() => {
      clearRows(homeId);
      writeDiff(homeId, next, null);
    }),
    clear: (homeId) => db.transaction(() => clearRows(homeId)),
  };
};
