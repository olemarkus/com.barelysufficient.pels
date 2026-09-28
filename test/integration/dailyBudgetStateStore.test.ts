import {
  createDailyBudgetStateStore,
  importLegacyDailyBudgetState,
} from '../../lib/dailyBudget/dailyBudgetStateStore';
import type { DailyBudgetState } from '../../lib/dailyBudget/dailyBudgetTypes';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { DAILY_BUDGET_STATE } from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createDailyBudgetStateStore(db) };
};

const totalChanges = (db: ReturnType<typeof open>['db']): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

const hourly = (value: number): number[] => Array.from({ length: 24 }, () => value);

const TODAY_PLAN: DailyBudgetState = {
  dateKey: '2026-09-28',
  dayStartUtcMs: Date.UTC(2026, 8, 27, 22),
  plannedKWh: hourly(1),
  frozen: false,
  lastUsedNowKWh: 3.5,
};

const learned = (days: number, weight: number): DailyBudgetState => ({
  profileUncontrolled: { weights: hourly(weight), sampleCount: days },
  profileControlled: { weights: hourly(weight), sampleCount: days },
  profileControlledShare: 0.4,
  profileSampleCount: days,
  profileSplitSampleCount: days,
  profileObservedP50UncontrolledKWh: hourly(weight),
});

describe('dailyBudgetStateStore', () => {
  it('answers null while empty and round-trips the state', () => {
    const { store } = open();
    expect(store.read()).toBeNull();
    const state = { ...TODAY_PLAN, ...learned(12, 1 / 24) };
    store.write(state);
    expect(store.read()).toEqual(state);
  });

  it('rewrites only the fields that changed, and deletes one the state dropped', () => {
    const { db, store } = open();
    store.write({ ...TODAY_PLAN, ...learned(12, 1 / 24) });
    const changes = totalChanges(db);
    store.write({ ...TODAY_PLAN, ...learned(12, 1 / 24), lastUsedNowKWh: 4 });
    expect(totalChanges(db)).toBe(changes + 1);

    const { frozen: _frozen, ...withoutFrozen } = { ...TODAY_PLAN, ...learned(12, 1 / 24), lastUsedNowKWh: 4 };
    store.write(withoutFrozen);
    expect(createDailyBudgetStateStore(db).read()).toEqual(withoutFrozen);
  });

  it('deletes a row that does not parse, and keeps the rest', () => {
    const { db, store } = open();
    store.write(TODAY_PLAN);
    db.prepare("UPDATE daily_budget_state_fields SET value_json = '{' WHERE key = 'plannedKWh'").run();
    const { plannedKWh: _plannedKWh, ...rest } = TODAY_PLAN;
    expect(createDailyBudgetStateStore(db).read()).toEqual(rest);
    expect(createDailyBudgetStateStore(db).read()).toEqual(rest);
  });

  it('reads rows that parse but make no daily-budget state as null, and the next write replaces them', () => {
    const { db, store } = open();
    store.write({ ...TODAY_PLAN, ...learned(12, 1 / 24) });
    db.prepare("UPDATE daily_budget_state_fields SET value_json = '\"junk\"' WHERE key = 'profileControlled'").run();
    const reopened = createDailyBudgetStateStore(db);
    expect(reopened.read()).toBeNull();

    reopened.write(TODAY_PLAN);
    expect(createDailyBudgetStateStore(db).read()).toEqual(TODAY_PLAN);
  });
});

describe('importLegacyDailyBudgetState', () => {
  const rig = () => ({ settings: new MockSettings(), ...open() });

  it('adopts the blob into an empty store and retires the key', () => {
    const { settings, store } = rig();
    const legacy = { ...TODAY_PLAN, ...learned(30, 1 / 24) };
    settings.set(DAILY_BUDGET_STATE, legacy);
    importLegacyDailyBudgetState(settings, store);
    expect(store.read()).toEqual(legacy);
    expect(settings.getKeys()).not.toContain(DAILY_BUDGET_STATE);
  });

  it('leaves a key that reads back undefined, and the store empty, for the next boot', () => {
    const { settings, store } = rig();
    settings.set(DAILY_BUDGET_STATE, { ...TODAY_PLAN, ...learned(30, 1 / 24) });
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === DAILY_BUDGET_STATE ? undefined : originalGet(key)));
    importLegacyDailyBudgetState(settings, store);
    get.mockRestore();
    expect(settings.getKeys()).toContain(DAILY_BUDGET_STATE);
    expect(store.read()).toBeNull();
  });

  it('leaves a blob that is not a daily-budget state for the next boot', () => {
    const { settings, store } = rig();
    settings.set(DAILY_BUDGET_STATE, { profileUncontrolled: 'junk' });
    importLegacyDailyBudgetState(settings, store);
    expect(settings.getKeys()).toContain(DAILY_BUDGET_STATE);
    expect(store.read()).toBeNull();
  });

  // The boot whose import deferred wrote a fresh, unlearned state since: the
  // store's plan is today's, and the blob's weeks of profile must survive it.
  it('keeps the store plan and takes the profile from the side that has learned more', () => {
    const { settings, store } = rig();
    const oldPlan: DailyBudgetState = { ...TODAY_PLAN, dateKey: '2026-09-27', plannedKWh: hourly(2), frozen: true };
    settings.set(DAILY_BUDGET_STATE, { ...oldPlan, ...learned(30, 0.03) });
    store.write({ ...TODAY_PLAN, ...learned(0, 1 / 24) });
    importLegacyDailyBudgetState(settings, store);
    expect(store.read()).toEqual({ ...TODAY_PLAN, ...learned(30, 0.03) });
    expect(settings.getKeys()).not.toContain(DAILY_BUDGET_STATE);

    settings.set(DAILY_BUDGET_STATE, { ...oldPlan, ...learned(3, 0.03) });
    store.write({ ...TODAY_PLAN, ...learned(31, 0.05) });
    importLegacyDailyBudgetState(settings, store);
    expect(store.read()).toEqual({ ...TODAY_PLAN, ...learned(31, 0.05) });
  });

  it('does nothing once the key is gone', () => {
    const { db, settings, store } = rig();
    const changes = totalChanges(db);
    importLegacyDailyBudgetState(settings, store);
    expect(totalChanges(db)).toBe(changes);
    expect(store.read()).toBeNull();
  });
});
