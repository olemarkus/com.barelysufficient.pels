import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import {
  createActivePlanPersistence,
  createActivePlanStore,
  importLegacyActivePlans,
} from '../../lib/objectives/deferredObjectives/activePlanStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING } from '../../lib/utils/settingsKeys';
import type { DeferredObjectiveActivePlansV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import { MockSettings } from '../mocks/homey';

const HOUR_MS = 3_600_000;

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createActivePlanStore(db) };
};

/** The plans a recorder holds after a Flow card created a task on each device. */
const plansFor = (...deviceIds: string[]): DeferredObjectiveActivePlansV1 => {
  const recorder = new DeferredObjectiveActivePlanRecorder({ load: () => null, save: () => {} });
  for (const deviceId of deviceIds) {
    recorder.markPending({
      deviceId,
      deviceName: `Device ${deviceId}`,
      objectiveKind: 'temperature',
      targetValue: 65,
      deadlineAtMs: 6 * HOUR_MS,
      enforcement: 'soft',
    }, HOUR_MS);
  }
  return recorder.getActivePlansSnapshot();
};

const totalChanges = (db: ReturnType<typeof open>['db']): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

describe('activePlanStore', () => {
  it('answers null while empty, and round-trips the plans one row per device', () => {
    const { db, store } = open();
    expect(store.read()).toBeNull();
    const plans = plansFor('a', 'b');
    store.write(plans);
    expect(createActivePlanStore(db).read()).toEqual(plans);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM deferred_objective_active_plans').get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it('writes only the device whose plan changed, and deletes a dropped one', () => {
    const { db, store } = open();
    const plans = plansFor('a', 'b');
    store.write(plans);
    const before = totalChanges(db);
    store.write({ ...plans, plansByDeviceId: { ...plans.plansByDeviceId } });
    expect(totalChanges(db)).toBe(before);
    store.write({ ...plans, plansByDeviceId: { a: plans.plansByDeviceId.a } });
    expect(totalChanges(db)).toBe(before + 1);
    expect(Object.keys(createActivePlanStore(db).read()?.plansByDeviceId ?? {})).toEqual(['a']);
  });

  it('quarantines a row the normaliser refuses or whose plan names another device', () => {
    const { db, store } = open();
    const plans = plansFor('a', 'b', 'c');
    store.write(plans);
    db.prepare('UPDATE deferred_objective_active_plans SET plan_json = ? WHERE device_id = ?').run('{"nope":1}', 'a');
    db.prepare('UPDATE deferred_objective_active_plans SET plan_json = ? WHERE device_id = ?')
      .run(JSON.stringify(plans.plansByDeviceId.b), 'c');
    expect(Object.keys(createActivePlanStore(db).read()?.plansByDeviceId ?? {})).toEqual(['b']);
  });

  it('hands a restarted recorder the plans the previous run saved, and pushes every save', () => {
    const { db, store } = open();
    const pushed: DeferredObjectiveActivePlansV1[] = [];
    const first = new DeferredObjectiveActivePlanRecorder(createActivePlanPersistence(store, (plans) => pushed.push(plans)));
    first.markPending({
      deviceId: 'heater', deviceName: 'Heater', objectiveKind: 'temperature',
      targetValue: 65, deadlineAtMs: 6 * HOUR_MS, enforcement: 'soft',
    }, HOUR_MS);
    expect(first.flushIfDirty()).toBe(true);
    expect(pushed.map((plans) => Object.keys(plans.plansByDeviceId))).toEqual([['heater']]);

    const restarted = new DeferredObjectiveActivePlanRecorder(
      createActivePlanPersistence(createActivePlanStore(db), () => {}),
    );
    expect(restarted.getActivePlansSnapshot()).toEqual(first.getActivePlansSnapshot());
  });

  it('seeds zero plans when the store cannot be read, and carries on when it cannot be written', () => {
    const { store } = open();
    const failing = {
      read: () => { throw new Error('disk gone'); },
      write: () => { throw new Error('disk gone'); },
    };
    const onSaved = vi.fn();
    const recorder = new DeferredObjectiveActivePlanRecorder(createActivePlanPersistence(failing, onSaved));
    expect(recorder.getActivePlansSnapshot().plansByDeviceId).toEqual({});
    recorder.markPending({
      deviceId: 'heater', deviceName: 'Heater', objectiveKind: 'temperature',
      targetValue: 65, deadlineAtMs: 6 * HOUR_MS, enforcement: 'soft',
    }, HOUR_MS);
    expect(recorder.flushIfDirty()).toBe(true);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(store.read()).toBeNull();
  });
});

describe('importLegacyActivePlans', () => {
  const rig = () => {
    const settings = new MockSettings();
    settings.set('boot_migrations_v2_unusable_stepped_config_repaired', true);
    return { settings, ...open() };
  };

  it('imports the legacy key once into an empty store and unsets it', () => {
    const { settings, db, store } = rig();
    const legacy = plansFor('a', 'b');
    settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, legacy);
    importLegacyActivePlans(settings, store);
    expect(createActivePlanStore(db).read()).toEqual(legacy);
    expect(store.hasImportedLegacy()).toBe(true);
    expect(settings.getKeys()).not.toContain(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING);
  });

  it('takes a deferred blob under the plans the recorder wrote since, which win for their device', () => {
    const { settings, store } = rig();
    const legacy = plansFor('a', 'b');
    const newerA = { ...legacy.plansByDeviceId.a, deadlineAtMs: legacy.plansByDeviceId.a.deadlineAtMs + HOUR_MS };
    store.write({ version: legacy.version, plansByDeviceId: { a: newerA } });
    settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, legacy);
    importLegacyActivePlans(settings, store);
    expect(store.read()?.plansByDeviceId).toEqual({ a: newerA, b: legacy.plansByDeviceId.b });
    expect(store.hasImportedLegacy()).toBe(true);
    expect(settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING)).toBeNull();
  });

  it('leaves the key for the next boot on an unreadable read or a value that is not a plans envelope', () => {
    const { settings, store } = rig();
    const legacy = plansFor('a');
    settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, legacy);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => {
      if (key === DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING) throw new Error('sdk unavailable');
      return originalGet(key);
    });
    importLegacyActivePlans(settings, store);
    get.mockImplementation((key) => (key === DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING ? undefined : originalGet(key)));
    importLegacyActivePlans(settings, store);
    get.mockRestore();
    expect(store.read()).toBeNull();
    expect(settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING)).toEqual(legacy);

    const keys = vi.spyOn(settings, 'getKeys').mockReturnValue([]);
    importLegacyActivePlans(settings, store);
    keys.mockRestore();
    expect(settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING)).toEqual(legacy);

    settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, { version: 2, plansByDeviceId: {} });
    importLegacyActivePlans(settings, store);
    expect(settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING)).toEqual({ version: 2, plansByDeviceId: {} });

    settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, legacy);
    importLegacyActivePlans(settings, store);
    expect(store.read()).toEqual(legacy);
    expect(settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING)).toBeNull();
  });

  it('retires the key of an import whose unset threw without importing it again', () => {
    const { settings, store } = rig();
    settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, plansFor('a'));
    const unset = vi.spyOn(settings, 'unset').mockImplementationOnce(() => { throw new Error('sdk unavailable'); });
    importLegacyActivePlans(settings, store);
    unset.mockRestore();
    // The recorder dropped the task since; the blob must not bring it back.
    store.write({ version: 1, plansByDeviceId: {} });
    importLegacyActivePlans(settings, store);
    expect(store.read()).toBeNull();
    expect(settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING)).toBeNull();
  });
});
