import { importLegacyPowerTrackers } from '../../lib/power/trackerLegacySettings';
import { createTrackerStore } from '../../lib/power/trackerStore';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { MockSettings } from '../mocks/homey';

const HISTORY: PowerTrackerState = {
  lastPowerW: 900,
  lastTimestamp: 1_000,
  buckets: { '2026-03-03T10:00:00.000Z': 1.5 },
  dailyTotals: { '2026-03-03': 4 },
  hourlyAverages: { 'tue-10': { sum: 3, count: 2 } },
  objectiveProfiles: {},
};

const rig = () => {
  const settings = new MockSettings();
  // A real install never has an empty key list here: the boot migrations
  // set their markers first.
  settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
  const store = createTrackerStore(openUserdataDatabase(IN_MEMORY_DATABASE));
  return { settings, store };
};

describe('importLegacyPowerTrackers', () => {
  it('imports the Main and every area blob into an empty store and retires the keys', () => {
    const { settings, store } = rig();
    settings.set('power_tracker_state', HISTORY);
    settings.set('power_tracker_state:h_a', { ...HISTORY, meterIdentity: { powerSource: 'homey_energy', meterDeviceId: 'm-a' } });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: ['main', 'h_a'], retired: [], deferred: [] });
    expect(store.load('main')).toEqual(HISTORY);
    expect(store.load('h_a')?.meterIdentity).toEqual({ powerSource: 'homey_energy', meterDeviceId: 'm-a' });
    expect(settings.get('power_tracker_state')).toBeNull();
    expect(settings.get('power_tracker_state:h_a')).toBeNull();
    // A second boot has nothing left to do.
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: [] });
  });

  it('retires a blob the store has already outgrown without importing it', () => {
    const { settings, store } = rig();
    store.save('main', { ...HISTORY, lastPowerW: 1_200, lastTimestamp: 2_000 });
    settings.set('power_tracker_state', HISTORY);
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: ['main'], deferred: [] });
    expect(store.load('main')?.lastPowerW).toBe(1_200);
    expect(settings.get('power_tracker_state')).toBeNull();
  });

  // The previous release wrote the blob under a looser guard: a NaN it
  // stringified became a persisted `null`, a learned profile may not parse.
  // One such entry must cost that entry, never the history around it.
  it('salvages a blob the strict guard would refuse whole, dropping only the bad entries', () => {
    const { settings, store } = rig();
    settings.set('power_tracker_state', {
      ...HISTORY,
      hourlyAverages: { 'tue-10': { sum: 3, count: 2 }, 'wed-11': null },
      lastDevicePowerWById: { 'dev-1': 300, 'dev-2': null },
      buckets: { ...HISTORY.buckets, '2026-03-03T11:00:00.000Z': 'junk' },
      objectiveProfiles: { 'dev-1': 'not a profile' },
      lastGenerationW: Number.NaN,
    });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: ['main'], retired: [], deferred: [] });
    expect(store.load('main')).toEqual({
      ...HISTORY,
      hourlyAverages: { 'tue-10': { sum: 3, count: 2 } },
      lastDevicePowerWById: { 'dev-1': 300 },
      objectiveProfiles: undefined,
    });
    expect(store.load('main')).not.toHaveProperty('objectiveProfiles');
    expect(settings.get('power_tracker_state')).toBeNull();
  });

  // A listed key that reads back as something with no tracker in it is a
  // failed read, never an absence: the key stays, and the next boot reads it
  // again. The store gets nothing, so a real blob cannot be shadowed.
  it('defers a value with no tracker in it and leaves the key in place', () => {
    const { settings, store } = rig();
    settings.set('power_tracker_state', 'garbage');
    settings.set('power_tracker_state:h_a', ['not', 'a', 'tracker']);
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: ['main', 'h_a'] });
    expect(store.load('main')).toBeNull();
    expect(settings.get('power_tracker_state')).toBe('garbage');
    expect(settings.get('power_tracker_state:h_a')).toEqual(['not', 'a', 'tracker']);
  });

  // One transient SDK read must never cost the history: a listed key that
  // answers empty, a throwing read, or a store that cannot answer leaves the
  // key where it is for the next boot.
  it('defers on a suspect read and leaves the key in place', () => {
    const { settings, store } = rig();
    settings.set('power_tracker_state', HISTORY);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === 'power_tracker_state' ? undefined : originalGet(key)));
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: ['main'] });
    get.mockImplementation(() => { throw new Error('sdk down'); });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: ['main'] });
    get.mockRestore();
    const load = vi.spyOn(store, 'load').mockImplementation(() => { throw new Error('disk busy'); });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: ['main'] });
    load.mockRestore();
    const replace = vi.spyOn(store, 'replace').mockImplementation(() => { throw new Error('disk full'); });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: ['main'] });
    replace.mockRestore();
    expect(originalGet('power_tracker_state')).toEqual(HISTORY);
    expect(store.load('main')).toBeNull();
    // The boot that reads cleanly imports.
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: ['main'], retired: [], deferred: [] });
    expect(store.load('main')).toEqual(HISTORY);
  });

  it('a throwing key list or unset defers, and the next boot finds the home in the store', () => {
    const { settings, store } = rig();
    settings.set('power_tracker_state', HISTORY);
    const getKeys = vi.spyOn(settings, 'getKeys').mockImplementation(() => { throw new Error('sdk down'); });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: [] });
    getKeys.mockRestore();
    const unset = vi.spyOn(settings, 'unset').mockImplementation(() => { throw new Error('sdk down'); });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: ['main'] });
    expect(store.load('main')).toEqual(HISTORY);
    unset.mockRestore();
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: ['main'], deferred: [] });
    expect(settings.get('power_tracker_state')).toBeNull();
  });
});
