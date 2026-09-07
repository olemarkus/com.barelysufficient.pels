import type { Logger as PinoLogger } from '../../lib/logging/logger';
import { createHomeTrackerPersistence, type TrackerMeterBinding } from '../../lib/power/homeTrackerPersistence';
import { createTrackerStore, type TrackerStore } from '../../lib/power/trackerStore';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { partialDouble } from '../helpers/partialDouble';

const UNBOUND: TrackerMeterBinding = { kind: 'unbound' };
const BOUND: TrackerMeterBinding = { kind: 'bound', identity: { powerSource: 'homey_energy', meterDeviceId: 'meter-a' } };

const build = (
  meterBinding: TrackerMeterBinding,
  initialState: PowerTrackerState = {},
  store?: TrackerStore,
) => {
  const timers = new TimerRegistry();
  const events: Array<Record<string, unknown>> = [];
  const logger = partialDouble<PinoLogger>({
    error: (fields: unknown) => { events.push(fields as Record<string, unknown>); },
    info: (fields: unknown) => { events.push(fields as Record<string, unknown>); },
    warn: () => {},
    debug: () => {},
  });
  const onPersisted = vi.fn();
  const trackerStore = store ?? createTrackerStore(openUserdataDatabase(IN_MEMORY_DATABASE));
  const tracker = createHomeTrackerPersistence({
    deps: {
      getStore: () => trackerStore,
      timers,
      getLogger: () => logger,
      getPruneDebugEmitter: () => () => {},
      reportError: () => {},
      getTimeZone: () => 'Europe/Oslo',
      isTornDown: () => false,
      onPersisted,
    },
    homeId: 'main',
    initialState,
    meterBinding,
    timerKey: (suffix) => suffix,
  });
  const has = (event: string): boolean => events.some((e) => e.event === event);
  const stored = (): PowerTrackerState | null => trackerStore.load('main');
  return {
    timers, tracker, store: trackerStore, stored, has, onPersisted,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('HomeTrackerPersistence boot hydration', () => {
  it('adopts the stored tracker and, unbound, stamps no meter identity on what it persists', () => {
    const { store } = build(UNBOUND);
    store.save('main', { lastPowerW: 900, lastTimestamp: 1_000 });
    const { tracker, stored } = build(UNBOUND, {}, store);
    tracker.hydrate();
    expect(tracker.getState()).toEqual({ lastPowerW: 900, lastTimestamp: 1_000 });
    tracker.replace({ lastPowerW: 1_200, lastTimestamp: 2_000 });
    expect(stored()).toEqual({ lastPowerW: 1_200, lastTimestamp: 2_000 });
  });

  it('keeps the in-memory state when nothing is persisted', () => {
    const { tracker } = build(UNBOUND, { lastPowerW: 500, lastTimestamp: 1_000 });
    tracker.hydrate();
    expect(tracker.getState()).toEqual({ lastPowerW: 500, lastTimestamp: 1_000 });
  });

  // One transient read at boot must not wipe persisted history: a blank
  // tracker diffed against the rows on disk would delete everything the
  // failed read never adopted. So the read is owed again before the first
  // persist, nothing is written until it succeeds, and when it does the
  // stored history is adopted under what the run accrued meanwhile.
  it('keeps persistence closed after a failed boot read until the read succeeds, then persists both', async () => {
    vi.useFakeTimers();
    const {
      tracker, store, stored, has, timers,
    } = build(UNBOUND);
    store.save('main', {
      lastPowerW: 400, lastTimestamp: 1_000, buckets: { old: 2 }, dailyTotals: { yesterday: 9 },
    });
    let reads = 0;
    const originalLoad = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementation((homeId) => {
      reads += 1;
      if (reads <= 2) throw new Error('disk busy');
      return originalLoad(homeId);
    });
    const saves = vi.spyOn(store, 'save');
    tracker.hydrate();
    expect(has('home_power_tracker_hydrate_failed')).toBe(true);
    expect(tracker.getState()).toEqual({});
    // The first persist finds the store still unreadable: no write, retried later.
    tracker.save({ lastPowerW: 700, lastTimestamp: 5_000, buckets: { now: 1 } });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(saves).not.toHaveBeenCalled();
    expect(has('home_power_tracker_persist_failed')).toBe(true);
    expect(stored()).toEqual({
      lastPowerW: 400, lastTimestamp: 1_000, buckets: { old: 2 }, dailyTotals: { yesterday: 9 },
    });
    expect(timers.has('powerTrackerSave')).toBe(false);
    // The store answers again: the stored history goes under the run's state
    // and the persist carries both.
    tracker.save({ lastPowerW: 800, lastTimestamp: 6_000, buckets: { now: 1.5 } });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(has('home_power_tracker_hydrated_late')).toBe(true);
    expect(saves).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual({
      lastPowerW: 800, lastTimestamp: 6_000, buckets: { old: 2, now: 1.5 }, dailyTotals: { yesterday: 9 },
    });
    expect(tracker.getState()).toEqual(stored());
  });

  it('the owner\'s reset after a failed boot read discards the stored history by intent', () => {
    const { tracker, store, stored } = build(UNBOUND);
    store.save('main', { lastPowerW: 400, lastTimestamp: 1_000, buckets: { old: 2 } });
    vi.spyOn(store, 'load').mockImplementationOnce(() => { throw new Error('disk busy'); });
    tracker.hydrate();
    expect(tracker.replace({ lastPowerW: 0, lastTimestamp: 2_000 })).toBe(true);
    expect(stored()).toEqual({ lastPowerW: 0, lastTimestamp: 2_000 });
    // Nothing is owed after the reset: a later save writes without a read.
    const load = vi.spyOn(store, 'load');
    load.mockClear();
    tracker.resetFreshness();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('HomeTrackerPersistence writes', () => {
  it('replace persists at once and supersedes a pending debounced save', async () => {
    vi.useFakeTimers();
    const {
      timers, tracker, store, stored, onPersisted,
    } = build(UNBOUND);
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
    expect(onPersisted).toHaveBeenCalledTimes(1);
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
  it('a debounced save hands the store the whole state once, and the store writes only the changed rows', async () => {
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
    expect(stored()?.buckets?.h719).toBe(999);
    expect(stored()?.dailyTotals).toEqual(base.dailyTotals);
  });

  // A meter area is hydrated before construction and its first save must
  // delete what it dropped, or a bucket the startup prune drops stays on
  // disk and is folded into the daily totals again after every boot. The
  // store holds the diff base — it loaded the rows — so the controller
  // carries none.
  it('a controller built from stored rows deletes on its first save what that save dropped', async () => {
    vi.useFakeTimers();
    const seeded: PowerTrackerState = {
      lastPowerW: 100, lastTimestamp: 1_000, meterIdentity: BOUND.kind === 'bound' ? BOUND.identity : undefined,
      buckets: { stale: 1, fresh: 2 },
    };
    const { store } = build(BOUND);
    store.save('main', seeded);
    const { tracker, stored } = build(BOUND, store.load('main') ?? {}, store);
    tracker.save({ ...seeded, lastTimestamp: 2_000, buckets: { fresh: 2 } });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(stored()?.buckets).toEqual({ fresh: 2 });
  });

  it('a failed persist is logged, leaves the rows as they were, and the next persist is tried', async () => {
    vi.useFakeTimers();
    const {
      tracker, store, stored, has, onPersisted,
    } = build(UNBOUND);
    tracker.replace({ lastPowerW: 1, lastTimestamp: 1_000 });
    const save = vi.spyOn(store, 'save').mockImplementationOnce(() => { throw new Error('disk full'); });
    tracker.save({ lastPowerW: 2, lastTimestamp: 2_000 });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(has('home_power_tracker_persist_failed')).toBe(true);
    expect(stored()).toEqual({ lastPowerW: 1, lastTimestamp: 1_000 });
    expect(onPersisted).toHaveBeenCalledTimes(1);
    tracker.save({ lastPowerW: 3, lastTimestamp: 3_000 });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual({ lastPowerW: 3, lastTimestamp: 3_000 });
    expect(onPersisted).toHaveBeenCalledTimes(2);
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

  it('resetFreshness drops the latch, keeps the accounting, and persists at once', () => {
    const { tracker, stored, timers } = build(UNBOUND, {
      lastPowerW: 100, lastTimestamp: 1_000, dailyTotals: { d: 1 },
    });
    tracker.save({ lastPowerW: 120, lastTimestamp: 1_500, dailyTotals: { d: 1 } });
    expect(tracker.resetFreshness()).toBe(true);
    expect(timers.has('powerTrackerSave')).toBe(false);
    expect(stored()).toEqual({ dailyTotals: { d: 1 } });
  });
});
