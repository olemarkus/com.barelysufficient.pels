import {
  updateDeviceObjectiveProfile,
  updateObjectiveProfilesFromSnapshot,
} from '../lib/core/objectiveProfiles';
import {
  RECOVERY_NO_PROGRESS_SAMPLE_LIMIT,
  RECOVERY_SAFETY_TIMEOUT_MS,
  SHARP_FALL_SOC_PERCENT,
  SHARP_FALL_TEMPERATURE_C,
} from '../lib/core/objectiveProfileRecovery';
import type { DeviceObjectiveProfile } from '../lib/core/objectiveProfileTypes';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { TargetDeviceSnapshot } from '../lib/utils/types';

const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const hourMs = 60 * 60 * 1000;

const temperatureDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Water heater',
  targets: [],
  deviceType: 'temperature',
  currentOn: true,
  currentTemperature: 50,
  lastFreshDataMs: startMs,
  measuredPowerKw: 2,
  ...overrides,
});

const evDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'ev-1',
  name: 'Charger',
  targets: [],
  deviceClass: 'evcharger',
  currentOn: true,
  measuredPowerKw: 7,
  stateOfCharge: {
    percent: 40,
    status: 'fresh',
    observedAtMs: startMs,
  },
  ...overrides,
});

describe('objective profile recovery window', () => {
  it('arms a recovery window when a thermostat drops by the sharp-fall threshold', () => {
    const debugStructured = vi.fn();
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 55 })],
      nowMs: startMs,
      debugStructured,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 55 - SHARP_FALL_TEMPERATURE_C,
        lastFreshDataMs: startMs + hourMs,
      })],
      nowMs: startMs + hourMs,
      debugStructured,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.recoveryTargetValue).toBe(55);
    expect(profile?.recoveryArmedAtMs).toBe(startMs + hourMs);
    expect(profile?.lastSample.value).toBe(55 - SHARP_FALL_TEMPERATURE_C);
    // updatedAtMs advances with the recovery transition so pruning ordering
    // reflects the most recent device activity.
    expect(profile?.updatedAtMs).toBe(startMs + hourMs);
    expect(profile?.acceptedSamples).toBe(0);
    expect(profile?.rejectedSamples).toBe(1);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_recovery_state',
      action: 'arm_recovery',
      recoveryTargetValue: 55,
    }));
  });

  it('rejects a non-monotonic sample with the timing rejection reason instead of arming recovery', () => {
    const debugStructured = vi.fn();
    const seed = updateDeviceObjectiveProfile({
      previous: undefined,
      sample: {
        observedAtMs: startMs + hourMs,
        value: 55,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
    });
    // Out-of-order sample arrives with an earlier observedAtMs and a sharp
    // drop. Timing rejection must win — recovery state must not be armed.
    const result = updateDeviceObjectiveProfile({
      previous: seed,
      sample: {
        observedAtMs: startMs,
        value: 55 - SHARP_FALL_TEMPERATURE_C - 0.5,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
      deviceId: 'heater-1',
      debugStructured,
    });

    expect(result.recoveryTargetValue).toBeUndefined();
    expect(result.recoveryArmedAtMs).toBeUndefined();
    expect(result.lastSample.value).toBe(55);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_sample_rejected',
      reasonCode: 'objective_profile_non_monotonic_time',
    }));
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_recovery_state',
    }));
  });

  it('rejects a too-frequent sharp-drop sample with the timing rejection reason instead of arming recovery', () => {
    const debugStructured = vi.fn();
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 55 })],
      nowMs: startMs,
      debugStructured,
    });
    // Sample within OBJECTIVE_PROFILE_MIN_INTERVAL_MS (5 min) of the baseline,
    // with a sharp drop. Timing rejection wins; recovery must not arm.
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 55 - SHARP_FALL_TEMPERATURE_C - 0.5,
        lastFreshDataMs: startMs + 60 * 1000,
      })],
      nowMs: startMs + 60 * 1000,
      debugStructured,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.recoveryTargetValue).toBeUndefined();
    expect(profile?.recoveryArmedAtMs).toBeUndefined();
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_sample_rejected',
      reasonCode: 'objective_profile_interval_too_short',
    }));
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_recovery_state',
    }));
  });

  it('does not arm recovery for falls below the sharp-fall threshold', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 55 })],
      nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 55 - 0.5,
        lastFreshDataMs: startMs + hourMs,
      })],
      nowMs: startMs + hourMs,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.recoveryTargetValue).toBeUndefined();
    expect(profile?.recoveryArmedAtMs).toBeUndefined();
  });

  it('keeps the recovery window armed while the value stays below the pre-drop level', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 60 })],
      nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 45,
        lastFreshDataMs: startMs + hourMs,
        measuredPowerKw: 2,
      })],
      nowMs: startMs + hourMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 50,
        lastFreshDataMs: startMs + 2 * hourMs,
        measuredPowerKw: 2,
      })],
      nowMs: startMs + 2 * hourMs,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.recoveryTargetValue).toBe(60);
    expect(profile?.acceptedSamples).toBe(0);
    expect(profile?.rejectedSamples).toBe(2);
    expect(profile?.lastSample.value).toBe(50);
  });

  it('disarms the recovery window and accepts the next sample once the pre-drop value is reached', () => {
    const debugStructured = vi.fn();
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 60 })],
      nowMs: startMs,
      debugStructured,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 45,
        lastFreshDataMs: startMs + hourMs,
      })],
      nowMs: startMs + hourMs,
      debugStructured,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 60,
        lastFreshDataMs: startMs + 2 * hourMs,
      })],
      nowMs: startMs + 2 * hourMs,
      debugStructured,
    });
    // Next sample after disarm must be the first to update stats.
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 62,
        lastFreshDataMs: startMs + 3 * hourMs,
      })],
      nowMs: startMs + 3 * hourMs,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.recoveryTargetValue).toBeUndefined();
    expect(profile?.recoveryArmedAtMs).toBeUndefined();
    expect(profile?.acceptedSamples).toBe(1);
    expect(profile?.lastSample.value).toBe(62);
    // Disarm counts as rejected because the disarming sample is explicitly
    // excluded from learning; one initial drop + one disarm = 2 rejected.
    expect(profile?.rejectedSamples).toBe(2);
    expect(profile?.updatedAtMs).toBe(startMs + 3 * hourMs);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_recovery_state',
      action: 'disarm_recovery',
    }));
  });

  it('disarms after sustained no-progress samples instead of waiting 24h (cap-shed cooling pattern)', () => {
    // Reproduces the Connected 300 field pattern: armed at the pre-drop value,
    // device then cools *away* from the target (cap-shed cannot heat). Without
    // the forward-progress disarm, the window would stay armed for 24h.
    const debugStructured = vi.fn();
    let profile: DeviceObjectiveProfile | undefined = updateDeviceObjectiveProfile({
      previous: undefined,
      sample: {
        observedAtMs: startMs,
        value: 60.1,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
    });
    // Initial sharp drop arms the recovery window.
    profile = updateDeviceObjectiveProfile({
      previous: profile,
      sample: {
        observedAtMs: startMs + hourMs,
        value: 45.3,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
    });
    expect(profile.recoveryTargetValue).toBe(60.1);
    expect(RECOVERY_NO_PROGRESS_SAMPLE_LIMIT).toBeGreaterThanOrEqual(2);

    // Feed `RECOVERY_NO_PROGRESS_SAMPLE_LIMIT` cooling samples. Each shows a
    // non-positive delta vs the previous sample, so the no-progress counter
    // monotonically increments. The Kth sample disarms.
    const coolingTrack = [45.1, 44.9, 44.8, 44.7].slice(0, RECOVERY_NO_PROGRESS_SAMPLE_LIMIT);
    for (let step = 0; step < coolingTrack.length; step += 1) {
      profile = updateDeviceObjectiveProfile({
        previous: profile,
        sample: {
          observedAtMs: startMs + hourMs + (step + 1) * hourMs,
          value: coolingTrack[step],
          unit: 'degree_c',
          crediblePowerW: 2000,
          powerSource: 'measured',
        },
        deviceId: 'heater-1',
        debugStructured,
      });
    }

    // After the Kth cooling sample, the window disarms via no-progress.
    expect(profile.recoveryTargetValue).toBeUndefined();
    expect(profile.recoveryArmedAtMs).toBeUndefined();
    expect(profile.recoveryNoProgressSamples).toBeUndefined();
    expect(profile.lastSample.value).toBe(coolingTrack[coolingTrack.length - 1]);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_recovery_state',
      action: 'disarm_recovery',
      disarmReason: 'no_progress',
    }));

    // The next non-recovery sample is the first eligible to update stats, and
    // bands/samples buffers (if any) survive the disarm path.
    profile = updateDeviceObjectiveProfile({
      previous: profile,
      sample: {
        observedAtMs: startMs + hourMs + (coolingTrack.length + 1) * hourMs,
        value: coolingTrack[coolingTrack.length - 1] + 1.0,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
    });
    expect(profile.acceptedSamples).toBe(1);
  });

  it('keeps the recovery window armed during a slow-but-trending-up rebuild', () => {
    // Control case for the forward-progress disarm: positive but small deltas
    // must reset the no-progress counter so a real slow rebuild does not get
    // mistakenly disarmed before reaching the pre-drop target.
    let profile: DeviceObjectiveProfile | undefined = updateDeviceObjectiveProfile({
      previous: undefined,
      sample: {
        observedAtMs: startMs,
        value: 60,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
    });
    profile = updateDeviceObjectiveProfile({
      previous: profile,
      sample: {
        observedAtMs: startMs + hourMs,
        value: 45,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
    });
    expect(profile.recoveryTargetValue).toBe(60);

    // Six positive-delta samples — more than the no-progress limit — must keep
    // the window armed because each shows forward progress.
    const reheatTrack = [45.5, 46.1, 46.8, 47.4, 48.0, 48.5];
    for (let step = 0; step < reheatTrack.length; step += 1) {
      profile = updateDeviceObjectiveProfile({
        previous: profile,
        sample: {
          observedAtMs: startMs + hourMs + (step + 1) * hourMs,
          value: reheatTrack[step],
          unit: 'degree_c',
          crediblePowerW: 2000,
          powerSource: 'measured',
        },
      });
      expect(profile.recoveryTargetValue).toBe(60);
    }
    expect(profile.recoveryNoProgressSamples ?? 0).toBe(0);
  });

  it('disarms after the 24h safety timeout even when the value never recovers', () => {
    let profile: DeviceObjectiveProfile | undefined = updateDeviceObjectiveProfile({
      previous: undefined,
      sample: {
        observedAtMs: startMs,
        value: 60,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
    });
    profile = updateDeviceObjectiveProfile({
      previous: profile,
      sample: {
        observedAtMs: startMs + hourMs,
        value: 45,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
    });
    expect(profile.recoveryTargetValue).toBe(60);

    // Bridge to the safety timeout with samples below the max-interval limit
    // (6h) so the timing rejection does not intercept the recovery disarm.
    for (let step = 1; step <= 4; step += 1) {
      profile = updateDeviceObjectiveProfile({
        previous: profile,
        sample: {
          observedAtMs: startMs + hourMs + step * 5 * hourMs,
          value: 50,
          unit: 'degree_c',
          crediblePowerW: 2000,
          powerSource: 'measured',
        },
      });
      expect(profile.recoveryTargetValue).toBe(60);
    }

    // After 25h of armed-and-below, the next sample disarms via safety timeout.
    profile = updateDeviceObjectiveProfile({
      previous: profile,
      sample: {
        observedAtMs: startMs + hourMs + RECOVERY_SAFETY_TIMEOUT_MS + hourMs,
        value: 50,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
    });
    expect(profile.recoveryTargetValue).toBeUndefined();
    expect(profile.recoveryArmedAtMs).toBeUndefined();
  });

  it('does not pollute kwhPerUnit when a refill cycle is in progress', () => {
    let state: PowerTrackerState = {};
    // Establish a baseline at 60°C.
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 60, measuredPowerKw: 2 })],
      nowMs: startMs,
    });
    // Sharp drop simulating hot-water draw.
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 30,
        lastFreshDataMs: startMs + hourMs,
        measuredPowerKw: 2,
      })],
      nowMs: startMs + hourMs,
    });
    // Refill heating: temp climbs back through the band but stays below pre-drop.
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 45,
        lastFreshDataMs: startMs + 2 * hourMs,
        measuredPowerKw: 2,
      })],
      nowMs: startMs + 2 * hourMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 55,
        lastFreshDataMs: startMs + 3 * hourMs,
        measuredPowerKw: 2,
      })],
      nowMs: startMs + 3 * hourMs,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.kwhPerUnit).toBeUndefined();
    expect(profile?.acceptedSamples).toBe(0);
    expect(profile?.rejectedSamples).toBe(3);
  });
});

