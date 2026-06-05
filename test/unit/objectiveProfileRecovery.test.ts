import {
  updateDeviceObjectiveProfile,
  updateObjectiveProfilesFromSnapshot,
} from '../../lib/objectives/profiles';
import {
  RECOVERY_NO_PROGRESS_MIN_DURATION_MS,
  RECOVERY_NO_PROGRESS_SAMPLE_LIMIT,
  RECOVERY_PROGRESS_EPSILON,
  RECOVERY_PROGRESS_RESET_MULTIPLIER,
  RECOVERY_SAFETY_TIMEOUT_MS,
  SHARP_FALL_SOC_PERCENT,
  SHARP_FALL_TEMPERATURE_C,
} from '../../lib/objectives/recovery';
import type { DeviceObjectiveProfile } from '../../lib/objectives/types';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const hourMs = 60 * 60 * 1000;

const temperatureDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Water heater',
  targets: [],
  deviceType: 'temperature',
  binaryControl: { on: true },
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
  binaryControl: { on: true },
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

  it('does not disarm before the wall-clock floor during a slow legitimate refill (sub-band noise then real rise)', () => {
    // Regression for the P1 safeguard floor: with the 5-min interval gate, a
    // legitimately slow heater can emit four near-flat samples within 20 min
    // (counter reaches LIMIT) before any real rise lands. The wall-clock floor
    // (`RECOVERY_NO_PROGRESS_MIN_DURATION_MS`) must suppress disarm until the
    // armed window has been open long enough for a real rebuild to start
    // producing super-band deltas; the next genuine refill sample then resets
    // the counter and the recovery stays armed until the target is reached.
    const debugStructured = vi.fn();
    const fiveMinMs = 5 * 60 * 1000;
    const minIntervalMs = fiveMinMs;
    const subBandDelta = (RECOVERY_PROGRESS_EPSILON * RECOVERY_PROGRESS_RESET_MULTIPLIER) / 2;
    expect(minIntervalMs * (RECOVERY_NO_PROGRESS_SAMPLE_LIMIT + 1))
      .toBeLessThan(RECOVERY_NO_PROGRESS_MIN_DURATION_MS);

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
    // Sharp drop arms the window with the post-drop value as `lastSample`.
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
    const armedAtMs = profile.recoveryArmedAtMs;
    expect(armedAtMs).toBe(startMs + hourMs);

    // Five sub-band noise samples (each 5 min apart) — alternating tiny
    // positive and tiny negative deltas, all strictly inside the hysteresis
    // band so under the new gate every one of them increments the counter.
    // Total wall-clock span: 25 min < 30-min floor.
    const noiseTrack = [
      45 + subBandDelta,           // delta +subBand
      45,                          // delta -subBand
      45 + subBandDelta,           // delta +subBand
      45 - subBandDelta,           // delta -2*subBand (still inside band)
      45,                          // delta +subBand
    ];
    for (let step = 0; step < noiseTrack.length; step += 1) {
      const sampleMs = startMs + hourMs + (step + 1) * minIntervalMs;
      profile = updateDeviceObjectiveProfile({
        previous: profile,
        sample: {
          observedAtMs: sampleMs,
          value: noiseTrack[step],
          unit: 'degree_c',
          crediblePowerW: 2000,
          powerSource: 'measured',
        },
        deviceId: 'heater-1',
        debugStructured,
      });
      expect(profile.recoveryTargetValue).toBe(60);
      expect(profile.recoveryArmedAtMs).toBe(armedAtMs);
    }
    // Counter has grown past the sample limit, but the wall-clock floor (still
    // unmet at 25 min) keeps the recovery armed.
    expect(profile.recoveryNoProgressSamples).toBeGreaterThanOrEqual(
      RECOVERY_NO_PROGRESS_SAMPLE_LIMIT,
    );
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_recovery_state',
      action: 'disarm_recovery',
    }));

    // Legitimate refill arrives at +30 min (just clears the floor) with a
    // super-band positive delta: the counter resets and the window stays
    // armed for the remainder of the refill.
    const refillMs = startMs + hourMs + (noiseTrack.length + 1) * minIntervalMs;
    expect(refillMs - (armedAtMs ?? startMs)).toBeGreaterThanOrEqual(
      RECOVERY_NO_PROGRESS_MIN_DURATION_MS,
    );
    profile = updateDeviceObjectiveProfile({
      previous: profile,
      sample: {
        observedAtMs: refillMs,
        value: 47,
        unit: 'degree_c',
        crediblePowerW: 2000,
        powerSource: 'measured',
      },
      deviceId: 'heater-1',
      debugStructured,
    });
    expect(profile.recoveryTargetValue).toBe(60);
    expect(profile.recoveryArmedAtMs).toBe(armedAtMs);
    expect(profile.recoveryNoProgressSamples ?? 0).toBe(0);
  });

  it('treats sub-band positive jitter as no-progress so the counter still advances', () => {
    // Hysteresis-band regression: under the old `> EPSILON` reset rule, a tiny
    // positive noise spike (e.g. +0.02 °C with EPSILON=0.01) would reset the
    // counter even though the underlying signal is flat. With the
    // `5 * EPSILON` band, sub-band positives are treated as no-progress, so
    // the counter advances and the safeguard can do its job.
    const subBandPositive = (RECOVERY_PROGRESS_EPSILON * RECOVERY_PROGRESS_RESET_MULTIPLIER) / 2;
    expect(subBandPositive).toBeGreaterThan(RECOVERY_PROGRESS_EPSILON);
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

    // Each subsequent sample shows a tiny *positive* delta strictly inside the
    // band — old code would have reset the counter to 0 every step; new code
    // increments it.
    let lastValue = 45;
    for (let step = 0; step < RECOVERY_NO_PROGRESS_SAMPLE_LIMIT; step += 1) {
      const nextValue = lastValue + subBandPositive;
      profile = updateDeviceObjectiveProfile({
        previous: profile,
        sample: {
          observedAtMs: startMs + hourMs + (step + 1) * hourMs,
          value: nextValue,
          unit: 'degree_c',
          crediblePowerW: 2000,
          powerSource: 'measured',
        },
      });
      lastValue = nextValue;
    }
    // Counter has hit LIMIT and wall-clock is well past the floor (4h) so the
    // safeguard disarms — proving sub-band positives didn't reset it.
    expect(profile.recoveryTargetValue).toBeUndefined();
    expect(profile.recoveryArmedAtMs).toBeUndefined();
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
