/**
 * The power tracker's rows in the userdata database.
 *
 * Ownership: the only module that knows how a `PowerTrackerState` is laid out
 * on disk, and the only writer of its tables. The in-memory model is unchanged
 * — `tracker.ts`, ingest and every consumer still hold one state object per
 * home — and this store is the seam `homeTrackerPersistence.ts` writes
 * through instead of `homey.settings`.
 *
 * The layout is one row per (series, key) rather than one JSON blob, because
 * the blob is what made persistence expensive: 663 kB re-serialised on every
 * write for a change of a few hundred bytes. `save` diffs the new state
 * against what the store holds for the home — what it last wrote or loaded,
 * read from disk first when it has done neither — and touches only the rows
 * that changed, in one transaction. Callers hand over the whole state and
 * never learn an ordering.
 *
 * `load` is total. Rows that do not reconstruct a plausible state are the
 * store's own failure to answer for: everything here is regenerable by ruling,
 * so the offending rows are quarantined (deleted, logged once) at the finest
 * grain that restores a plausible state — one scalar row, the home's scalar
 * rows, or, last, every row the home has. A throw out of this module means
 * SQLite I/O failed, nothing else.
 *
 * A family that has no rows comes back ABSENT, never as `{}`. The solar
 * families are sparse by contract — a non-solar home's state stays deep-equal
 * with the pre-solar shape — and the same rule kept for every family means a
 * round trip through the store is the identity.
 */
import type { PreparedStatement, UserdataDatabase } from '../store/userdataDatabase';
import { getLogger } from '../logging/logger';
import type { HomeId } from '../utils/settingsKeys';
import type { PowerTrackerState } from './trackerTypes';
import { isPlausiblePowerTrackerState, sanitizePowerTrackerSolarFields } from '../utils/appTypeGuards';

const storeLogger = getLogger('power/tracker-store');

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
] as const satisfies readonly (keyof PowerTrackerState)[];

/** Families keyed by local calendar date: `Record<dateKey, number>`. */
const DAILY_FAMILIES = [
  'dailyTotals',
  'controlledDailyTotals',
  'uncontrolledDailyTotals',
  'exemptDailyTotals',
  'generationDailyTotals',
  'exportDailyTotals',
] as const satisfies readonly (keyof PowerTrackerState)[];

/** Families of running averages: `Record<slotKey, { sum, count }>`. */
const AVERAGE_FAMILIES = [
  'hourlyAverages',
  'controlledHourlyAverages',
  'uncontrolledHourlyAverages',
  'exemptHourlyAverages',
] as const satisfies readonly (keyof PowerTrackerState)[];

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
] as const satisfies readonly (keyof PowerTrackerState)[];

/** The one family with its own table: `Record<deviceId, Record<hourKey, number>>`. */
const DEVICE_FAMILY = 'deviceBuckets' satisfies keyof PowerTrackerState;

type HourlyFamily = (typeof HOURLY_FAMILIES)[number];
type DailyFamily = (typeof DAILY_FAMILIES)[number];
type AverageFamily = (typeof AVERAGE_FAMILIES)[number];
type CoveredKey =
  | HourlyFamily | DailyFamily | AverageFamily | (typeof SCALAR_KEYS)[number] | typeof DEVICE_FAMILY;

/**
 * Every key of the tracker type has a home in one of the lists above. A new
 * field on `PowerTrackerState` fails to compile here until it is placed, so it
 * can never be silently dropped on the way to disk.
 */
type UncoveredKey = Exclude<keyof PowerTrackerState, CoveredKey>;
const EVERY_KEY_IS_COVERED: UncoveredKey extends never ? true : never = true;
void EVERY_KEY_IS_COVERED;

const HOURLY_FAMILY_SET: ReadonlySet<string> = new Set(HOURLY_FAMILIES);
const DAILY_FAMILY_SET: ReadonlySet<string> = new Set(DAILY_FAMILIES);
const AVERAGE_FAMILY_SET: ReadonlySet<string> = new Set(AVERAGE_FAMILIES);
const SCALAR_KEY_SET: ReadonlySet<string> = new Set(SCALAR_KEYS);

