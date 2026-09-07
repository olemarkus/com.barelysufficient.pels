import { createTrackerStore } from '../../lib/power/trackerStore';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createTrackerStore(db) };
};

const TABLES = [
  'power_tracker_hourly', 'power_tracker_daily', 'power_tracker_averages',
  'power_tracker_device_hourly', 'power_tracker_scalars',
] as const;

/** Row counts per table for one home — what a write actually touched on disk. */
const rowsFor = (db: ReturnType<typeof open>['db'], homeId: string): Record<(typeof TABLES)[number], number> => (
  Object.fromEntries(TABLES.map((table) => [
    table,
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE home_id = ?`).get(homeId) as { n: number }).n,
  ])) as Record<(typeof TABLES)[number], number>
);

const totalChanges = (db: ReturnType<typeof open>['db']): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

// A state of the shape production persists: every family populated.
const fullState = (): PowerTrackerState => ({
  meterIdentity: { powerSource: 'homey_energy', meterDeviceId: 'meter-a' },
  lastPowerW: 5603,
  lastControlledPowerW: 0,
  lastUncontrolledPowerW: 5603,
  lastExemptPowerW: 0,
  lastGenerationW: 120.5,
  lastTimestamp: 1_788_723_806_557,
  buckets: { '2026-09-06T10:00:00.000Z': 1.25, '2026-09-06T11:00:00.000Z': 0.75 },
  hourlySampleCounts: { '2026-09-06T10:00:00.000Z': 360, '2026-09-06T11:00:00.000Z': 12 },
  hourlyBudgets: { '2026-09-06T10:00:00.000Z': 2.5 },
  dailyBudgetCaps: { '2026-09-06T10:00:00.000Z': 3 },
  dailyTotals: { '2026-09-05': 18.5, '2026-09-06': 2 },
  hourlyAverages: { 'mon-10': { sum: 12.5, count: 10 } },
  controlledBuckets: { '2026-09-06T10:00:00.000Z': 0.5 },
  uncontrolledBuckets: { '2026-09-06T10:00:00.000Z': 0.75 },
  exemptBuckets: { '2026-09-06T10:00:00.000Z': 0 },
  controlledDailyTotals: { '2026-09-06': 0.5 },
  uncontrolledDailyTotals: { '2026-09-06': 1.5 },
  exemptDailyTotals: { '2026-09-06': 0 },
  controlledHourlyAverages: { 'mon-10': { sum: 5, count: 10 } },
  uncontrolledHourlyAverages: { 'mon-10': { sum: 7.5, count: 10 } },
  exemptHourlyAverages: { 'mon-10': { sum: 0, count: 10 } },
  deviceBuckets: { 'dev-1': { '2026-09-06T10:00:00.000Z': 0.3 }, 'dev-2': { '2026-09-06T10:00:00.000Z': 0.2 } },
  lastDevicePowerWById: { 'dev-1': 300, 'dev-2': 200 },
  generationBuckets: { '2026-09-06T10:00:00.000Z': 0.4 },
  exportBuckets: { '2026-09-06T10:00:00.000Z': 0.1 },
  generationDailyTotals: { '2026-09-06': 0.4 },
  exportDailyTotals: { '2026-09-06': 0.1 },
  unreliablePeriods: [{ start: 1, end: 2 }],
  objectiveProfiles: {},
});

describe('trackerStore', () => {
  it('round-trips every family of a full state, and answers null for a home it has no rows for', () => {
    const { store } = open();
    expect(store.load('main')).toBeNull();
    const state = fullState();
    store.save('main', state);
    expect(store.load('main')).toEqual(state);
    expect(store.load('cabin')).toBeNull();
  });

  // The pre-solar shape must survive a round trip byte for byte: a family
  // with no rows is absent, never `{}`.
  it('keeps absent families absent', () => {
    const { store } = open();
    store.save('main', { lastPowerW: 900, lastTimestamp: 1_000 });
    expect(store.load('main')).toEqual({ lastPowerW: 900, lastTimestamp: 1_000 });
  });

  // The store holds what it last wrote or loaded per home and diffs the next
  // save against that: the caller hands over the whole state and pays for
  // the rows that changed.
  it('writes only the rows that changed since what it holds, and deletes the ones that went', () => {
    const { db, store } = open();
    const before = fullState();
    store.save('main', before);
    const after: PowerTrackerState = {
      ...before,
      lastPowerW: 6000,
      buckets: { '2026-09-06T11:00:00.000Z': 0.9, '2026-09-06T12:00:00.000Z': 0.1 },
      deviceBuckets: { 'dev-1': { '2026-09-06T10:00:00.000Z': 0.3, '2026-09-06T11:00:00.000Z': 0.05 } },
      generationBuckets: undefined,
    };
    const rowsBefore = rowsFor(db, 'main');
    const changes = totalChanges(db);
    store.save('main', after);
    // One scalar, two hourly upserts + one delete, one device upsert + one
    // device family removed (one row), one generation row deleted.
    expect(totalChanges(db) - changes).toBe(7);
    expect(rowsFor(db, 'main')).toEqual({
      ...rowsBefore,
      // buckets: 2 → 2; generationBuckets: 1 → 0.
      power_tracker_hourly: rowsBefore.power_tracker_hourly - 1,
      // dev-1 gains one hour, dev-2 goes.
      power_tracker_device_hourly: rowsBefore.power_tracker_device_hourly,
    });
    expect(store.load('main')).toEqual({ ...after, generationBuckets: undefined });
    expect(store.load('main')).not.toHaveProperty('generationBuckets');
  });

  it('an unchanged family by reference costs no rows', () => {
    const { db, store } = open();
    const before = fullState();
    store.save('main', before);
    const changes = totalChanges(db);
    store.save('main', { ...before });
    expect(totalChanges(db) - changes).toBe(0);
  });

  // A fresh store (a boot) learns its diff base from the rows it loads — or,
  // for a home it has never read, from the rows on disk at the first save —
  // so a save always deletes what the caller dropped and no caller has to
  // load before it saves.
  it('diffs the first save against the rows on disk, loaded or not', () => {
    const { db, store } = open();
    store.save('main', { lastPowerW: 1, buckets: { stale: 1, fresh: 2 } });
    const reopened = createTrackerStore(db);
    const loaded = reopened.load('main');
    reopened.save('main', { ...loaded, buckets: { fresh: 2 } });
    expect(reopened.load('main')).toEqual({ lastPowerW: 1, buckets: { fresh: 2 } });
    const blind = createTrackerStore(db);
    blind.save('main', { lastPowerW: 2 });
    expect(blind.load('main')).toEqual({ lastPowerW: 2 });
  });

  it('keeps homes apart', () => {
    const { store } = open();
    store.save('main', { lastPowerW: 1 });
    store.save('cabin', { lastPowerW: 2, meterIdentity: { powerSource: 'homey_energy', meterDeviceId: 'm' } });
    store.replace('main', {});
    expect(store.load('main')).toBeNull();
    expect(store.load('cabin')?.lastPowerW).toBe(2);
  });

  it('replace drops the old rows and writes the new state in one transaction', () => {
    const { store } = open();
    store.save('main', fullState());
    store.replace('main', { lastPowerW: 1, buckets: { only: 2 } });
    expect(store.load('main')).toEqual({ lastPowerW: 1, buckets: { only: 2 } });
    // A replacement that fails mid-way leaves the previous rows untouched.
    expect(() => store.replace('main', { lastPowerW: 5, buckets: { bad: Number.NaN, ok: 1 }, dailyTotals: { d: 1 }, hourlyAverages: { s: { sum: Number.NaN, count: 1 } } })).toThrow();
    expect(store.load('main')).toEqual({ lastPowerW: 1, buckets: { only: 2 } });
  });

  // A NaN bucket is dropped rather than wedging every later persist for the
  // home; the transaction still refuses a NaN it cannot express as absence.
  it('skips a non-finite bucket value on write instead of failing the persist', () => {
    const { store } = open();
    store.save('main', { lastPowerW: 1, buckets: { good: 1, bad: Number.NaN } });
    expect(store.load('main')).toEqual({ lastPowerW: 1, buckets: { good: 1 } });
  });

  // Rows re-entering from disk are a persisted blob like any other and get
  // the shape guard. Everything here is regenerable by ruling, so rows that
  // fail it are the store's own damage: set aside at the narrowest grain that
  // leaves a plausible state, so one bad scalar never costs a month of
  // buckets, and the store answers rather than throwing on every boot.
  it('quarantines the one scalar row that fails the shape guard and keeps the families', () => {
    const { db, store } = open();
    store.save('main', { lastPowerW: 1, lastTimestamp: 2, buckets: { h: 1 }, dailyTotals: { d: 3 } });
    store.save('cabin', { lastPowerW: 3 });
    db.prepare('UPDATE power_tracker_scalars SET value_json = ? WHERE home_id = ? AND key = ?').run('"not a number"', 'main', 'lastPowerW');
    expect(store.load('main')).toEqual({ lastTimestamp: 2, buckets: { h: 1 }, dailyTotals: { d: 3 } });
    expect(rowsFor(db, 'main').power_tracker_scalars).toBe(1);
    expect(store.load('cabin')).toEqual({ lastPowerW: 3 });
  });

  it('quarantines a scalar row that does not even parse', () => {
    const { db, store } = open();
    store.save('main', { lastPowerW: 1, lastTimestamp: 2, buckets: { h: 1 } });
    db.prepare('UPDATE power_tracker_scalars SET value_json = ? WHERE home_id = ? AND key = ?').run('{not json', 'main', 'lastTimestamp');
    expect(store.load('main')).toEqual({ lastPowerW: 1, buckets: { h: 1 } });
    expect(store.load('main')).toEqual({ lastPowerW: 1, buckets: { h: 1 } });
  });

  it('quarantines the whole home only when no scalar cut leaves a plausible state', () => {
    const { db, store } = open();
    store.save('main', { lastPowerW: 1, buckets: { h: 1 } });
    // A family row this store could never have written: a non-numeric hourly
    // value is refused by the schema, so the closest thing is a foreign
    // scalar shape on a key the guard checks alongside an unrelated one.
    db.prepare('UPDATE power_tracker_scalars SET value_json = ? WHERE home_id = ? AND key = ?').run('"x"', 'main', 'lastPowerW');
    db.prepare('INSERT INTO power_tracker_scalars (home_id, key, value_json) VALUES (?, ?, ?)').run('main', 'lastTimestamp', '"y"');
    // Two bad scalars: dropping one is not enough, dropping all scalars is.
    expect(store.load('main')).toEqual({ buckets: { h: 1 } });
    expect(rowsFor(db, 'main')).toEqual({
      power_tracker_hourly: 1, power_tracker_daily: 0, power_tracker_averages: 0,
      power_tracker_device_hourly: 0, power_tracker_scalars: 0,
    });
    // What survived is the diff base: a save that carries no buckets drops
    // the kept row, as it would any bucket the caller no longer has.
    store.save('main', { lastPowerW: 5 });
    expect(store.load('main')).toEqual({ lastPowerW: 5 });
  });

  // A series or scalar this store never writes — a row from a build that
  // knew a family this one does not — is left where it is and not read.
  it('reads back only the series it writes', () => {
    const { db, store } = open();
    store.save('main', { lastPowerW: 1 });
    db.prepare('INSERT INTO power_tracker_hourly (home_id, series, hour_key, value) VALUES (?, ?, ?, ?)').run('main', 'futureBuckets', 'h', 1);
    db.prepare('INSERT INTO power_tracker_scalars (home_id, key, value_json) VALUES (?, ?, ?)').run('main', 'futureScalar', '1');
    expect(store.load('main')).toEqual({ lastPowerW: 1 });
  });

  it('a save that throws inside the transaction leaves the previous rows intact', () => {
    const { store } = open();
    const before = fullState();
    store.save('main', before);
    // An average's NaN sum has no absence to map to, so it is the NOT NULL
    // constraint that refuses it — and the whole transaction with it.
    const poison: PowerTrackerState = { ...before, lastPowerW: 7, hourlyAverages: { bad: { sum: Number.NaN, count: 1 } } };
    expect(() => store.save('main', poison)).toThrow();
    expect(store.load('main')).toEqual(before);
    // The failed save did not become the diff base: the retry writes the
    // change the poisoned save carried.
    store.save('main', { ...before, lastPowerW: 7 });
    expect(store.load('main')?.lastPowerW).toBe(7);
  });
});
