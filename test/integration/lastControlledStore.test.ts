import { describe, expect, it } from 'vitest';
import { createLastControlledStore, importLegacyLastControlled } from '../../lib/plan/lastControlledStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { DEVICE_LAST_CONTROLLED_MS } from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createLastControlledStore(db) };
};

const totalChanges = (db: UserdataDatabase): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

describe('lastControlledStore', () => {
  it('reads empty for a home it holds nothing for, and keeps each home apart', () => {
    const { store } = open();
    expect(store.read('main')).toEqual({});
    store.write('main', { 'dev-1': 100 });
    store.write('h_a', { 'dev-2': 200 });
    expect(store.read('main')).toEqual({ 'dev-1': 100 });
    expect(store.read('h_a')).toEqual({ 'dev-2': 200 });
  });

  it('writes only the devices that changed, even when handed the same mutated map', () => {
    // The executor persists the one map it keeps stamping.
    const { db, store } = open();
    const live: Record<string, number> = { 'dev-1': 100, 'dev-2': 200, 'dev-3': 300 };
    store.write('main', live);
    const before = totalChanges(db);
    live['dev-2'] = 250;
    store.write('main', live);
    expect(totalChanges(db) - before).toBe(1);
    store.write('main', live);
    expect(totalChanges(db) - before).toBe(1);
    expect(createLastControlledStore(db).read('main')).toEqual({ 'dev-1': 100, 'dev-2': 250, 'dev-3': 300 });
  });

  it('drops a device the map no longer holds', () => {
    const { db, store } = open();
    store.write('main', { 'dev-1': 100, 'dev-2': 200 });
    store.write('main', { 'dev-1': 100 });
    expect(createLastControlledStore(db).read('main')).toEqual({ 'dev-1': 100 });
  });
});

describe('importLegacyLastControlled', () => {
  const rig = () => {
    const settings = new MockSettings();
    // A real install never has an empty key list here: the boot migrations
    // set their markers first.
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports the main and area keys once each and retires them', () => {
    const { settings, store } = rig();
    settings.set(DEVICE_LAST_CONTROLLED_MS, { 'dev-1': 100 });
    settings.set(`${DEVICE_LAST_CONTROLLED_MS}:h_a`, { 'dev-2': 200 });
    importLegacyLastControlled(settings, store, 'main');
    importLegacyLastControlled(settings, store, 'h_a');
    expect(store.read('main')).toEqual({ 'dev-1': 100 });
    expect(store.read('h_a')).toEqual({ 'dev-2': 200 });
    expect(settings.get(DEVICE_LAST_CONTROLLED_MS)).toBeNull();
    expect(settings.get(`${DEVICE_LAST_CONTROLLED_MS}:h_a`)).toBeNull();

    // A key that comes back (an unset that failed) never imports twice.
    settings.set(DEVICE_LAST_CONTROLLED_MS, { 'dev-1': 1 });
    importLegacyLastControlled(settings, store, 'main');
    expect(store.read('main')).toEqual({ 'dev-1': 100 });
    expect(settings.get(DEVICE_LAST_CONTROLLED_MS)).toBeNull();
  });

  it('merges under what the store holds, keeping the later stamp per device', () => {
    const { settings, store } = rig();
    store.write('main', { 'dev-1': 500, 'dev-2': 100 });
    settings.set(DEVICE_LAST_CONTROLLED_MS, { 'dev-1': 300, 'dev-2': 400, 'dev-3': 50 });
    importLegacyLastControlled(settings, store, 'main');
    expect(store.read('main')).toEqual({ 'dev-1': 500, 'dev-2': 400, 'dev-3': 50 });
  });

  it('keeps a key that holds no map of numbers, and imports nothing from it', () => {
    const { settings, store } = rig();
    settings.set(DEVICE_LAST_CONTROLLED_MS, ['not', 'a', 'map']);
    importLegacyLastControlled(settings, store, 'main');
    expect(store.read('main')).toEqual({});
    expect(store.hasImportedLegacy('main')).toBe(false);
    expect(settings.get(DEVICE_LAST_CONTROLLED_MS)).toEqual(['not', 'a', 'map']);
  });
});
