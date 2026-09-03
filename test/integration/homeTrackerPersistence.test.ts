import type { Logger as PinoLogger } from '../../lib/logging/logger';
import { createHomeTrackerPersistence, type TrackerMeterBinding } from '../../lib/power/homeTrackerPersistence';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { POWER_TRACKER_STATE } from '../../lib/utils/settingsKeys';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { MockSettings } from '../mocks/homey';

const UNBOUND: TrackerMeterBinding = { kind: 'unbound' };
const BOUND: TrackerMeterBinding = { kind: 'bound', identity: { powerSource: 'homey_energy', meterDeviceId: 'meter-a' } };

const build = (meterBinding: TrackerMeterBinding, initialState: PowerTrackerState = {}) => {
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
  const tracker = createHomeTrackerPersistence({
    deps: {
      settings,
      timers,
      getLogger: () => logger,
      getPruneDebugEmitter: () => () => {},
      reportError: () => {},
      getTimeZone: () => 'Europe/Oslo',
      isTornDown: () => false,
      onRecovered,
    },
    homeId: 'main',
    initialState,
    meterBinding,
    timerKey: (suffix) => suffix,
  });
  const has = (event: string): boolean => events.some((e) => e.event === event);
  return { settings, timers, tracker, has, onRecovered };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('HomeTrackerPersistence boot hydration (reloadFromSettings on a fresh controller)', () => {
  it('adopts a present tracker and, unbound, stamps no meter identity on what it persists', () => {
    const { settings, tracker } = build(UNBOUND);
    settings.set(POWER_TRACKER_STATE, { lastPowerW: 900, lastTimestamp: 1_000 });
    tracker.reloadFromSettings();
    expect(tracker.getState()).toEqual({ lastPowerW: 900, lastTimestamp: 1_000 });
    tracker.replace({ lastPowerW: 1_200, lastTimestamp: 2_000 });
    expect(settings.get(POWER_TRACKER_STATE)).toEqual({ lastPowerW: 1_200, lastTimestamp: 2_000 });
  });

  it('keeps the in-memory state when nothing is persisted', () => {
    const { tracker } = build(UNBOUND, { lastPowerW: 500, lastTimestamp: 1_000 });
    tracker.reloadFromSettings();
    expect(tracker.getState()).toEqual({ lastPowerW: 500, lastTimestamp: 1_000 });
  });

  it('starts fenced on a suspect read: the first prune does not overwrite the unreadable blob', async () => {
    vi.useFakeTimers();
    const { settings, timers, tracker, has, onRecovered } = build(UNBOUND);
    settings.set('other', true);
    settings.set(POWER_TRACKER_STATE, 'garbage');
    tracker.reloadFromSettings();
    expect(has('home_power_tracker_reload_suspect')).toBe(true);
    tracker.startPruning();
    tracker.save({ lastPowerW: 700, lastTimestamp: Date.now() });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settings.get(POWER_TRACKER_STATE)).toBe('garbage');
    expect(timers.has('powerTrackerSave')).toBe(false);
    // A valid repair reopens persistence on the next reprobe, and the accrued
    // in-memory state is persisted from then on.
    settings.set(POWER_TRACKER_STATE, { lastPowerW: 650, lastTimestamp: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(has('home_power_tracker_reload_recovered')).toBe(true);
    // Whatever bootstrapped off the fenced state is told to refresh.
    expect(onRecovered).toHaveBeenCalledTimes(1);
    tracker.replace({ lastPowerW: 800, lastTimestamp: Date.now() });
    expect(settings.get(POWER_TRACKER_STATE)).toEqual({ lastPowerW: 800, lastTimestamp: expect.any(Number) });
  });

  it('a boot fence that recovers to an older blob keeps the samples admitted since boot, and persists them', async () => {
    vi.useFakeTimers();
    const { settings, tracker, has } = build(UNBOUND);
    settings.set('other', true);
    settings.set(POWER_TRACKER_STATE, 'garbage');
    tracker.reloadFromSettings();
    const admittedAt = Date.now() + 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    tracker.save({ lastPowerW: 900, lastTimestamp: admittedAt });
    // The repair is the pre-boot blob: older than what this run has seen.
    settings.set(POWER_TRACKER_STATE, { lastPowerW: 400, lastTimestamp: admittedAt - 3_600_000 });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(has('home_power_tracker_reload_recovered')).toBe(true);
    expect(tracker.getState().lastTimestamp).toBe(admittedAt);
    expect((settings.get(POWER_TRACKER_STATE) as PowerTrackerState).lastTimestamp).toBe(admittedAt);
  });

  it('refuses a persisted tracker that belongs to another meter when bound', () => {
    const { settings, tracker, has } = build(BOUND);
    settings.set(POWER_TRACKER_STATE, {
      lastPowerW: 900,
      meterIdentity: { powerSource: 'homey_energy', meterDeviceId: 'meter-b' },
    });
    tracker.reloadFromSettings();
    expect(has('home_power_tracker_reload_suspect')).toBe(true);
    expect(tracker.getState()).toEqual({ meterIdentity: BOUND.kind === 'bound' ? BOUND.identity : undefined });
  });
});

describe('HomeTrackerPersistence writes', () => {
  it('the owner\'s reset lifts a fence: an unreadable blob is what they are discarding', () => {
    const { settings, timers, tracker, has, onRecovered } = build(UNBOUND);
    settings.set('other', true);
    settings.set(POWER_TRACKER_STATE, 'garbage');
    tracker.reloadFromSettings();
    expect(timers.has('trackerPersistenceReprobe')).toBe(true);
    expect(tracker.replace({ lastPowerW: 0, lastTimestamp: 1_000 })).toBe(true);
    expect(settings.get(POWER_TRACKER_STATE)).toEqual({ lastPowerW: 0, lastTimestamp: 1_000 });
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
    const { settings, timers, tracker } = build(UNBOUND);
    const writes = vi.spyOn(settings, 'set');
    tracker.save({ lastPowerW: 100, lastTimestamp: Date.now() });
    expect(timers.has('powerTrackerSave')).toBe(true);
    expect(tracker.replace({ lastPowerW: 200, lastTimestamp: Date.now() })).toBe(true);
    expect(timers.has('powerTrackerSave')).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(writes.mock.calls.filter(([key]) => key === POWER_TRACKER_STATE)).toHaveLength(1);
    expect((settings.get(POWER_TRACKER_STATE) as PowerTrackerState).lastPowerW).toBe(200);
  });

  it('commit after adopt persists the whole transition: a rollover write carries state adopted after the sample', () => {
    vi.useFakeTimers();
    const hour = new Date('2026-03-03T10:59:58.000Z').getTime();
    const { settings, timers, tracker } = build(UNBOUND, { lastPowerW: 100, lastTimestamp: hour });
    const previous = tracker.getState();
    tracker.adopt({ lastPowerW: 200, lastTimestamp: hour + 3_000 });
    // A second adoption, as the cap recorder makes, before the commit.
    tracker.adopt({ lastPowerW: 200, lastTimestamp: hour + 3_000, dailyBudgetCaps: { h11: 1 } });
    tracker.commit(previous);
    expect(timers.has('powerTrackerSave')).toBe(false);
    expect(settings.get(POWER_TRACKER_STATE)).toEqual({
      lastPowerW: 200,
      lastTimestamp: hour + 3_000,
      dailyBudgetCaps: { h11: 1 },
    });
  });

  it('a reload that finds nothing persisted keeps the in-memory state', () => {
    const { settings, tracker } = build(UNBOUND, { lastPowerW: 300, lastTimestamp: 1_000 });
    settings.set('other', true);
    tracker.reloadFromSettings();
    expect(tracker.getState()).toEqual({ lastPowerW: 300, lastTimestamp: 1_000 });
  });

  it('bound trackers stamp their meter identity on every persisted state', () => {
    const { settings, tracker } = build(BOUND);
    tracker.replace({ lastPowerW: 100, lastTimestamp: 1_000 });
    expect(settings.get(POWER_TRACKER_STATE)).toEqual({
      lastPowerW: 100,
      lastTimestamp: 1_000,
      meterIdentity: { powerSource: 'homey_energy', meterDeviceId: 'meter-a' },
    });
  });
});
