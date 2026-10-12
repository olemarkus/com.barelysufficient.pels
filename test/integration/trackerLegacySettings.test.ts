import { aggregateAndPruneHistory } from '../../lib/power/tracker';
import { importLegacyPowerTrackers } from '../../lib/power/trackerLegacySettings';
import { createTrackerStore } from '../../lib/power/trackerStore';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { MockSettings } from '../mocks/homey';
import { captureLogger } from '../utils/loggerCapture';

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
  // An upgrading install lists its keys here. A fresh one's list is empty,
  // since the userdata stores open before the boot migrations write
  // anything, and an empty list imports nothing.
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

  // A boot whose import deferred still hydrates an empty tracker and persists
  // it at the first prune; the next boot's import keeps both: the blob's
  // history under the store's newer hours and latch.
  it('imports the blob under what the store already holds, keeping both', () => {
    const { settings, store } = rig();
    store.save('main', { lastPowerW: 1_200, lastTimestamp: 2_000, buckets: { '2026-03-03T11:00:00.000Z': 0.4 } });
    settings.set('power_tracker_state', HISTORY);
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: ['main'], retired: [], deferred: [] });
    expect(store.load('main')).toEqual({
      ...HISTORY,
      lastPowerW: 1_200,
      lastTimestamp: 2_000,
      buckets: { ...HISTORY.buckets, '2026-03-03T11:00:00.000Z': 0.4 },
    });
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
    const write = vi.spyOn(store, 'writeLegacyImport').mockImplementation(() => { throw new Error('disk full'); });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: ['main'] });
    write.mockRestore();
    expect(originalGet('power_tracker_state')).toEqual(HISTORY);
    expect(store.load('main')).toBeNull();
    // The boot that reads cleanly imports.
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: ['main'], retired: [], deferred: [] });
    expect(store.load('main')).toEqual(HISTORY);
  });

  // A fresh install's first boot opens the stores before any setting is
  // written, so its key list is genuinely empty: no news, and no warning.
  it('says at info that an empty key list imports nothing', () => {
    const settings = new MockSettings();
    const store = createTrackerStore(openUserdataDatabase(IN_MEMORY_DATABASE));
    const capture = captureLogger();
    try {
      expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: [] });
      expect(capture.findEvent('legacy_power_tracker_import_deferred'))
        .toMatchObject({ level: 30, reason: 'key_list_unreadable' });
    } finally {
      capture.restore();
    }
  });

  it('a throwing key list or unset defers, and the next boot finds the home in the store', () => {
    const { settings, store } = rig();
    settings.set('power_tracker_state', HISTORY);
    const getKeys = vi.spyOn(settings, 'getKeys').mockImplementation(() => { throw new Error('sdk down'); });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: [] });
    expect(settings.get('power_tracker_state')).toEqual(HISTORY);
    getKeys.mockRestore();
    const unset = vi.spyOn(settings, 'unset').mockImplementation(() => { throw new Error('sdk down'); });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: ['main'] });
    expect(store.load('main')).toEqual(HISTORY);
    unset.mockRestore();
    // The next boot finds the first boot's import mark and only retires the key.
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: ['main'], deferred: [] });
    expect(store.load('main')).toEqual(HISTORY);
    expect(settings.get('power_tracker_state')).toBeNull();
  });

  // The prune folds an hour that ages out into the daily totals and the
  // averages. Merging the blob again on the next boot would bring the hour
  // back to be folded, and counted, a second time; the import's mark retires
  // the key instead.
  it('retires the key of an import whose unset threw, so the prune never folds an hour twice', () => {
    const { settings, store } = rig();
    const hourMs = 60 * 60 * 1000;
    const agedHour = new Date(Math.floor((Date.now() - 31 * 24 * hourMs) / hourMs) * hourMs).toISOString();
    settings.set('power_tracker_state', { buckets: { [agedHour]: 2 } });
    const unset = vi.spyOn(settings, 'unset').mockImplementationOnce(() => { throw new Error('sdk down'); });
    expect(importLegacyPowerTrackers(settings, store)).toEqual({ imported: [], retired: [], deferred: ['main'] });
    unset.mockRestore();
    const prune = () => store.save('main', aggregateAndPruneHistory(store.load('main') ?? {}, 'UTC'));
    prune();
    const folded = store.load('main');
    expect(folded?.buckets).toBeUndefined();
    expect(Object.values(folded?.dailyTotals ?? {})).toEqual([2]);

    const capture = captureLogger();
    try {
      const nextBoot = importLegacyPowerTrackers(settings, store);
      prune();
      expect(store.load('main')).toEqual(folded);
      expect(nextBoot).toEqual({ imported: [], retired: ['main'], deferred: [] });
      expect(capture.findEvent('legacy_power_tracker_key_retired')).toMatchObject({ reason: 'store_already_holds' });
    } finally {
      capture.restore();
    }
    expect(settings.get('power_tracker_state')).toBeNull();
  });
});
