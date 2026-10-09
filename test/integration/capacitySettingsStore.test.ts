// Integration tests for the capacity scalar settings boundary
// (`lib/power/capacitySettingsStore.ts`), one layer over the shared
// MockSettings seam: home-scoped key mapping (main = historical unsuffixed
// keys, other homes = `<key>:<homeId>`) and the exact fallback semantics — a
// non-finite scalar or non-boolean dry-run flag resolves to the construction-
// bound last-good provider, while an unreadable listed period is unavailable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapacitySettingsStore, scheduleCapacitySettingsReadRetry } from '../../lib/power/capacitySettingsStore';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { CapacityScalarSettingsRead } from '../../lib/power/capacitySettingsStore';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import {
  CAPACITY_ENABLED,
  GRID_IMPORT_ENABLED,
  GRID_IMPORT_LIMIT_KW,
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  MAIN_HOME_ID,
} from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';

const fallback = (): CapacityScalarSettings => ({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 12, marginKw: 0.5, dryRun: false, periodMinutes: 60 });
const resolvedValue = (read: CapacityScalarSettingsRead): CapacityScalarSettings => {
  expect(read.state).toBe('resolved');
  if (read.state === 'unavailable') throw new Error('expected resolved capacity settings');
  return read.value;
};

describe('createCapacitySettingsStore', () => {
  it('supports grid control independently of settlement capacity', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_ENABLED, false);
    settings.set(GRID_IMPORT_ENABLED, true);
    settings.set(GRID_IMPORT_LIMIT_KW, 3.3);
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);
    expect(resolvedValue(store.read())).toMatchObject({ capacityEnabled: false, gridImportLimitKw: 3.3 });
  });

  // At boot nothing has been accepted, and the caller's last-good is the app's
  // hard-coded default — a posture the owner never set — so a malformed read
  // keeps the safe boot posture rather than resolving on it.
  it.each([null, undefined, NaN, Infinity, 0, -1, '3.3'])('rejects an enabled invalid grid threshold at boot (%s)', (value) => {
    const settings = new MockSettings();
    settings.set(GRID_IMPORT_ENABLED, true);
    settings.set(GRID_IMPORT_LIMIT_KW, value);
    expect(createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback).read()).toEqual({ state: 'unavailable' });
  });

  it('rejects a malformed Capacity limit switch, and a switch on without a threshold, at boot', () => {
    const switchJunk = new MockSettings();
    switchJunk.set(CAPACITY_ENABLED, 'off');
    expect(createCapacitySettingsStore(switchJunk, MAIN_HOME_ID, fallback).read()).toEqual({ state: 'unavailable' });

    const noThreshold = new MockSettings();
    noThreshold.set(GRID_IMPORT_ENABLED, true);
    expect(createCapacitySettingsStore(noThreshold, MAIN_HOME_ID, fallback).read()).toEqual({ state: 'unavailable' });
  });

  /** A Main store that has accepted a 4.4 kW grid limit with capacity on: the posture a malformed read carries. */
  const storeWithAcceptedGrid = (): { settings: MockSettings; store: ReturnType<typeof createCapacitySettingsStore> } => {
    const settings = new MockSettings();
    settings.set(CAPACITY_ENABLED, true);
    settings.set(GRID_IMPORT_ENABLED, true);
    settings.set(GRID_IMPORT_LIMIT_KW, 4.4);
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);
    expect(resolvedValue(store.read())).toMatchObject({ capacityEnabled: true, gridImportLimitKw: 4.4 });
    return { settings, store };
  };

  it.each([null, undefined, NaN, Infinity, 0, -1, '3.3'])(
    'keeps the accepted grid posture for an enabled invalid threshold (%s) and still resolves the rest',
    (value) => {
      const { settings, store } = storeWithAcceptedGrid();
      settings.set(GRID_IMPORT_LIMIT_KW, value);
      // The fields beside the malformed pair still move: a dry-run or hard-cap
      // edit is not frozen behind it.
      settings.set(CAPACITY_LIMIT_KW, 7.5);
      settings.set(CAPACITY_DRY_RUN, true);
      expect(store.read()).toEqual({
        state: 'retained',
        value: { ...fallback(), capacityEnabled: true, gridImportLimitKw: 4.4, limitKw: 7.5, dryRun: true },
        askAgain: true,
      });
    },
  );

  it('keeps the accepted posture when the grid threshold is removed with the switch still on', () => {
    const { settings, store } = storeWithAcceptedGrid();
    settings.unset(GRID_IMPORT_LIMIT_KW);
    settings.set(CAPACITY_MARGIN_KW, 0.3);
    expect(store.read()).toEqual({
      state: 'retained',
      value: { ...fallback(), capacityEnabled: true, gridImportLimitKw: 4.4, marginKw: 0.3 },
      askAgain: true,
    });
  });

  it('keeps the accepted Capacity limit switch when it reads back malformed', () => {
    const { settings, store } = storeWithAcceptedGrid();
    settings.set(CAPACITY_ENABLED, 'off');
    expect(store.read()).toEqual({
      state: 'retained',
      value: { ...fallback(), capacityEnabled: true, gridImportLimitKw: 4.4 },
      askAgain: true,
    });
  });

  it('applies a well-formed Capacity limit change while the grid threshold reads back malformed', () => {
    const { settings, store } = storeWithAcceptedGrid();
    settings.set(CAPACITY_ENABLED, false);
    settings.unset(GRID_IMPORT_LIMIT_KW);
    expect(store.read()).toEqual({
      state: 'retained',
      value: { ...fallback(), capacityEnabled: false, gridImportLimitKw: 4.4 },
      askAgain: true,
    });
  });

  describe('the retry window', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-09T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Measured in time, not reads: other settings handlers read the block too.
    it('asks again for 30 s after the first malformed read however often it is read, then stops', () => {
      const { settings, store } = storeWithAcceptedGrid();
      settings.set(GRID_IMPORT_LIMIT_KW, 'junk');
      for (let i = 0; i < 50; i += 1) expect(store.read()).toMatchObject({ state: 'retained', askAgain: true });
      vi.advanceTimersByTime(29_999);
      expect(store.read()).toMatchObject({ state: 'retained', askAgain: true });
      vi.advanceTimersByTime(1);
      // Past the window the carried posture stands; it is not a recovery.
      expect(store.read()).toEqual({
        state: 'retained',
        value: { ...fallback(), capacityEnabled: true, gridImportLimitKw: 4.4 },
        askAgain: false,
      });
    });

    it('opens a fresh window on an explicit write of a carried key, and only of one', () => {
      const { settings, store } = storeWithAcceptedGrid();
      settings.set(GRID_IMPORT_LIMIT_KW, 'junk');
      store.read();
      vi.advanceTimersByTime(30_000);
      expect(store.read()).toMatchObject({ askAgain: false });

      store.noteWrite(CAPACITY_LIMIT_KW);
      expect(store.read()).toMatchObject({ askAgain: false });
      for (const key of [CAPACITY_ENABLED, GRID_IMPORT_ENABLED, GRID_IMPORT_LIMIT_KW, CAPACITY_PERIOD_MINUTES]) {
        store.noteWrite(key);
        expect(store.read()).toMatchObject({ state: 'retained', askAgain: true });
        vi.advanceTimersByTime(30_000);
        expect(store.read()).toMatchObject({ askAgain: false });
      }
    });

    it('closes the window on a well-formed read, so a later failed read gets a full one', () => {
      const { settings, store } = storeWithAcceptedGrid();
      settings.set(GRID_IMPORT_LIMIT_KW, null);
      store.read();
      vi.advanceTimersByTime(20_000);
      settings.set(GRID_IMPORT_LIMIT_KW, 3.3);
      expect(resolvedValue(store.read()).gridImportLimitKw).toBe(3.3);
      settings.set(GRID_IMPORT_LIMIT_KW, null);
      store.read();
      vi.advanceTimersByTime(29_000);
      expect(store.read()).toEqual({
        state: 'retained',
        value: { ...fallback(), capacityEnabled: true, gridImportLimitKw: 3.3 },
        askAgain: true,
      });
    });
  });

  it('retains a disabled grid threshold without enforcing it', () => {
    const settings = new MockSettings();
    settings.set(GRID_IMPORT_ENABLED, false);
    settings.set(GRID_IMPORT_LIMIT_KW, 3.3);
    expect(resolvedValue(createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback).read()).gridImportLimitKw).toBeNull();
  });

  it('does not apply main-home switches to a meter area', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_ENABLED, false);
    settings.set(GRID_IMPORT_ENABLED, true);
    settings.set(GRID_IMPORT_LIMIT_KW, 3.3);
    expect(resolvedValue(createCapacitySettingsStore(settings, 'cabin', fallback).read()))
      .toMatchObject({ capacityEnabled: true, gridImportLimitKw: null });
  });

  it('treats an empty SDK key list as unavailable', () => {
    const store = createCapacitySettingsStore(new MockSettings(), MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ state: 'unavailable' });
  });

  it('reads the historical unsuffixed keys for the main home', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 7.5);
    settings.set(CAPACITY_MARGIN_KW, 0.4);
    settings.set(CAPACITY_DRY_RUN, true);
    // Suffixed decoys must be invisible to the main home.
    settings.set(`${CAPACITY_LIMIT_KW}:${MAIN_HOME_ID}`, 99);
    settings.set(`${CAPACITY_LIMIT_KW}:cabin`, 3);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.readHardCapConfiguration()).toEqual({ state: 'resolved', configured: true });
    expect(resolvedValue(store.read())).toEqual({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 7.5, marginKw: 0.4, dryRun: true, periodMinutes: 60 });
  });

  it('resolves an unwritten hard cap from key presence without mistaking the fallback for a saved value', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_MARGIN_KW, 0.4);
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.readHardCapConfiguration()).toEqual({ state: 'resolved', configured: false });
    expect(resolvedValue(store.read()).limitKw).toBe(12);
  });

  it('keeps unavailable hard-cap provenance explicit at the UI boundary', () => {
    const store = createCapacitySettingsStore(new MockSettings(), MAIN_HOME_ID, fallback);
    expect(store.readHardCapConfiguration()).toEqual({ state: 'unavailable' });
  });

  it('keeps a listed hard cap configured when its value read is transiently unavailable', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 7.5);
    const readSetting = settings.get.bind(settings);
    settings.get = (key: string): unknown => (key === CAPACITY_LIMIT_KW ? null : readSetting(key));
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({
      state: 'resolved',
      value: fallback(),
    });
    expect(store.readHardCapConfiguration()).toEqual({ state: 'resolved', configured: true });
  });

  it('keeps hard-cap provenance resolved when an unrelated listed period is malformed', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 8);
    settings.set(CAPACITY_PERIOD_MINUTES, 30);
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ state: 'unavailable' });
    expect(store.readHardCapConfiguration()).toEqual({ state: 'resolved', configured: true });
  });

  it('reads home-suffixed keys for a non-main home', () => {
    const settings = new MockSettings();
    // Unsuffixed (main-home) values must be invisible to another home.
    settings.set(CAPACITY_LIMIT_KW, 10);
    settings.set(CAPACITY_MARGIN_KW, 0.2);
    settings.set(CAPACITY_DRY_RUN, true);
    settings.set(`${CAPACITY_LIMIT_KW}:cabin`, 5);
    settings.set(`${CAPACITY_MARGIN_KW}:cabin`, 0.1);
    settings.set(`${CAPACITY_DRY_RUN}:cabin`, false);

    const store = createCapacitySettingsStore(settings, 'cabin', fallback);

    expect(resolvedValue(store.read())).toEqual({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 5, marginKw: 0.1, dryRun: false, periodMinutes: 60 });
  });

  it('does not bleed main-home values into a home whose keys are unset', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 10);
    settings.set(CAPACITY_MARGIN_KW, 0.2);
    settings.set(CAPACITY_DRY_RUN, true);

    const store = createCapacitySettingsStore(settings, 'cabin', fallback);

    expect(resolvedValue(store.read())).toEqual(fallback());
  });

  it.each([
    ['a numeric string', '12'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['null', null],
    ['an object blob', { limitKw: 9 }],
  ])('falls back to the caller-supplied scalar when the persisted value is %s', (_label, junk) => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, junk);
    settings.set(CAPACITY_MARGIN_KW, junk);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(resolvedValue(store.read())).toEqual({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 12, marginKw: 0.5, dryRun: false, periodMinutes: 60 });
  });

  it.each([
    ['a boolean string', 'true'],
    ['a truthy number', 1],
    ['null', null],
    ['undefined', undefined],
  ])('falls back to the caller-supplied dry-run flag when the persisted value is %s', (_label, junk) => {
    const settings = new MockSettings();
    settings.set(CAPACITY_DRY_RUN, junk);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, () => ({ ...fallback(), dryRun: true }));

    expect(resolvedValue(store.read()).dryRun).toBe(true);
  });

  it('respects an explicit dry-run false over a true fallback', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_DRY_RUN, false);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, () => ({ ...fallback(), dryRun: true }));

    expect(resolvedValue(store.read()).dryRun).toBe(false);
  });

  it('reads the Belgian quarter-hour period and keeps it through an unreadable listed value', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_PERIOD_MINUTES, 15);
    settings.set(CAPACITY_LIMIT_KW, 8);
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(resolvedValue(store.read()).periodMinutes).toBe(15);

    // The accepted quarter is carried, alone; the hard cap edit beside it lands.
    settings.set(CAPACITY_PERIOD_MINUTES, 30);
    settings.set(CAPACITY_LIMIT_KW, 9);
    expect(store.read()).toEqual({
      state: 'retained',
      value: { ...fallback(), limitKw: 9, periodMinutes: 15 },
      askAgain: true,
    });
  });

  it('rejects an unreadable listed period at boot rather than carrying the default', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_PERIOD_MINUTES, 30);
    expect(createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback).read()).toEqual({ state: 'unavailable' });
    // A meter area follows the same rule for its own period.
    settings.set(`${CAPACITY_PERIOD_MINUTES}:cabin`, 'quarter');
    expect(createCapacitySettingsStore(settings, 'cabin', fallback).read()).toEqual({ state: 'unavailable' });
  });

  it('distinguishes a transient listed-key miss from an unwritten period', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 8);
    settings.set(CAPACITY_PERIOD_MINUTES, 15);
    const readSetting = settings.get.bind(settings);
    let missPeriod = true;
    settings.get = (key: string): unknown => (
      key === CAPACITY_PERIOD_MINUTES && missPeriod ? null : readSetting(key)
    );
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ state: 'unavailable' });
    missPeriod = false;
    expect(resolvedValue(store.read()).periodMinutes).toBe(15);

    settings.unset(CAPACITY_PERIOD_MINUTES);
    expect(resolvedValue(store.read()).periodMinutes).toBe(60);
  });

  it('passes any finite scalar through unbounded, exactly like the historical reads', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 0);
    settings.set(CAPACITY_MARGIN_KW, -0.3);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(resolvedValue(store.read())).toEqual({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 0, marginKw: -0.3, dryRun: false, periodMinutes: 60 });
  });

  it('resolves each field independently when only some persisted values are junk', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 8);
    settings.set(CAPACITY_MARGIN_KW, 'oops');
    settings.set(CAPACITY_DRY_RUN, 'yes');

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(resolvedValue(store.read())).toEqual({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 8, marginKw: 0.5, dryRun: false, periodMinutes: 60 });
  });
});