describe('EV charger sharp-drop handling', () => {
  it('resets baseline without arming a recovery window when SoC drops past the threshold', () => {
    const debugStructured = vi.fn();
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [evDevice({
        stateOfCharge: { percent: 80, status: 'fresh', observedAtMs: startMs },
      })],
      nowMs: startMs,
      debugStructured,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [evDevice({
        stateOfCharge: {
          percent: 80 - SHARP_FALL_SOC_PERCENT,
          status: 'fresh',
          observedAtMs: startMs + hourMs,
        },
      })],
      nowMs: startMs + hourMs,
      debugStructured,
    });

    const profile = state.objectiveProfiles?.['ev-1'];
    expect(profile?.recoveryTargetValue).toBeUndefined();
    expect(profile?.recoveryArmedAtMs).toBeUndefined();
    expect(profile?.lastSample.value).toBe(80 - SHARP_FALL_SOC_PERCENT);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_recovery_state',
      action: 'reset_baseline',
    }));

    // The next charging cycle is representative and should learn normally.
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [evDevice({
        stateOfCharge: {
          percent: 80,
          status: 'fresh',
          observedAtMs: startMs + 2 * hourMs,
        },
      })],
      nowMs: startMs + 2 * hourMs,
    });
    const afterCharge = state.objectiveProfiles?.['ev-1'];
    expect(afterCharge?.acceptedSamples).toBe(1);
    expect(afterCharge?.kwhPerUnit?.sampleCount).toBe(1);
  });
});
