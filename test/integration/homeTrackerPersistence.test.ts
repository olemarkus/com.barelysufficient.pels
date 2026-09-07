import type { Logger as PinoLogger } from '../../lib/logging/logger';
import { createHomeTrackerPersistence, type TrackerMeterBinding } from '../../lib/power/homeTrackerPersistence';
import { createTrackerStore, type TrackerStore } from '../../lib/power/trackerStore';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { POWER_TRACKER_STATE } from '../../lib/utils/settingsKeys';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { MockSettings } from '../mocks/homey';

const UNBOUND: TrackerMeterBinding = { kind: 'unbound' };
const BOUND: TrackerMeterBinding = { kind: 'bound', identity: { powerSource: 'homey_energy', meterDeviceId: 'meter-a' } };

const build = (
  meterBinding: TrackerMeterBinding,
  initialState: PowerTrackerState = {},
  store?: TrackerStore,
  persisted: PowerTrackerState | null = null,
) => {
  const settings = new MockSettings();
  const timers = new TimerRegistry();
  const events: Array<Record<string, unknown>> = [];
  const onRecovered = vi.fn();
  const logger = {
    error: (fields: Record<string, unknown>) => { events.push(fields); },
    info: (fields: Record<string, unknown>) => { events.push(fields); },
    warn: () => {},
    debug: () => {},
  } as unknown as PinoLogger;
  const trackerStore = store ?? createTrackerStore(openUserdataDatabase(IN_MEMORY_DATABASE));
  const tracker = createHomeTrackerPersistence({
    deps: {
      getStore: () => trackerStore,
      legacySettings: settings,
      timers,
      getLogger: () => logger,
      getPruneDebugEmitter: () => () => {},
      reportError: () => {},
      getTimeZone: () => 'Europe/Oslo',
      isTornDown: () => false,
      onRecovered,
      onPersisted: () => {},
    },
    homeId: 'main',
    initialState,
    persistedState: persisted,
    meterBinding,
    timerKey: (suffix) => suffix,
  });
  const has = (event: string): boolean => events.some((e) => e.event === event);
  const stored = (): PowerTrackerState | null => trackerStore.load('main');
  return { settings, timers, tracker, store: trackerStore, stored, has, onRecovered };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('HomeTrackerPersistence boot hydration', () => {
  it('adopts the stored tracker and, unbound, stamps no meter identity on what it persists', () => {
    const { store } = build(UNBOUND);
    store.save('main', { lastPowerW: 900, lastTimestamp: 1_000 }, null);
    const { tracker, stored } = build(UNBOUND, {}, store);
    tracker.hydrate();
    expect(tracker.getState()).toEqual({ lastPowerW: 900, lastTimestamp: 1_000 });
    tracker.replace({ lastPowerW: 1_200, lastTimestamp: 2_000 });
    expect(stored()).toEqual({ lastPowerW: 1_200, lastTimestamp: 2_000 });
  });

  // The blob every install wrote before the store existed: imported on the
  // first boot that finds no rows, then unset so nothing pays for it again.
  it('imports a legacy settings blob once, then unsets the key', () => {
    const { settings, tracker, stored, has } = build(UNBOUND);
    settings.set(POWER_TRACKER_STATE, { lastPowerW: 900, lastTimestamp: 1_000, buckets: { '2026-03-03T10:00:00.000Z': 1.5 } });
    tracker.hydrate();
    expect(tracker.getState()).toEqual({ lastPowerW: 900, lastTimestamp: 1_000, buckets: { '2026-03-03T10:00:00.000Z': 1.5 } });
    expect(stored()).toEqual({ lastPowerW: 900, lastTimestamp: 1_000, buckets: { '2026-03-03T10:00:00.000Z': 1.5 } });
    expect(settings.get(POWER_TRACKER_STATE)).toBeNull();
    expect(has('home_power_tracker_migrated_to_store')).toBe(true);
  });

  it('keeps the in-memory state when nothing is persisted', () => {
    const { tracker } = build(UNBOUND, { lastPowerW: 500, lastTimestamp: 1_000 });
    tracker.hydrate();
    expect(tracker.getState()).toEqual({ lastPowerW: 500, lastTimestamp: 1_000 });
  });

  it('starts fenced on a suspect legacy read: the first prune does not write, and a repair reopens persistence', async () => {
    vi.useFakeTimers();
    const { settings, timers, tracker, stored, has, onRecovered } = build(UNBOUND);
    settings.set('other', true);
    settings.set(POWER_TRACKER_STATE, 'garbage');
    tracker.hydrate();
    expect(has('home_power_tracker_reload_suspect')).toBe(true);
    tracker.startPruning();
    tracker.save({ lastPowerW: 700, lastTimestamp: Date.now() });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stored()).toBeNull();
    expect(settings.get(POWER_TRACKER_STATE)).toBe('garbage');
    expect(timers.has('powerTrackerSave')).toBe(false);
    // A valid repair reopens persistence on the next reprobe: it is imported,
    // the accrued in-memory state is persisted from then on, and the key goes.
    settings.set(POWER_TRACKER_STATE, { lastPowerW: 650, lastTimestamp: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(has('home_power_tracker_reload_recovered')).toBe(true);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(settings.get(POWER_TRACKER_STATE)).toBeNull();
    tracker.replace({ lastPowerW: 800, lastTimestamp: Date.now() });
    expect(stored()).toEqual({ lastPowerW: 800, lastTimestamp: expect.any(Number) });
  });

  it('a boot fence that recovers to an older blob keeps the samples admitted since boot, and persists them', async () => {
    vi.useFakeTimers();
    const { settings, tracker, stored, has } = build(UNBOUND);
    settings.set('other', true);
    settings.set(POWER_TRACKER_STATE, 'garbage');
    tracker.hydrate();
    const admittedAt = Date.now() + 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    tracker.save({ lastPowerW: 900, lastTimestamp: admittedAt });
    // The repair is the pre-boot blob: older than what this run has seen.
    settings.set(POWER_TRACKER_STATE, { lastPowerW: 400, lastTimestamp: admittedAt - 3_600_000 });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(has('home_power_tracker_reload_recovered')).toBe(true);
    expect(tracker.getState().lastTimestamp).toBe(admittedAt);
    expect(stored()?.lastTimestamp).toBe(admittedAt);
  });

  it('refuses a stored tracker that belongs to another meter when bound', () => {
    const { store } = build(BOUND);
    store.save('main', {
      lastPowerW: 900,
      meterIdentity: { powerSource: 'homey_energy', meterDeviceId: 'meter-b' },
    }, null);
    const { tracker, has } = build(BOUND, {}, store);
    tracker.hydrate();
    expect(has('home_power_tracker_reload_suspect')).toBe(true);
    expect(tracker.getState()).toEqual({ meterIdentity: BOUND.kind === 'bound' ? BOUND.identity : undefined });
  });
});

describe('HomeTrackerPersistence writes', () => {
  it('the owner\'s reset lifts a fence: an unreadable blob is what they are discarding', () => {
    const { settings, timers, tracker, stored, has, onRecovered } = build(UNBOUND);
    settings.set('other', true);
    settings.set(POWER_TRACKER_STATE, 'garbage');
    tracker.hydrate();
    expect(timers.has('trackerPersistenceReprobe')).toBe(true);
    expect(tracker.replace({ lastPowerW: 0, lastTimestamp: 1_000 })).toBe(true);
    expect(stored()).toEqual({ lastPowerW: 0, lastTimestamp: 1_000 });
    expect(settings.get(POWER_TRACKER_STATE)).toBeNull();
    expect(timers.has('trackerPersistenceReprobe')).toBe(false);
    expect(has('home_power_tracker_reload_recovered')).toBe(true);
    // The owner's reset is its own reaction; no recovery hook fires for it.
    expect(onRecovered).not.toHaveBeenCalled();
    // Persistence is open again: a later save schedules and lands.
    tracker.save({ lastPowerW: 50, lastTimestamp: 2_000 });
    expect(timers.has('powerTrackerSave')).toBe(true);
  });

  it('replace persists at once and supersedes a pending debounced save', async () => {
    vi.useFakeTimers();
    const { timers, tracker, store, stored } = build(UNBOUND);
    const saves = vi.spyOn(store, 'save');
    const replaces = vi.spyOn(store, 'replace');
    tracker.save({ lastPowerW: 100, lastTimestamp: Date.now() });
    expect(timers.has('powerTrackerSave')).toBe(true);
    expect(tracker.replace({ lastPowerW: 200, lastTimestamp: Date.now() })).toBe(true);
    expect(timers.has('powerTrackerSave')).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // The reset is one whole-state write; the superseded debounce never lands.
    expect(replaces).toHaveBeenCalledTimes(1);
    expect(saves).not.toHaveBeenCalled();
    expect(stored()?.lastPowerW).toBe(200);
  });

  it('commit after adopt persists the whole transition: a rollover write carries state adopted after the sample', () => {
    vi.useFakeTimers();
    const hour = new Date('2026-03-03T10:59:58.000Z').getTime();
    const { timers, tracker, stored } = build(UNBOUND, { lastPowerW: 100, lastTimestamp: hour });
    const previous = tracker.getState();
    tracker.adopt({ lastPowerW: 200, lastTimestamp: hour + 3_000 });
    // A second adoption, as the cap recorder makes, before the commit.
    tracker.adopt({ lastPowerW: 200, lastTimestamp: hour + 3_000, dailyBudgetCaps: { h11: 1 } });
    tracker.commit(previous);
    expect(timers.has('powerTrackerSave')).toBe(false);
    expect(stored()).toEqual({
      lastPowerW: 200,
      lastTimestamp: hour + 3_000,
      dailyBudgetCaps: { h11: 1 },
    });
  });

  // The whole point of the store: a persist touches the rows that changed,
  // not the 663 kB the settings blob re-serialised for a two-number change.
  it('a debounced save writes only the changed rows', async () => {
    vi.useFakeTimers();
    const base: PowerTrackerState = {
      lastPowerW: 100,
      lastTimestamp: Date.now(),
      buckets: Object.fromEntries(Array.from({ length: 720 }, (_, i) => [`h${i}`, i])),
      dailyTotals: { '2026-03-01': 10, '2026-03-02': 11 },
    };
    const { tracker, store, stored } = build(UNBOUND, base);
    tracker.replace(base);
    const save = vi.spyOn(store, 'save');
    tracker.save({ ...base, lastPowerW: 150, lastTimestamp: base.lastTimestamp! + 10_000, buckets: { ...base.buckets, h719: 999 } });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(save).toHaveBeenCalledTimes(1);
    // Diffed against the state the store already holds, never a full rewrite.
    expect(save.mock.calls[0]?.[2]).toBe(base);
    expect(stored()?.buckets?.h719).toBe(999);
    expect(stored()?.dailyTotals).toEqual(base.dailyTotals);
  });

  // A meter area is hydrated before construction: its first save must diff
  // against the rows it was built from, or a bucket the startup prune drops
  // stays on disk and is folded into the daily totals again after every boot.
  it('a controller built from stored rows deletes on its first save what that save dropped', async () => {
    vi.useFakeTimers();
    const seeded: PowerTrackerState = {
      lastPowerW: 100, lastTimestamp: 1_000, meterIdentity: BOUND.kind === 'bound' ? BOUND.identity : undefined,
      buckets: { stale: 1, fresh: 2 },
    };
    const { store } = build(BOUND);
    store.save('main', seeded, null);
    const { tracker, stored } = build(BOUND, seeded, store, seeded);
    tracker.save({ ...seeded, lastTimestamp: 2_000, buckets: { fresh: 2 } });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(stored()?.buckets).toEqual({ fresh: 2 });
  });

  it('a reload that finds nothing persisted keeps the in-memory state', () => {
    const { settings, tracker } = build(UNBOUND, { lastPowerW: 300, lastTimestamp: 1_000 });
    settings.set('other', true);
    tracker.hydrate();
    expect(tracker.getState()).toEqual({ lastPowerW: 300, lastTimestamp: 1_000 });
  });

  it('bound trackers stamp their meter identity on every persisted state', () => {
    const { tracker, stored } = build(BOUND);
    tracker.replace({ lastPowerW: 100, lastTimestamp: 1_000 });
    expect(stored()).toEqual({
      lastPowerW: 100,
      lastTimestamp: 1_000,
      meterIdentity: { powerSource: 'homey_energy', meterDeviceId: 'meter-a' },
    });
  });
});