export type TrackerStore = {
  /**
   * The home's state as stored; `null` when the store holds no rows for it —
   * including after its rows were quarantined for not reconstructing a
   * plausible state. Throws only when SQLite I/O fails.
   */
  load(homeId: HomeId): PowerTrackerState | null;
  /**
   * Write `next`, touching only the rows that differ from what the store
   * holds for the home. `next` is kept by reference as the base of the next
   * diff, which holds because every writer replaces a family rather than
   * mutating it in place (`diffRecord`); a state handed here is not edited
   * afterwards.
   */
  save(homeId: HomeId, next: PowerTrackerState): void;
  /** Drop every row the home has and write `next` whole, in one transaction. */
  replace(homeId: HomeId, next: PowerTrackerState): void;
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
const sameAverage = (a: { sum: number; count: number }, b: { sum: number; count: number }): boolean => (
  a.sum === b.sum && a.count === b.count
);

/**
 * A REAL column stores a bound NaN as NULL, which the NOT NULL constraint then
 * refuses — and one such value would fail every persist for the home until
 * the bucket aged out. Ingest gates finiteness upstream; this is the store's
 * own guarantee that one bad number costs one row, never a month of history.
 */
const numberRowWriter = (
  upsert: (key: string, value: number) => void,
  remove: (key: string) => void,
) => (key: string, value: number): void => {
  if (Number.isFinite(value)) upsert(key, value);
  else remove(key);
};

/** The home's rows, and the scalar keys whose row could not even be parsed. */
type LoadedRows = { state: Record<string, unknown>; rows: number; unparseable: string[] };

const parseScalar = (json: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch {
    return { ok: false };
  }
};

const loadRows = (s: Statements, homeId: HomeId): LoadedRows => {
  const state: Record<string, unknown> = {};
  let rows = 0;
  const family = <V>(name: string): Record<string, V> => {
    const existing = state[name];
    if (existing !== undefined) return existing as Record<string, V>;
    const created: Record<string, V> = {};
    state[name] = created;
    return created;
  };
  // Only series this store writes are read back: an unknown series name is a
  // row nothing here can answer for and is left where it is.
  type NumberRow = { series: string; key: string; value: number };
  const numberRows: Array<[PreparedStatement, ReadonlySet<string>]> = [
    [s.loadHourly, HOURLY_FAMILY_SET], [s.loadDaily, DAILY_FAMILY_SET],
  ];
  for (const [statement, families] of numberRows) {
    for (const row of statement.all(homeId) as NumberRow[]) {
      if (!families.has(row.series)) continue;
      family<number>(row.series)[row.key] = row.value;
      rows += 1;
    }
  }
  type AverageRow = { series: string; key: string; sum: number; count: number };
  for (const row of s.loadAverages.all(homeId) as AverageRow[]) {
    if (!AVERAGE_FAMILY_SET.has(row.series)) continue;
    family<{ sum: number; count: number }>(row.series)[row.key] = { sum: row.sum, count: row.count };
    rows += 1;
  }
  type DeviceRow = { device_id: string; hour_key: string; value: number };
  for (const row of s.loadDevices.all(homeId) as DeviceRow[]) {
    const devices = family<NumberSeries>(DEVICE_FAMILY);
    (devices[row.device_id] ??= {})[row.hour_key] = row.value;
    rows += 1;
  }
  const scalars = loadScalarRows(s, homeId);
  return { state: { ...state, ...scalars.values }, rows: rows + scalars.rows, unparseable: scalars.unparseable };
};

/** The home's scalar rows: the parsed values, and the keys whose row did not parse. */
const loadScalarRows = (s: Statements, homeId: HomeId) => {
  const values: Record<string, unknown> = {};
  const unparseable: string[] = [];
  let rows = 0;
  type ScalarRow = { key: string; value_json: string };
  for (const row of s.loadScalars.all(homeId) as ScalarRow[]) {
    if (!SCALAR_KEY_SET.has(row.key)) continue;
    rows += 1;
    const parsed = parseScalar(row.value_json);
    if (parsed.ok) values[row.key] = parsed.value;
    else unparseable.push(row.key);
  }
  return { values, rows, unparseable };
};

const without = (state: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => (
  Object.fromEntries(Object.entries(state).filter(([key]) => !keys.includes(key)))
);

type Quarantine =
  | { scope: 'scalar_rows'; keys: string[]; state: PowerTrackerState }
  | { scope: 'home' };

/**
 * The narrowest cut that leaves a plausible state. The number families
 * cannot hold a non-finite value (REAL NOT NULL), so an implausible state is
 * a scalar's doing: a row that did not parse, one whose value the guard
 * refuses, or, failing both, the home's scalar rows together. Only a state
 * that is implausible even without any scalar loses its families.
 */
const planQuarantine = (loaded: LoadedRows): Quarantine | null => {
  const plausible = (candidate: Record<string, unknown>): PowerTrackerState | null => {
    const sanitized = sanitizePowerTrackerSolarFields(candidate);
    return isPlausiblePowerTrackerState(sanitized) ? sanitized : null;
  };
  const dropped = [...loaded.unparseable];
  const base = without(loaded.state, dropped);
  const asIs = plausible(base);
  if (asIs !== null) return dropped.length === 0 ? null : { scope: 'scalar_rows', keys: dropped, state: asIs };
  for (const key of SCALAR_KEYS) {
    if (!(key in base)) continue;
    const state = plausible(without(base, [key]));
    if (state !== null) return { scope: 'scalar_rows', keys: dropped.concat(key), state };
  }
  const familiesOnly = plausible(without(base, SCALAR_KEYS));
  if (familiesOnly !== null) {
    const keys = SCALAR_KEYS.filter((key) => key in base || dropped.includes(key));
    return { scope: 'scalar_rows', keys, state: familiesOnly };
  }
  return { scope: 'home' };
};

/**
 * Read one home's rows into a state, quarantining what fails the shape guard
 * (deleted, said once at error); runs inside a transaction.
 */
const readHome = (s: Statements, clearRows: (homeId: HomeId) => void, homeId: HomeId): PowerTrackerState | null => {
  const loaded = loadRows(s, homeId);
  if (loaded.rows === 0) return null;
  // Rows re-entering from disk are a persisted blob like any other and get
  // the one shape guard at this boundary. Rows that fail it are the store's
  // own damage to absorb: regenerable by ruling, so they are set aside at
  // the narrowest grain that leaves a plausible state.
  const quarantine = planQuarantine(loaded);
  if (quarantine === null) return sanitizePowerTrackerSolarFields(loaded.state) as PowerTrackerState;
  if (quarantine.scope === 'home') {
    storeLogger.error({ event: 'power_tracker_rows_quarantined', homeId, scope: 'home', rows: loaded.rows });
    clearRows(homeId);
    return null;
  }
  storeLogger.error({
    event: 'power_tracker_rows_quarantined', homeId, scope: 'scalar_rows', keys: quarantine.keys,
  });
  for (const key of quarantine.keys) s.deleteScalar.run(homeId, key);
  return quarantine.state;
};

export const createTrackerStore = (db: UserdataDatabase): TrackerStore => {
  db.exec(SCHEMA);
  const s = prepareStatements(db);
  /** What the store holds per home — the diff base of the next save. */
  const lastKnown = new Map<HomeId, PowerTrackerState>();

  const saveHourly = (homeId: HomeId, family: HourlyFamily, next?: NumberSeries, previous?: NumberSeries): void => {
    diffRecord(next, previous, sameNumber,
      numberRowWriter(
        (key, value) => s.upsertHourly.run(homeId, family, key, value),
        (key) => s.deleteHourly.run(homeId, family, key),
      ),
      (key) => s.deleteHourly.run(homeId, family, key));
  };
  const saveDaily = (homeId: HomeId, family: DailyFamily, next?: NumberSeries, previous?: NumberSeries): void => {
    diffRecord(next, previous, sameNumber,
      numberRowWriter(
        (key, value) => s.upsertDaily.run(homeId, family, key, value),
        (key) => s.deleteDaily.run(homeId, family, key),
      ),
      (key) => s.deleteDaily.run(homeId, family, key));
  };
  const saveAverages = (
    homeId: HomeId, family: AverageFamily, next?: AverageSeries, previous?: AverageSeries,
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
        numberRowWriter(
          (key, value) => s.upsertDevice.run(homeId, deviceId, key, value),
          (key) => s.deleteDevice.run(homeId, deviceId, key),
        ),
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
      // Same reference, same bytes: the identity shortcut the families get.
      if (value === before) continue;
      if (value === undefined) {
        s.deleteScalar.run(homeId, key);
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
    saveDevices(homeId, next[DEVICE_FAMILY], previous?.[DEVICE_FAMILY]);
    saveScalars(homeId, next, previous);
  };
  const clearRows = (homeId: HomeId): void => {
    for (const statement of s.clearAll) statement.run(homeId);
  };

  /** Read the home's rows and make them the diff base; runs inside a transaction. */
  const read = (homeId: HomeId): PowerTrackerState | null => {
    const state = readHome(s, clearRows, homeId);
    if (state === null) lastKnown.delete(homeId);
    else lastKnown.set(homeId, state);
    return state;
  };

  return {
    load: (homeId) => db.transaction(() => read(homeId)),
    save: (homeId, next) => {
      db.transaction(() => {
        // A home this store has neither loaded nor written is diffed against
        // its rows on disk, so a save can always delete what `next` dropped.
        const previous = lastKnown.has(homeId) ? lastKnown.get(homeId) ?? null : read(homeId);
        writeDiff(homeId, next, previous);
      });
      lastKnown.set(homeId, next);
    },
    replace: (homeId, next) => {
      db.transaction(() => {
        clearRows(homeId);
        writeDiff(homeId, next, null);
      });
      lastKnown.set(homeId, next);
    },
  };
};
