import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ActuationRecord } from '../../lib/plan/actuationRecord';
import {
  createLastControlledRepository,
  createLastControlledStore,
  type LastControlledRepository,
} from '../../lib/plan/lastControlledStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { DEVICE_LAST_CONTROLLED_MS } from '../../lib/utils/settingsKeys';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { MockSettings } from '../mocks/homey';
import { captureLogger } from '../utils/loggerCapture';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, repository: createLastControlledRepository(db) };
};

const totalChanges = (db: UserdataDatabase): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

describe('lastControlledRepository', () => {
  it('reads empty for a home it holds nothing for, and keeps each home apart', () => {
    const { repository } = open();
    expect(repository.read('main')).toEqual({});
    repository.write('main', { 'dev-1': 100 });
    repository.write('h_a', { 'dev-2': 200 });
    expect(repository.read('main')).toEqual({ 'dev-1': 100 });
    expect(repository.read('h_a')).toEqual({ 'dev-2': 200 });
  });

  it('writes only the devices that changed, even when handed the same mutated map', () => {
    // The executor persists the one map it keeps stamping.
    const { db, repository } = open();
    const live: Record<string, number> = { 'dev-1': 100, 'dev-2': 200, 'dev-3': 300 };
    repository.write('main', live);
    const before = totalChanges(db);
    live['dev-2'] = 250;
    repository.write('main', live);
    expect(totalChanges(db) - before).toBe(1);
    repository.write('main', live);
    expect(totalChanges(db) - before).toBe(1);
    expect(createLastControlledRepository(db).read('main')).toEqual({ 'dev-1': 100, 'dev-2': 250, 'dev-3': 300 });
  });

  it('drops a device the map no longer holds', () => {
    const { db, repository } = open();
    repository.write('main', { 'dev-1': 100, 'dev-2': 200 });
    repository.write('main', { 'dev-1': 100 });
    expect(createLastControlledRepository(db).read('main')).toEqual({ 'dev-1': 100 });
  });
});

