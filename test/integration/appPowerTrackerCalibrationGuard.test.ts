import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Homey from 'homey';
import { AppPowerTracker, type AppPowerTrackerDeps } from '../../setup/appPowerTracker';
import { createHomeTrackerPersistence } from '../../lib/power/homeTrackerPersistence';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import {
  PowerCalibrationStore,
  persistPowerCalibrationIfDue,
} from '../../lib/device/devicePowerCalibrationStore';
import { POWER_CALIBRATION } from '../../lib/utils/settingsKeys';
import { SettingsRepository } from '../../setup/settingsRepository';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';

const T0 = 1_000_000;

describe('AppPowerTracker calibration persist guard', () => {
  let timers: TimerRegistry;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    timers = new TimerRegistry();
  });

  afterEach(() => {
    timers.clearAll();
    vi.useRealTimers();
  });

  const build = (): {
    tracker: AppPowerTracker;
    store: PowerCalibrationStore;
    values: Map<string, unknown>;
    setStore: (next: PowerCalibrationStore) => void;
  } => {
    const values = new Map<string, unknown>();
    const homey = {
      settings: {
        get: (key: string): unknown => values.get(key),
        set: (key: string, value: unknown): void => { values.set(key, value); },
      },
    } as never as Homey.App['homey'];
    const active = { store: new PowerCalibrationStore({ persistDebounceMs: 0 }) };
    const tracker = createHomeTrackerPersistence({
      deps: {
        settings: homey.settings,
        timers,
        getLogger: () => undefined,
        getPruneDebugEmitter: () => () => {},
        reportError: vi.fn(),
        getTimeZone: () => 'Europe/Oslo',
        isTornDown: () => false,
        onRecovered: () => {},
      },
      homeId: 'main',
      initialState: {},
      meterBinding: { kind: 'unbound' },
      timerKey: (suffix) => suffix,
    });
    // Only the members the pruning/guard start path exercises get real
    // behaviour; everything else either throws (so an unexpected call fails
    // the test loudly) or is a spy.
    const deps: AppPowerTrackerDeps = {
      homey,
      settingsRepository: new SettingsRepository(homey),
      timers,
      getTracker: () => tracker,
      getPowerCalibrationStore: () => active.store,
      setPowerCalibrationStore: vi.fn(),
      getDailyBudgetService: () => { throw new Error('not exercised'); },
      getPlanService: () => undefined,
      error: vi.fn(),
      updateDailyBudgetAndRecordCap: vi.fn(),
      // Routed the way app.ts routes it: back into the real persist function,
      // resolving the store at CALL time — the app replaces its store after
      // boot, and a guard that captured the boot-time store would silently
      // persist a stale one.
      persistPowerCalibrationIfDue: (nowMs?: number) => {
        persistPowerCalibrationIfDue({
          homey,
          store: active.store,
          nowMs: nowMs ?? Date.now(),
        });
      },
      flushPowerCalibration: vi.fn(),
    };
    return {
      tracker: new AppPowerTracker(deps),
      store: active.store,
      values,
      setStore: (next) => { active.store = next; },
    };
  };

  it('persists dirty calibration state on the guard tick without a power sample', () => {
    const { tracker, store, values } = build();
    // A device-hook mutation marks the store dirty; nothing attempts a persist
    // (no power sample arrives — the exact gap the guard exists to close).
    const outcome = store.recordSample({
      deviceId: 'hoiax-1',
      stepId: 'max',
      measuredPowerKw: 2.75,
      nameplateKw: 3,
      dataObservedAtMs: T0,
      nowMs: T0,
    });
    expect(outcome.accepted).toBe(true);
    tracker.startPowerTrackerPruning();
    expect(timers.has('powerCalibrationPersistGuard')).toBe(true);
    expect(values.has(POWER_CALIBRATION)).toBe(false);
    vi.advanceTimersByTime(65_000);
    const written = values.get(POWER_CALIBRATION) as PowerCalibrationSnapshot;
    expect(written.devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
    expect(store.isDirty()).toBe(false);
  });

  it('resolves the store at tick time, so a post-boot store replacement is picked up', () => {
    const { tracker, setStore, values } = build();
    tracker.startPowerTrackerPruning();
    // The app replaces its calibration store after the guard is registered
    // (loadPowerCalibrationStore runs in its own startup step). The guard
    // must persist the REPLACEMENT store's samples, not a captured boot-time
    // placeholder.
    const replacement = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const outcome = replacement.recordSample({
      deviceId: 'late-1',
      stepId: 'max',
      measuredPowerKw: 1.9,
      nameplateKw: 2,
      dataObservedAtMs: T0,
      nowMs: T0,
    });
    expect(outcome.accepted).toBe(true);
    setStore(replacement);
    vi.advanceTimersByTime(65_000);
    const written = values.get(POWER_CALIBRATION) as PowerCalibrationSnapshot;
    expect(written.devices['late-1'].steps.max.observedKw).toBeCloseTo(1.9);
    expect(replacement.isDirty()).toBe(false);
  });
});