// The store and the retry policy wired as both consumers wire them
// (`setup/appRuntimeApi.ts`, `setup/homeRuntime/homeCapacityBundleApi.ts`): a
// read schedules its own re-read until one resolves.
describe('capacity settings read retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  let reload: () => void = () => undefined;

  const wireReload = (settings: MockSettings): {
    reads: () => number;
    last: () => CapacityScalarSettingsRead | null;
    timers: TimerRegistry;
    store: ReturnType<typeof createCapacitySettingsStore>;
  } => {
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);
    const timers = new TimerRegistry();
    let reads = 0;
    let last: CapacityScalarSettingsRead | null = null;
    reload = (): void => {
      reads += 1;
      last = store.read();
      scheduleCapacitySettingsReadRetry(last, timers, 'capacitySettingsLoadRetry', reload);
    };
    reload();
    return { reads: () => reads, last: () => last, timers, store };
  };

  it('does not spin a perpetual retry for a persistently malformed grid pair', () => {
    const settings = new MockSettings();
    settings.set(GRID_IMPORT_ENABLED, true);
    settings.set(GRID_IMPORT_LIMIT_KW, 3.3);
    const { reads, timers, store } = wireReload(settings);
    expect(reads()).toBe(1);

    // An external write breaks the pair; the handler notes it and re-reads.
    settings.set(GRID_IMPORT_LIMIT_KW, -1);
    store.noteWrite(GRID_IMPORT_LIMIT_KW);
    reload();
    vi.advanceTimersByTime(10 * 60 * 1000);
    // The write's read and a retry a second for the 30 s window; the read that
    // finds the window spent schedules nothing more.
    expect(reads()).toBe(32);
    expect(timers.has('capacitySettingsLoadRetry')).toBe(false);
  });

  it('retries a correction whose first read misses, after the window was spent', () => {
    const settings = new MockSettings();
    settings.set(GRID_IMPORT_ENABLED, true);
    settings.set(GRID_IMPORT_LIMIT_KW, 3.3);
    const { reads, timers, store, last } = wireReload(settings);
    settings.set(GRID_IMPORT_LIMIT_KW, 'junk');
    store.noteWrite(GRID_IMPORT_LIMIT_KW);
    reload();
    vi.advanceTimersByTime(60_000);
    expect(timers.has('capacitySettingsLoadRetry')).toBe(false);
    const spentReads = reads();

    // The owner writes a valid limit, and the read right after it misses.
    settings.set(GRID_IMPORT_LIMIT_KW, 5.5);
    const readSetting = settings.get.bind(settings);
    let missLimit = true;
    settings.get = (key: string): unknown => (key === GRID_IMPORT_LIMIT_KW && missLimit ? undefined : readSetting(key));
    store.noteWrite(GRID_IMPORT_LIMIT_KW);
    reload();
    expect(last()).toMatchObject({ state: 'retained', askAgain: true });
    missLimit = false;
    vi.advanceTimersByTime(1_000);
    expect(reads()).toBe(spentReads + 2);
    expect(last()).toMatchObject({ state: 'resolved', value: { gridImportLimitKw: 5.5 } });
    expect(timers.has('capacitySettingsLoadRetry')).toBe(false);
  });

  // The boot rule: nothing accepted yet, so the read stays unavailable and keeps
  // being asked — the boot posture stands until a well-formed read arrives.
  it('keeps asking at boot until the pair reads well-formed', () => {
    const settings = new MockSettings();
    settings.set(GRID_IMPORT_ENABLED, true);
    settings.set(GRID_IMPORT_LIMIT_KW, 'junk');
    const { reads, last } = wireReload(settings);
    expect(last()).toEqual({ state: 'unavailable' });
    vi.advanceTimersByTime(60_000);
    expect(reads()).toBe(61);
    settings.set(GRID_IMPORT_LIMIT_KW, 3.3);
    vi.advanceTimersByTime(1_000);
    expect(last()).toMatchObject({ state: 'resolved', value: { gridImportLimitKw: 3.3 } });
  });

  it('recovers a grid pair that heals inside the retry window', () => {
    const settings = new MockSettings();
    settings.set(GRID_IMPORT_ENABLED, true);
    const readSetting = settings.get.bind(settings);
    let missLimit = true;
    settings.set(GRID_IMPORT_LIMIT_KW, 3.3);
    settings.get = (key: string): unknown => (key === GRID_IMPORT_LIMIT_KW && missLimit ? undefined : readSetting(key));
    const { reads, timers } = wireReload(settings);

    vi.advanceTimersByTime(3_000);
    expect(reads()).toBe(4);
    missLimit = false;
    vi.advanceTimersByTime(1_000);
    expect(reads()).toBe(5);
    vi.advanceTimersByTime(60_000);
    expect(reads()).toBe(5);
    expect(timers.has('capacitySettingsLoadRetry')).toBe(false);
  });
});
