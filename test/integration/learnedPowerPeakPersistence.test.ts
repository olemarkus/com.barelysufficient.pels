import type Homey from 'homey';
import { mockHomeyInstance } from '../mocks/homey';
import { SettingsRepository } from '../../setup/settingsRepository';
import { createLearnedPowerPeakState } from '../../setup/appInit/learnedPowerPeakState';
import { DEVICE_POWER_PEAKS } from '../../lib/utils/settingsKeys';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { LearnedPeaksByDeviceId } from '../../lib/device/devicePowerPeak';

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const PERSIST_MIN_INTERVAL_MS = 60_000;

/**
 * The write-back layer for the learned peaks, over the real `SettingsRepository`
 * and the mock Homey settings store — the layer's only outward seam. The peak
 * POLICY is unit-tested in `devicePowerPeak.test.ts`; what is under test here is
 * when a peak reaches settings, and when it must not.
 */
describe('learned power peak persistence', () => {
  let timers: TimerRegistry;
  let peaks: LearnedPeaksByDeviceId;

  const buildState = (homey: Homey.App['homey'] = mockHomeyInstance as unknown as Homey.App['homey']) => (
    createLearnedPowerPeakState({
      settingsRepository: new SettingsRepository(homey),
      getPeaks: () => peaks,
      timers,
    })
  );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    mockHomeyInstance.settings.clear();
    // A non-empty key list is the healthy case: PELS always has other settings
    // by the time this loads (the boot migrations write their marker first).
    mockHomeyInstance.settings.set('unrelated_key', true);
    timers = new TimerRegistry();
    peaks = {};
  });

  afterEach(() => {
    timers.clearAll();
    vi.useRealTimers();
  });

  it('adopts the persisted record at boot', () => {
    mockHomeyInstance.settings.set(DEVICE_POWER_PEAKS, { heater: { kw: 2, observedAtMs: NOW - 1000 } });
    const state = buildState();

    state.load();

    expect(peaks).toEqual({ heater: { kw: 2, observedAtMs: NOW - 1000 } });
  });

  it('refuses to write over a record the boot read could not see', () => {
    // The cold-boot data-loss shape: the in-memory record is empty too, so
    // "did the parse look empty?" cannot tell this from a home with no learning.
    // Only the typed read can, and an unreadable key must fence the write.
    mockHomeyInstance.settings.set(DEVICE_POWER_PEAKS, { heater: { kw: 2, observedAtMs: NOW - 1000 } });
    const throwingHomey = {
      settings: {
        get: vi.fn(() => { throw new Error('transient read failure'); }),
        getKeys: () => mockHomeyInstance.settings.getKeys(),
        set: vi.fn(),
      },
    } as unknown as Homey.App['homey'];
    const state = buildState(throwingHomey);

    state.load();
    expect(peaks).toEqual({});

    peaks.charger = { kw: 7, observedAtMs: NOW };
    state.persist();

    expect(throwingHomey.settings.set).not.toHaveBeenCalled();
    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS))
      .toEqual({ heater: { kw: 2, observedAtMs: NOW - 1000 } });
  });

  it('lifts the latch on a later successful read, merging what the run learned', () => {
    mockHomeyInstance.settings.set(DEVICE_POWER_PEAKS, { heater: { kw: 2, observedAtMs: NOW - 1000 } });
    let readable = false;
    const flakyHomey = {
      settings: {
        get: (key: string) => {
          if (!readable) throw new Error('transient read failure');
          return mockHomeyInstance.settings.get(key);
        },
        getKeys: () => mockHomeyInstance.settings.getKeys(),
        set: (key: string, value: unknown) => mockHomeyInstance.settings.set(key, value),
      },
    } as unknown as Homey.App['homey'];
    const state = buildState(flakyHomey);

    state.load();
    peaks.charger = { kw: 7, observedAtMs: NOW };
    state.persist();
    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS))
      .toEqual({ heater: { kw: 2, observedAtMs: NOW - 1000 } });

    readable = true;
    peaks.charger = { kw: 7.5, observedAtMs: NOW };
    state.persist();

    // Neither side is discarded: the heater was never observed this run, the
    // charger was only observed this run.
    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS)).toEqual({
      heater: { kw: 2, observedAtMs: NOW - 1000 },
      charger: { kw: 7.5, observedAtMs: NOW },
    });
  });

  it('writes a resolved-empty boot read like any other answer', () => {
    // A home that has never learned a peak must still be able to store its first.
    const state = buildState();
    state.load();

    peaks.heater = { kw: 2, observedAtMs: NOW };
    state.persist();

    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS)).toEqual({ heater: { kw: 2, observedAtMs: NOW } });
  });

  it('flushes a peak learned inside the rate-limit window on a trailing timer', () => {
    const state = buildState();
    state.load();

    peaks.heater = { kw: 2, observedAtMs: NOW };
    state.persist();

    // Second reading lands inside the one-minute floor. Without a trailing
    // flush it is simply dropped — nothing re-offers it.
    vi.advanceTimersByTime(10_000);
    peaks.heater = { kw: 3, observedAtMs: NOW + 10_000 };
    state.persist();
    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS)).toEqual({ heater: { kw: 2, observedAtMs: NOW } });

    vi.advanceTimersByTime(PERSIST_MIN_INTERVAL_MS);
    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS))
      .toEqual({ heater: { kw: 3, observedAtMs: NOW + 10_000 } });
  });

  it('flushes a held peak at shutdown, bypassing the rate limit', () => {
    const state = buildState();
    state.load();

    peaks.heater = { kw: 2, observedAtMs: NOW };
    state.persist();
    vi.advanceTimersByTime(5_000);
    peaks.heater = { kw: 3, observedAtMs: NOW + 5_000 };
    state.persist();

    state.flush();

    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS))
      .toEqual({ heater: { kw: 3, observedAtMs: NOW + 5_000 } });
  });

  it('retries a peak whose write threw instead of recording it as done', () => {
    // Advancing the signature before the write is what used to strand a peak
    // for good: every later identical attempt matched it and returned early.
    let failWrite = true;
    const flakyHomey = {
      settings: {
        get: (key: string) => mockHomeyInstance.settings.get(key),
        getKeys: () => mockHomeyInstance.settings.getKeys(),
        set: (key: string, value: unknown) => {
          if (failWrite) throw new Error('transient write failure');
          mockHomeyInstance.settings.set(key, value);
        },
      },
    } as unknown as Homey.App['homey'];
    const state = buildState(flakyHomey);
    state.load();

    peaks.heater = { kw: 2, observedAtMs: NOW };
    state.persist();
    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS)).toBeNull();

    failWrite = false;
    state.flush();

    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS)).toEqual({ heater: { kw: 2, observedAtMs: NOW } });
  });

  it('re-anchors a steady device in settings, not only in memory', () => {
    // A reading equal to the standing peak changes no calibration input, so the
    // seam this used to hang off never fired — and the window of the steadiest
    // devices expired in settings while memory said it was fresh.
    const state = buildState();
    state.load();
    peaks.heater = { kw: 2, observedAtMs: NOW };
    state.persist();

    vi.advanceTimersByTime(PERSIST_MIN_INTERVAL_MS);
    peaks.heater = { kw: 2, observedAtMs: NOW + PERSIST_MIN_INTERVAL_MS };
    state.persist();

    expect(mockHomeyInstance.settings.get(DEVICE_POWER_PEAKS))
      .toEqual({ heater: { kw: 2, observedAtMs: NOW + PERSIST_MIN_INTERVAL_MS } });
  });
});