describe('lastControlledStore', () => {
  let settings: MockSettings;
  let repository: LastControlledRepository;
  let timers: TimerRegistry;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    settings = new MockSettings();
    // A real install never has an empty key list here: the boot migrations
    // set their markers first.
    settings.set('boot_migrations_v2_unusable_stepped_config_repaired', true);
    ({ repository } = open());
    timers = new TimerRegistry();
  });

  afterEach(() => {
    timers.clearAll();
    vi.useRealTimers();
  });

  const createStore = () => createLastControlledStore(settings, repository, timers);

  const hydrated = (store: ReturnType<typeof createStore>, homeId: string): ActuationRecord => {
    const actuation = new ActuationRecord();
    store.hydrate(homeId, actuation);
    return actuation;
  };

  it('hydrates each home from its own rows and writes them back apart', () => {
    repository.write('main', { 'dev-1': 100 });
    const store = createStore();
    expect(hydrated(store, 'main').lastDeviceControlledMs).toEqual({ 'dev-1': 100 });
    expect(hydrated(store, 'h_a').lastDeviceControlledMs).toEqual({});
    store.write('h_a', { 'dev-2': 200 });
    expect(repository.read('main')).toEqual({ 'dev-1': 100 });
    expect(repository.read('h_a')).toEqual({ 'dev-2': 200 });
  });

  it('imports the main and area keys once each and retires them', () => {
    settings.set(DEVICE_LAST_CONTROLLED_MS, { 'dev-1': 100 });
    settings.set(`${DEVICE_LAST_CONTROLLED_MS}:h_a`, { 'dev-2': 200 });
    const store = createStore();
    expect(hydrated(store, 'main').lastDeviceControlledMs).toEqual({ 'dev-1': 100 });
    expect(hydrated(store, 'h_a').lastDeviceControlledMs).toEqual({ 'dev-2': 200 });
    expect(repository.read('main')).toEqual({ 'dev-1': 100 });
    expect(repository.read('h_a')).toEqual({ 'dev-2': 200 });
    expect(settings.get(DEVICE_LAST_CONTROLLED_MS)).toBeNull();
    expect(settings.get(`${DEVICE_LAST_CONTROLLED_MS}:h_a`)).toBeNull();

    // A key that comes back (an unset that failed) never imports twice.
    settings.set(DEVICE_LAST_CONTROLLED_MS, { 'dev-1': 1 });
    expect(hydrated(createStore(), 'main').lastDeviceControlledMs).toEqual({ 'dev-1': 100 });
    expect(settings.get(DEVICE_LAST_CONTROLLED_MS)).toBeNull();
  });

  it('merges under what the store holds, keeping the later stamp per device', () => {
    repository.write('main', { 'dev-1': 500, 'dev-2': 100 });
    settings.set(DEVICE_LAST_CONTROLLED_MS, { 'dev-1': 300, 'dev-2': 400, 'dev-3': 50 });
    expect(hydrated(createStore(), 'main').lastDeviceControlledMs).toEqual({ 'dev-1': 500, 'dev-2': 400, 'dev-3': 50 });
    expect(repository.read('main')).toEqual({ 'dev-1': 500, 'dev-2': 400, 'dev-3': 50 });
  });

  it('keeps a key that holds no map of numbers, imports nothing from it, and does not retry it this run', () => {
    settings.set(DEVICE_LAST_CONTROLLED_MS, ['not', 'a', 'map']);
    expect(hydrated(createStore(), 'main').lastDeviceControlledMs).toEqual({});
    expect(repository.hasImportedLegacy('main')).toBe(false);
    expect(settings.get(DEVICE_LAST_CONTROLLED_MS)).toEqual(['not', 'a', 'map']);
    expect(timers.has('lastControlledLegacyImportRetry')).toBe(false);
  });

  describe('an import the upgrade boot could not finish', () => {
    /** Hydrate with the key list answering nothing, as the SDK does on a transient miss. */
    const hydrateWithUnreadableKeyList = (store: ReturnType<typeof createStore>, homeId: string) => {
      const getKeys = vi.spyOn(settings, 'getKeys').mockReturnValue([]);
      const actuation = hydrated(store, homeId);
      getKeys.mockRestore();
      return actuation;
    };

    it('is retried within the minute, and the stamps reach the home it was owed to', () => {
      settings.set(DEVICE_LAST_CONTROLLED_MS, { 'dev-1': 100, 'dev-2': 200 });
      const capture = captureLogger();
      onTestFinished(() => capture.restore());
      const actuation = hydrateWithUnreadableKeyList(createStore(), 'main');
      expect(actuation.lastDeviceControlledMs).toEqual({});
      expect(capture.findEvent('legacy_last_controlled_import_deferred')).toMatchObject({
        homeId: 'main', reason: 'key_list_unreadable',
      });

      vi.advanceTimersByTime(60_000);

      expect(actuation.lastDeviceControlledMs).toEqual({ 'dev-1': 100, 'dev-2': 200 });
      expect(repository.read('main')).toEqual({ 'dev-1': 100, 'dev-2': 200 });
      expect(settings.get(DEVICE_LAST_CONTROLLED_MS)).toBeNull();
      expect(timers.has('lastControlledLegacyImportRetry')).toBe(false);
    });

    it('keeps the stamps written while it was owed, and the next write keeps what it imported', () => {
      settings.set(DEVICE_LAST_CONTROLLED_MS, { 'dev-1': 100, 'dev-2': 200 });
      const store = createStore();
      const getKeys = vi.spyOn(settings, 'getKeys').mockReturnValue([]);
      const actuation = hydrated(store, 'main');
      // Stamped and written while the key is owed; the import goes under it.
      actuation.markControlled('dev-2', 900);
      store.write('main', actuation.lastDeviceControlledMs);
      // Stamped, not yet written, when the retry lands.
      actuation.markControlled('dev-3', 950);
      vi.advanceTimersByTime(5 * 60_000);
      expect(actuation.lastDeviceControlledMs).toEqual({ 'dev-2': 900, 'dev-3': 950 });

      getKeys.mockRestore();
      vi.advanceTimersByTime(60_000);
      expect(actuation.lastDeviceControlledMs).toEqual({ 'dev-1': 100, 'dev-2': 900, 'dev-3': 950 });

      // The executor's next write holds exactly the record: nothing imported is lost.
      store.write('main', actuation.lastDeviceControlledMs);
      expect(repository.read('main')).toEqual({ 'dev-1': 100, 'dev-2': 900, 'dev-3': 950 });
      expect(settings.get(DEVICE_LAST_CONTROLLED_MS)).toBeNull();
    });

    it('goes to the record a re-created home hydrated, and leaves a settled home alone', () => {
      settings.set(`${DEVICE_LAST_CONTROLLED_MS}:h_a`, { 'dev-2': 200 });
      repository.write('main', { 'dev-1': 100 });
      const store = createStore();
      const main = hydrated(store, 'main');
      const torn = hydrateWithUnreadableKeyList(store, 'h_a');
      const rebuilt = hydrateWithUnreadableKeyList(store, 'h_a');

      vi.advanceTimersByTime(60_000);

      expect(rebuilt.lastDeviceControlledMs).toEqual({ 'dev-2': 200 });
      expect(torn.lastDeviceControlledMs).toEqual({});
      expect(main.lastDeviceControlledMs).toEqual({ 'dev-1': 100 });
    });
  });
});
