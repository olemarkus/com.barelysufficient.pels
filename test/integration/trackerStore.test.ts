import { createTrackerStore } from '../../lib/power/trackerStore';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createTrackerStore(db) };
};

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
    store.save('main', state, null);
    expect(store.load('main')).toEqual(state);
    expect(store.load('cabin')).toBeNull();
  });

  // The pre-solar shape must survive a round trip byte for byte: a family
  // with no rows is absent, never `{}`.
  it('keeps absent families absent', () => {
    const { store } = open();
    store.save('main', { lastPowerW: 900, lastTimestamp: 1_000 }, null);
    expect(store.load('main')).toEqual({ lastPowerW: 900, lastTimestamp: 1_000 });
  });

  it('writes only the rows that changed since the previous state, and deletes the ones that went', () => {
    const { db, store } = open();
    const before = fullState();
    store.save('main', before, null);
    const after: PowerTrackerState = {
      ...before,
      lastPowerW: 6000,
      buckets: { '2026-09-06T11:00:00.000Z': 0.9, '2026-09-06T12:00:00.000Z': 0.1 },
      deviceBuckets: { 'dev-1': { '2026-09-06T10:00:00.000Z': 0.3, '2026-09-06T11:00:00.000Z': 0.05 } },
      generationBuckets: undefined,
    };
    const changes = db.prepare('SELECT total_changes() AS n').get() as { n: number };
    store.save('main', after, before);
    const written = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n - changes.n;
    // One scalar, two hourly upserts + one delete, one device upsert + one
    // device family removed (one row), one generation row deleted.
    expect(written).toBe(7);
    expect(store.load('main')).toEqual({ ...after, generationBuckets: undefined });
    expect(store.load('main')).not.toHaveProperty('generationBuckets');
  });

  it('an unchanged family by reference costs no rows', () => {
    const { db, store } = open();
    const before = fullState();
    store.save('main', before, null);
    const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    store.save('main', { ...before }, before);
    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n - changes).toBe(0);
  });

  it('keeps homes apart and clears one without touching the other', () => {
    const { store } = open();
    store.save('main', { lastPowerW: 1 }, null);
    store.save('cabin', { lastPowerW: 2, meterIdentity: { powerSource: 'homey_energy', meterDeviceId: 'm' } }, null);
    store.clear('main');
    expect(store.load('main')).toBeNull();
    expect(store.load('cabin')?.lastPowerW).toBe(2);
  });

  it('replace drops the old rows and writes the new state in one transaction', () => {
    const { store } = open();
    store.save('main', fullState(), null);
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
    store.save('main', { lastPowerW: 1, buckets: { good: 1, bad: Number.NaN } }, null);
    expect(store.load('main')).toEqual({ lastPowerW: 1, buckets: { good: 1 } });
  });

  // A row that came from disk is a persisted blob like any other and gets the
  // legacy read's shape guard: a malformed scalar makes the load a failure the
  // controller fences on, never a state the planner trusts.
  it('refuses to reconstruct a state whose rows fail the tracker shape guard', () => {
    const { db, store } = open();
    store.save('main', { lastPowerW: 1, lastTimestamp: 2 }, null);
    db.prepare('UPDATE power_tracker_scalars SET value_json = ? WHERE home_id = ? AND key = ?').run('"not a number"', 'main', 'lastPowerW');
    expect(() => store.load('main')).toThrow(/plausible/);
  });

  it('a save that throws inside the transaction leaves the previous rows intact', () => {
    const { store } = open();
    const before = fullState();
    store.save('main', before, null);
    // An average's NaN sum has no absence to map to, so it is the NOT NULL
    // constraint that refuses it — and the whole transaction with it.
    const poison: PowerTrackerState = { ...before, lastPowerW: 7, hourlyAverages: { bad: { sum: Number.NaN, count: 1 } } };
    expect(() => store.save('main', poison, before)).toThrow();
    expect(store.load('main')).toEqual(before);
  });
});
