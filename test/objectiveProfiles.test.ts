import {
  OBJECTIVE_PROFILE_MAX_DEVICES,
  OBJECTIVE_PROFILE_RETENTION_MS,
  updateDeviceObjectiveProfile,
  updateObjectiveProfilesFromSnapshot,
} from '../lib/objectives/profiles';
import {
  OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD,
  resetNoPowerSourceDiagnosticForTests,
} from '../lib/objectives/noPowerSourceDiagnostic';
import { resolveProfileConfidence } from '../lib/objectives/stats';
import type { DeviceObjectiveProfile } from '../lib/objectives/types';
import type { PowerTrackerState } from '../lib/power/tracker';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

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

describe('objective profiles', () => {
  it('learns compact kWh-per-degree and degree-per-hour stats for temperature devices', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice()],
      nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 52,
        lastFreshDataMs: startMs + hourMs,
        measuredPowerKw: 2,
      })],
      nowMs: startMs + hourMs,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.kind).toBe('temperature');
    expect(profile?.acceptedSamples).toBe(1);
    expect(profile?.kwhPerUnit?.mean).toBeCloseTo(1, 3);
    expect(profile?.unitPerHour?.mean).toBeCloseTo(2, 3);
    expect(profile?.lastSample.value).toBe(52);
  });

  it('retains a bounded ring buffer of recent samples for band fitting', () => {
    let profile: DeviceObjectiveProfile | undefined;
    for (let index = 0; index < 6; index += 1) {
      profile = updateDeviceObjectiveProfile({
        previous: profile,
        sample: {
          observedAtMs: startMs + index * hourMs,
          value: 50 + index,
          unit: 'degree_c',
          crediblePowerW: 1000,
          powerSource: 'measured',
        },
      });
    }

    expect(profile?.acceptedSamples).toBe(5);
    expect(profile?.kwhPerUnit?.sampleCount).toBe(5);
    expect(profile?.lastSample.value).toBe(55);
    // Five accepted rises stay below the band-fit threshold (16 samples), so
    // the buffer is populated but no bands are published yet.
    expect(profile?.samples).toHaveLength(5);
    expect(profile?.bands).toBeUndefined();
  });

  it('publishes adaptive bands once enough accepted samples accumulate', () => {
    // 19 accepted rises, with kWh/°C deliberately split: first 9 are cheap
    // (1 kWh/°C, power 1 kW per 1 °C/h step), next 10 are expensive
    // (3 kWh/°C, power 3 kW per 1 °C/h step). The fitter should publish at
    // least one band boundary inside the observed range and one band's mean
    // should be near 1 while another's is near 3.
    let profile: DeviceObjectiveProfile | undefined;
    for (let index = 0; index < 20; index += 1) {
      const isCheap = index < 10;
      profile = updateDeviceObjectiveProfile({
        previous: profile,
        sample: {
          observedAtMs: startMs + index * hourMs,
          value: 30 + index,
          unit: 'degree_c',
          crediblePowerW: isCheap ? 1000 : 3000,
          powerSource: 'measured',
        },
      });
    }

    expect(profile?.acceptedSamples).toBe(19);
    expect(profile?.samples?.length).toBe(19);
    expect(profile?.bands).toBeDefined();
    expect(profile!.bands!.length).toBeGreaterThanOrEqual(2);
    const sortedBands = [...profile!.bands!].sort((a, b) => a.lowerInclusive - b.lowerInclusive);
    expect(sortedBands[0].mean).toBeLessThan(2);
    expect(sortedBands[sortedBands.length - 1].mean).toBeGreaterThan(2);
  });

  it('emits both energyConfidence and globalEnergyConfidence, and the raw-CV value is unchanged by band-fit', () => {
    // Cause-#1 step-2 cutover: `energyConfidence` is band-aware once bands have
    // fit, while `globalEnergyConfidence` always reports the raw-CV global stat
    // so old/new log dumps stay comparable. Run a two-step multi-step heater
    // with deliberately split kWh/°C (1 kWh/°C on the cheap step, 3 kWh/°C on
    // the expensive step). Before bands fit the two fields agree; after bands
    // fit `energyConfidence` may climb while `globalEnergyConfidence` stays
    // pinned to the raw-CV verdict.
    const debugStructured = vi.fn();
    let profile: DeviceObjectiveProfile | undefined;
    for (let index = 0; index < 20; index += 1) {
      const isCheap = index < 10;
      profile = updateDeviceObjectiveProfile({
        previous: profile,
        sample: {
          observedAtMs: startMs + index * hourMs,
          value: 30 + index,
          unit: 'degree_c',
          crediblePowerW: isCheap ? 1000 : 3000,
          powerSource: 'measured',
        },
        debugStructured,
      });
    }
    expect(profile?.bands?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Every accepted sample carries both fields, never `undefined`.
    const recordedPayloads = debugStructured.mock.calls
      .map(([payload]) => payload as Record<string, unknown>)
      .filter((payload) => payload.event === 'objective_profile_sample_recorded');
    expect(recordedPayloads.length).toBeGreaterThanOrEqual(10);
    for (const payload of recordedPayloads) {
      expect(payload).toHaveProperty('energyConfidence');
      expect(payload).toHaveProperty('globalEnergyConfidence');
    }
    // Path-independence: `globalEnergyConfidence` is recomputed from
    // `{sampleCount, mean, m2}` on the live `kwhPerUnit` stat and must not be
    // perturbed by whether bands have been fit on the same sample stream.
    const lastPayload = recordedPayloads.at(-1);
    const kwhPerUnit = profile?.kwhPerUnit;
    expect(kwhPerUnit).toBeDefined();
    const expected = resolveProfileConfidence({
      sampleCount: kwhPerUnit!.sampleCount,
      mean: kwhPerUnit!.mean,
      m2: kwhPerUnit!.m2,
    });
    expect(lastPayload?.globalEnergyConfidence).toBe(expected);
  });

  it('does not update energy conversion when credible energy evidence is missing', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ measuredPowerKw: undefined })],
      nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 52,
        lastFreshDataMs: startMs + hourMs,
        measuredPowerKw: undefined,
      })],
      nowMs: startMs + hourMs,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.acceptedSamples).toBe(1);
    expect(profile?.unitPerHour?.mean).toBeCloseTo(2, 3);
    expect(profile?.kwhPerUnit).toBeUndefined();
  });

  it('uses reported stepped-load planning power as lower-confidence energy evidence', () => {
    const steppedProfile = {
      model: 'stepped_load' as const,
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1000 },
      ],
    };
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        measuredPowerKw: undefined,
        steppedLoadProfile: steppedProfile,
        reportedStepId: 'low',
      })],
      nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 51,
        lastFreshDataMs: startMs + hourMs,
        measuredPowerKw: undefined,
        steppedLoadProfile: steppedProfile,
        reportedStepId: 'low',
      })],
      nowMs: startMs + hourMs,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.kwhPerUnit?.mean).toBeCloseTo(1, 3);
    expect(profile?.lastSample.powerSource).toBe('reported_step_planning');
  });

  describe('no-power-source diagnostic', () => {
    beforeEach(() => {
      resetNoPowerSourceDiagnosticForTests();
    });

    const feedAcceptedSampleWithoutPower = (
      previous: DeviceObjectiveProfile | undefined,
      index: number,
      deviceId: string,
      debugStructured?: (payload: Record<string, unknown>) => void,
    ): DeviceObjectiveProfile => updateDeviceObjectiveProfile({
      previous,
      deviceId,
      deviceName: 'Termostat Synne',
      sample: {
        observedAtMs: startMs + index * hourMs,
        value: 30 + index,
        unit: 'degree_c',
      },
      debugStructured,
    });

    it('emits objective_profile_no_power_source once after the threshold of consecutive accepted samples without crediblePowerW', () => {
      const debugStructured = vi.fn();
      let profile: DeviceObjectiveProfile | undefined;
      // Need threshold+1 calls: the first call builds the initial profile and
      // does not go through buildAcceptedProfileSample, so only the subsequent
      // calls count toward "consecutive accepted samples".
      for (let index = 0; index < OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 1; index += 1) {
        profile = feedAcceptedSampleWithoutPower(profile, index, 'heater-1', debugStructured);
      }

      const diagnosticCalls = debugStructured.mock.calls
        .map(([payload]) => payload as Record<string, unknown>)
        .filter((payload) => payload.event === 'objective_profile_no_power_source');
      expect(diagnosticCalls).toHaveLength(1);
      expect(diagnosticCalls[0]).toMatchObject({
        event: 'objective_profile_no_power_source',
        deviceId: 'heater-1',
        deviceName: 'Termostat Synne',
        profileKind: 'temperature',
        consecutiveSamplesWithoutPower: OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD,
        threshold: OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD,
      });
      expect(profile?.acceptedSamples).toBe(OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD);
      // The band buffer never gets populated when kwhPerUnit stays unresolved.
      expect(profile?.kwhPerUnit).toBeUndefined();
      expect(profile?.bands).toBeUndefined();
    });

    it('does not re-emit objective_profile_no_power_source after additional silent samples', () => {
      const debugStructured = vi.fn();
      let profile: DeviceObjectiveProfile | undefined;
      // Cross the threshold first.
      for (let index = 0; index < OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 1; index += 1) {
        profile = feedAcceptedSampleWithoutPower(profile, index, 'heater-1', debugStructured);
      }
      const callsAfterFirstEmit = debugStructured.mock.calls
        .filter(([payload]) => (payload as Record<string, unknown>).event === 'objective_profile_no_power_source')
        .length;
      expect(callsAfterFirstEmit).toBe(1);

      // Five more silent samples should not produce a second diagnostic.
      for (let extra = 0; extra < 5; extra += 1) {
        const index = OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 1 + extra;
        profile = feedAcceptedSampleWithoutPower(profile, index, 'heater-1', debugStructured);
      }

      const diagnosticCalls = debugStructured.mock.calls
        .filter(([payload]) => (payload as Record<string, unknown>).event === 'objective_profile_no_power_source')
        .length;
      expect(diagnosticCalls).toBe(1);
    });

    it('resets the counter when a valid crediblePowerW arrives but does not re-emit once already fired', () => {
      const debugStructured = vi.fn();
      let profile: DeviceObjectiveProfile | undefined;
      for (let index = 0; index < OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 1; index += 1) {
        profile = feedAcceptedSampleWithoutPower(profile, index, 'heater-1', debugStructured);
      }
      expect(debugStructured.mock.calls
        .filter(([payload]) => (payload as Record<string, unknown>).event === 'objective_profile_no_power_source')
        .length).toBe(1);

      // A sample with valid crediblePowerW resets the counter but the one-shot
      // flag persists, so even another OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD
      // silent samples cannot produce a second diagnostic. The diagnostic tracks
      // the sample's *own* `crediblePowerW` (the next window's left-edge power),
      // not the closed window's `kwhPerUnit`, so a single valid sample is enough
      // to reset the counter — even though the just-closed window still bills at
      // the silent baseline and therefore yields `kwhPerUnit = undefined`.
      profile = updateDeviceObjectiveProfile({
        previous: profile,
        deviceId: 'heater-1',
        deviceName: 'Termostat Synne',
        sample: {
          observedAtMs: startMs + (OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 1) * hourMs,
          value: 30 + OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 1,
          unit: 'degree_c',
          crediblePowerW: 1000,
          powerSource: 'measured',
        },
        debugStructured,
      });

      for (let extra = 0; extra < OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 1; extra += 1) {
        const index = OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 2 + extra;
        profile = feedAcceptedSampleWithoutPower(profile, index, 'heater-1', debugStructured);
      }
      expect(debugStructured.mock.calls
        .filter(([payload]) => (payload as Record<string, unknown>).event === 'objective_profile_no_power_source')
        .length).toBe(1);
    });

    it('does not fire the diagnostic when crediblePowerW is always resolved', () => {
      const debugStructured = vi.fn();
      let profile: DeviceObjectiveProfile | undefined;
      for (let index = 0; index < OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 5; index += 1) {
        profile = updateDeviceObjectiveProfile({
          previous: profile,
          deviceId: 'heater-1',
          sample: {
            observedAtMs: startMs + index * hourMs,
            value: 30 + index,
            unit: 'degree_c',
            crediblePowerW: 1000,
            powerSource: 'measured',
          },
          debugStructured,
        });
      }
      expect(debugStructured.mock.calls
        .filter(([payload]) => (payload as Record<string, unknown>).event === 'objective_profile_no_power_source')
        .length).toBe(0);
    });

    it('tracks counters per device independently', () => {
      const debugStructured = vi.fn();
      let profileA: DeviceObjectiveProfile | undefined;
      let profileB: DeviceObjectiveProfile | undefined;
      for (let index = 0; index < OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD + 1; index += 1) {
        profileA = feedAcceptedSampleWithoutPower(profileA, index, 'heater-A', debugStructured);
        profileB = feedAcceptedSampleWithoutPower(profileB, index, 'heater-B', debugStructured);
      }
      const diagnosticDeviceIds = debugStructured.mock.calls
        .map(([payload]) => payload as Record<string, unknown>)
        .filter((payload) => payload.event === 'objective_profile_no_power_source')
        .map((payload) => payload.deviceId);
      expect(diagnosticDeviceIds.sort()).toEqual(['heater-A', 'heater-B']);
    });
  });

  it('ignores stale temperature observations', () => {
    const state = updateObjectiveProfilesFromSnapshot({
      state: {},
      devices: [temperatureDevice({
        lastFreshDataMs: startMs - 31 * 60 * 1000,
      })],
      nowMs: startMs,
    });

    expect(state.objectiveProfiles).toBeUndefined();
  });

  it('ignores future-dated temperature observations', () => {
    const state = updateObjectiveProfilesFromSnapshot({
      state: {},
      devices: [temperatureDevice({
        lastFreshDataMs: startMs + 10 * 1000,
      })],
      nowMs: startMs,
    });

    expect(state.objectiveProfiles).toBeUndefined();
  });

  it('rejects small falling temperature samples and reseeds the baseline so future rises measure from the new low', () => {
    const debugStructured = vi.fn();
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 52 })],
      nowMs: startMs,
      debugStructured,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 51.5,
        lastFreshDataMs: startMs + hourMs,
      })],
      nowMs: startMs + hourMs,
      debugStructured,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.acceptedSamples).toBe(0);
    expect(profile?.rejectedSamples).toBe(1);
    expect(profile?.kwhPerUnit).toBeUndefined();
    // Baseline now tracks the post-fall low so the next rise computes a fresh
    // delta instead of inflating the kWh-per-degree calculation against a
    // stale pre-drop value.
    expect(profile?.lastSample.value).toBe(51.5);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_sample_rejected',
      reasonCode: 'objective_profile_value_fell',
    }));
  });

  it('does not emit one routine rejection log per device in the same pass', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2027, 0, 1, 0, 0, 0));
    try {
      const debugStructured = vi.fn();
      const previousState = updateObjectiveProfilesFromSnapshot({
        state: {},
        devices: [
          temperatureDevice({ id: 'heater-1', currentTemperature: 52 }),
          temperatureDevice({ id: 'heater-2', currentTemperature: 52 }),
        ],
        nowMs: startMs,
      });

      updateObjectiveProfilesFromSnapshot({
        state: previousState,
        devices: [
          temperatureDevice({
            id: 'heater-1',
            currentTemperature: 51.5,
            lastFreshDataMs: startMs + hourMs,
          }),
          temperatureDevice({
            id: 'heater-2',
            currentTemperature: 51.5,
            lastFreshDataMs: startMs + hourMs,
          }),
        ],
        nowMs: startMs + hourMs,
        debugStructured,
      });

      expect(debugStructured).toHaveBeenCalledTimes(1);
      expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
        event: 'objective_profile_sample_rejected',
        reasonCode: 'objective_profile_value_fell',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the accepted baseline after too-frequent samples so later readings can be accepted', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 50 })],
      nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 51,
        lastFreshDataMs: startMs + 60 * 1000,
      })],
      nowMs: startMs + 60 * 1000,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 52,
        lastFreshDataMs: startMs + 10 * 60 * 1000,
      })],
      nowMs: startMs + 10 * 60 * 1000,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.acceptedSamples).toBe(1);
    expect(profile?.rejectedSamples).toBe(1);
    expect(profile?.lastSample.value).toBe(52);
    expect(profile?.unitPerHour?.mean).toBeCloseTo(12, 3);
  });

  it('keeps the accepted baseline after small rises so cumulative progress can be accepted', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 50 })],
      nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 50.1,
        lastFreshDataMs: startMs + 30 * 60 * 1000,
      })],
      nowMs: startMs + 30 * 60 * 1000,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 50.5,
        lastFreshDataMs: startMs + hourMs,
      })],
      nowMs: startMs + hourMs,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.acceptedSamples).toBe(1);
    expect(profile?.rejectedSamples).toBe(1);
    expect(profile?.lastSample.value).toBe(50.5);
    expect(profile?.unitPerHour?.mean).toBeCloseTo(0.5, 3);
  });

  it('reseeds the baseline after an overlong sample gap so future samples can be accepted', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 50 })],
      nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 55,
        lastFreshDataMs: startMs + 7 * hourMs,
      })],
      nowMs: startMs + 7 * hourMs,
    });

    let profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.acceptedSamples).toBe(0);
    expect(profile?.rejectedSamples).toBe(1);
    expect(profile?.lastSample.value).toBe(55);
    expect(profile?.updatedAtMs).toBe(startMs + 7 * hourMs);

    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 56,
        lastFreshDataMs: startMs + 8 * hourMs,
      })],
      nowMs: startMs + 8 * hourMs,
    });

    profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.acceptedSamples).toBe(1);
    expect(profile?.rejectedSamples).toBe(1);
    expect(profile?.lastSample.value).toBe(56);
    expect(profile?.unitPerHour?.mean).toBeCloseTo(1, 3);
  });

  it('learns kWh-per-percent for EVs only from fresh SoC with credible power evidence', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [evDevice()],
      nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [evDevice({
        stateOfCharge: {
          percent: 50,
          status: 'fresh',
          observedAtMs: startMs + hourMs,
        },
      })],
      nowMs: startMs + hourMs,
    });

    const profile = state.objectiveProfiles?.['ev-1'];
    expect(profile?.kind).toBe('ev_soc');
    expect(profile?.acceptedSamples).toBe(1);
    expect(profile?.kwhPerUnit?.mean).toBeCloseTo(0.7, 3);
    expect(profile?.unitPerHour?.mean).toBeCloseTo(10, 3);
  });

  it('ignores stale EV SoC samples', () => {
    const state = updateObjectiveProfilesFromSnapshot({
      state: {},
      devices: [evDevice({
        stateOfCharge: {
          percent: 40,
          status: 'stale',
          observedAtMs: startMs,
        },
      })],
      nowMs: startMs,
    });

    expect(state.objectiveProfiles).toBeUndefined();
  });

  it('ignores future-dated EV SoC samples', () => {
    const state = updateObjectiveProfilesFromSnapshot({
      state: {},
      devices: [evDevice({
        stateOfCharge: {
          percent: 40,
          status: 'fresh',
          observedAtMs: startMs + 10 * 1000,
        },
      })],
      nowMs: startMs,
    });

    expect(state.objectiveProfiles).toBeUndefined();
  });

  it('bounds retained device profiles to protect persisted size and RSS', () => {
    const profiles: NonNullable<PowerTrackerState['objectiveProfiles']> = {};
    for (let index = 0; index < OBJECTIVE_PROFILE_MAX_DEVICES + 10; index += 1) {
      profiles[`dev-${index}`] = updateDeviceObjectiveProfile({
        sample: {
          observedAtMs: startMs + index,
          value: 50,
          unit: 'degree_c',
        },
      });
    }

    const state = updateObjectiveProfilesFromSnapshot({
      state: { objectiveProfiles: profiles },
      devices: [],
      nowMs: startMs + hourMs,
    });

    expect(Object.keys(state.objectiveProfiles ?? {})).toHaveLength(OBJECTIVE_PROFILE_MAX_DEVICES);
  });

  it('prunes expired profiles even when no new samples are recorded', () => {
    const retained = updateDeviceObjectiveProfile({
      sample: {
        observedAtMs: startMs,
        value: 50,
        unit: 'degree_c',
      },
    });
    const expired = updateDeviceObjectiveProfile({
      sample: {
        observedAtMs: startMs - OBJECTIVE_PROFILE_RETENTION_MS - 1,
        value: 50,
        unit: 'degree_c',
      },
    });

    const state = updateObjectiveProfilesFromSnapshot({
      state: {
        objectiveProfiles: {
          retained,
          expired,
        },
      },
      devices: [],
      nowMs: startMs,
    });

    expect(Object.keys(state.objectiveProfiles ?? {})).toEqual(['retained']);
  });

  // `resolveLastFreshDataMs` takes `Math.max(...)` over several capability
  // `lastUpdated` timestamps, so a no-op snapshot rebuild from an unrelated
  // capability update can produce a sample whose `value` is unchanged and
  // whose `observedAtMs` is either identical to (`intervalMs === 0`) or a few
  // ms below (`intervalMs ∈ {-2, -4}`) the stored baseline. Those duplicates
  // carry no learning signal — drop them silently so they don't burn the
  // per-device 15-minute rejection-throttle window on real same-reason
  // rejections or inflate the per-device `rejectedSamples` counter.
  describe('non_monotonic_time suppression for unchanged-value duplicates', () => {
    const seedSample = {
      observedAtMs: startMs + hourMs,
      value: 55,
      unit: 'degree_c',
      crediblePowerW: 2000,
      powerSource: 'measured',
    } as const;

    it('suppresses non_monotonic_time rejection on exact (observedAtMs, value) duplicates', () => {
      const debugStructured = vi.fn();
      const seed = updateDeviceObjectiveProfile({
        previous: undefined,
        sample: seedSample,
      });
      debugStructured.mockClear();
      const result = updateDeviceObjectiveProfile({
        previous: seed,
        sample: { ...seedSample },
        deviceId: 'heater-1',
        debugStructured,
      });

      expect(result).toBe(seed);
      expect(result.rejectedSamples).toBe(seed.rejectedSamples);
      expect(debugStructured).not.toHaveBeenCalled();
    });

    it('suppresses non_monotonic_time rejection when observedAtMs slips backwards but value is unchanged', () => {
      const debugStructured = vi.fn();
      const seed = updateDeviceObjectiveProfile({
        previous: undefined,
        sample: seedSample,
      });
      debugStructured.mockClear();
      const result = updateDeviceObjectiveProfile({
        previous: seed,
        // `intervalMs === -4`: a capability aged out of the `Math.max` floor
        // and the next-newest `lastUpdated` is a few ms older.
        sample: { ...seedSample, observedAtMs: seedSample.observedAtMs - 4 },
        deviceId: 'heater-1',
        debugStructured,
      });

      expect(result).toBe(seed);
      expect(result.rejectedSamples).toBe(seed.rejectedSamples);
      expect(debugStructured).not.toHaveBeenCalled();
    });

    it('still emits non_monotonic_time rejection when observedAtMs slips backwards and value changed', () => {
      const debugStructured = vi.fn();
      const seed = updateDeviceObjectiveProfile({
        previous: undefined,
        sample: seedSample,
      });
      debugStructured.mockClear();
      const result = updateDeviceObjectiveProfile({
        previous: seed,
        // Same `intervalMs === -4` but the value moved, so the suppression
        // must not swallow the rejection.
        sample: {
          ...seedSample,
          observedAtMs: seedSample.observedAtMs - 4,
          value: seedSample.value + 0.3,
        },
        deviceId: 'heater-1',
        debugStructured,
      });

      expect(result.rejectedSamples).toBe(seed.rejectedSamples + 1);
      expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
        event: 'objective_profile_sample_rejected',
        reasonCode: 'objective_profile_non_monotonic_time',
      }));
    });
  });
});
