import { createPlanHistoryStore, importLegacyPlanHistory } from '../../lib/objectives/deferredObjectives/planHistoryStore';
import { normalizeDeferredObjectivePlanHistory } from '../../lib/objectives/deferredObjectives/planHistorySettings';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import {
  DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED,
  DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING,
  DEFERRED_OBJECTIVE_PLAN_HISTORY_V4_SETTING,
} from '../../lib/utils/settingsKeys';
import type { DeferredObjectivePlanHistoryEntry } from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { MockSettings } from '../mocks/homey';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createPlanHistoryStore(db) };
};

const entry = (id: string, finalizedAtMs: number): DeferredObjectivePlanHistoryEntry => ({
  id,
  deviceId: 'dev',
  deviceName: 'Water Heater',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: finalizedAtMs,
  startedAtMs: finalizedAtMs - 3_600_000,
  finalizedAtMs,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 22.5,
  outcome: 'met',
  metAtMs: finalizedAtMs - 1,
  usedDeadlineReserve: false,
  observedIntervals: [{ fromMs: finalizedAtMs - 3_600_000, toMs: finalizedAtMs }],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
});

/** A v5 snapshot of the given entries, as the recorder would hand it in. */
const v5 = (...entries: DeferredObjectivePlanHistoryEntry[]) => normalizeDeferredObjectivePlanHistory({ version: 5, entries });

const totalChanges = (db: ReturnType<typeof open>['db']): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

describe('planHistoryStore', () => {
  it('answers null while empty, and round-trips a history one row per entry, oldest first', () => {
    const { db, store } = open();
    expect(store.read()).toBeNull();
    const history = v5(entry('b', 2_000), entry('a', 1_000));
    store.write(history);
    expect(store.read()).toEqual({ version: 5, entries: [history.entries[1], history.entries[0]] });
    expect((db.prepare('SELECT COUNT(*) AS n FROM deferred_objective_plan_history').get() as { n: number }).n).toBe(2);
  });

  // The point of the move: finalizing a run writes that run and the one the
  // cap retired, not the other twenty-nine.
  it('writes only the rows that changed, and deletes the ones that went', () => {
    const { db, store } = open();
    store.write(v5(entry('a', 1_000), entry('b', 2_000)));
    const changes = totalChanges(db);
    store.write(v5(entry('b', 2_000), entry('c', 3_000)));
    expect(totalChanges(db) - changes).toBe(2);
    expect(store.read()?.entries.map((e) => e.id)).toEqual(['b', 'c']);
    store.write(v5(entry('b', 2_000), entry('c', 3_000)));
    expect(totalChanges(db) - changes).toBe(2);
  });

  it('diffs the first write of a fresh store against the rows on disk', () => {
    const { db, store } = open();
    store.write(v5(entry('a', 1_000), entry('b', 2_000)));
    const blind = createPlanHistoryStore(db);
    blind.write(v5(entry('b', 2_000)));
    expect(blind.read()?.entries.map((e) => e.id)).toEqual(['b']);
  });

  // Rows re-entering from disk pass the recorder's strict parser; one that
  // does not parse, or fails it, is quarantined — deleted, not lingering to
  // be re-logged every boot — and never costs the rows around it.
  it('quarantines a row that does not parse or fails the strict parser, and keeps the rest', () => {
    const { db, store } = open();
    store.write(v5(entry('a', 1_000), entry('b', 2_000), entry('c', 3_000)));
    db.prepare('UPDATE deferred_objective_plan_history SET entry_json = ? WHERE id = ?').run('{not json', 'a');
    db.prepare('UPDATE deferred_objective_plan_history SET entry_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...entry('c', 3_000), finalizedAtMs: 'soon' }), 'c');
    expect(store.read()?.entries.map((e) => e.id)).toEqual(['b']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM deferred_objective_plan_history').get() as { n: number }).n).toBe(1);
  });

  // A row whose key columns disagree with its own entry is not the entry the
  // store wrote: quarantined like a malformed one.
  it('quarantines a row whose id or finalisation disagrees with its entry', () => {
    const { db, store } = open();
    store.write(v5(entry('a', 1_000), entry('b', 2_000), entry('c', 3_000)));
    db.prepare('UPDATE deferred_objective_plan_history SET entry_json = ? WHERE id = ?').run(JSON.stringify(entry('zz', 1_000)), 'a');
    db.prepare('UPDATE deferred_objective_plan_history SET finalized_at_ms = ? WHERE id = ?').run(9_000, 'c');
    expect(store.read()?.entries.map((e) => e.id)).toEqual(['b']);
  });
});

describe('importLegacyPlanHistory', () => {
  const rig = () => {
    const settings = new MockSettings();
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports the v5 key, then the rollback v4 key under it, and retires both with the marker', () => {
    const { settings, store } = rig();
    settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING, { version: 5, entries: [entry('a', 1_000), entry('b', 2_000)] });
    settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_V4_SETTING, { version: 4, entries: [entry('a', 1_000), entry('rollback', 500)] });
    settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED, true);
    importLegacyPlanHistory(settings, store);
    expect(store.read()?.entries.map((e) => e.id)).toEqual(['rollback', 'a', 'b']);
    expect(settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING)).toBeNull();
    expect(settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_V4_SETTING)).toBeNull();
    expect(settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED)).toBeNull();
    // A second boot has nothing left to do, and reads nothing: an install
    // that has imported (or never had the keys) is not a deferral every boot.
    const get = vi.spyOn(settings, 'get');
    importLegacyPlanHistory(settings, store);
    expect(get).not.toHaveBeenCalled();
    expect(store.read()?.entries).toHaveLength(3);
  });

  // The strict parser refuses a whole envelope for one bad entry, which is
  // right for the recorder and wrong for an upgrade: 165 kB would stay in
  // settings forever. The import drops the entries the normaliser refuses.
  it('salvages a blob with a bad entry, dropping only that entry', () => {
    const { settings, store } = rig();
    settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_V4_SETTING, {
      version: 4, entries: [entry('a', 1_000), { ...entry('bad', 2_000), finalizedAtMs: 'soon' }, entry('c', 3_000)],
    });
    importLegacyPlanHistory(settings, store);
    expect(store.read()?.entries.map((e) => e.id)).toEqual(['a', 'c']);
    expect(settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_V4_SETTING)).toBeNull();
  });

  it('keeps the recorder\'s rolling cap after merging both keys: the newest entries survive', () => {
    const { settings, store } = rig();
    const stored = Array.from({ length: 30 }, (_, i) => entry(`s${i}`, 100_000 + i * 1_000));
    store.write(v5(...stored));
    settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_V4_SETTING, {
      version: 4, entries: [entry('old', 1_000), entry('newest', 999_000)],
    });
    importLegacyPlanHistory(settings, store);
    const ids = store.read()?.entries.map((e) => e.id) ?? [];
    expect(ids).toHaveLength(30);
    expect(ids).not.toContain('old');
    expect(ids).not.toContain('s0');
    expect(ids[ids.length - 1]).toBe('newest');
  });

  // A boot whose import deferred still lets the recorder persist finalized
  // runs; the next boot's import keeps both, the store's entries winning.
  it('imports the blob under what the store already holds', () => {
    const { settings, store } = rig();
    const newer = { ...entry('a', 1_000), outcome: 'missed' as const };
    store.write(v5(newer, entry('c', 3_000)));
    settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING, { version: 5, entries: [entry('a', 1_000), entry('b', 2_000)] });
    importLegacyPlanHistory(settings, store);
    const merged = store.read()?.entries ?? [];
    expect(merged.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(merged[0]?.outcome).toBe('missed');
  });

  // One transient must never cost the history: a suspect read, a value with
  // no history envelope in it, or a store that cannot answer leaves the keys
  // and the marker where they are for the next boot.
  it('defers on a suspect read, a value with no history in it, or a store that cannot answer', () => {
    const { settings, store } = rig();
    settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING, 'garbage');
    settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED, true);
    importLegacyPlanHistory(settings, store);
    expect(store.read()).toBeNull();
    expect(settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING)).toBe('garbage');
    expect(settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED)).toBe(true);
    settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING, { version: 5, entries: [entry('a', 1_000)] });
    const write = vi.spyOn(store, 'write').mockImplementation(() => { throw new Error('disk full'); });
    importLegacyPlanHistory(settings, store);
    expect(store.read()).toBeNull();
    write.mockRestore();
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING ? undefined : originalGet(key)));
    importLegacyPlanHistory(settings, store);
    get.mockRestore();
    expect(store.read()).toBeNull();
    expect(originalGet(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING)).toEqual({ version: 5, entries: [entry('a', 1_000)] });
    importLegacyPlanHistory(settings, store);
    expect(store.read()?.entries.map((e) => e.id)).toEqual(['a']);
    expect(settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING)).toBeNull();
    expect(settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED)).toBeNull();
  });
});
