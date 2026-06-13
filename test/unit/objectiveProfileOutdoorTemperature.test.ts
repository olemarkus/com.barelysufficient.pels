import {
  updateDeviceObjectiveProfile,
  updateObjectiveProfilesFromSnapshot,
} from '../../lib/objectives/profiles';
import type { DeviceObjectiveProfileSample } from '../../lib/objectives/types';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { TargetDeviceSnapshot, TemperatureObservedProbe } from '../../packages/contracts/src/types';

const startMs = Date.UTC(2026, 0, 10, 10, 0, 0);
const HALF_HOUR_MS = 30 * 60 * 1000;

const sampleAt = (observedAtMs: number, value: number): DeviceObjectiveProfileSample => ({
  observedAtMs,
  value,
  unit: 'degree_c',
  crediblePowerW: 2000,
  powerSource: 'measured',
});

const temperatureDevice = (overrides: Partial<TargetDeviceSnapshot & TemperatureObservedProbe> = {}): TargetDeviceSnapshot & TemperatureObservedProbe => ({
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

describe('objective profile outdoor-temperature covariate', () => {
  it('stamps outdoorTemperatureC on the recorded observation when provided', () => {
    const initial = updateDeviceObjectiveProfile({ sample: sampleAt(startMs, 50) });
    const updated = updateDeviceObjectiveProfile({
      previous: initial,
      sample: sampleAt(startMs + HALF_HOUR_MS, 51),
      outdoorTemperatureC: -5.5,
    });
    expect(updated.samples).toHaveLength(1);
    expect(updated.samples?.[0]).toMatchObject({
      inputValue: 50.5,
      kwhPerUnit: 1,
      outdoorTemperatureC: -5.5,
    });
  });

  it('omits the field entirely when no outdoor temperature is available', () => {
    const initial = updateDeviceObjectiveProfile({ sample: sampleAt(startMs, 50) });
    const updated = updateDeviceObjectiveProfile({
      previous: initial,
      sample: sampleAt(startMs + HALF_HOUR_MS, 51),
    });
    expect(updated.samples).toHaveLength(1);
    expect('outdoorTemperatureC' in (updated.samples?.[0] ?? {})).toBe(false);
  });

  it('threads the covariate through the snapshot-level update', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot({
      state, devices: [temperatureDevice()], nowMs: startMs,
    });
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({ currentTemperature: 51, lastFreshDataMs: startMs + HALF_HOUR_MS })],
      nowMs: startMs + HALF_HOUR_MS,
      outdoorTemperatureC: -8,
    });
    expect(state.objectiveProfiles?.['heater-1']?.samples?.[0]?.outdoorTemperatureC).toBe(-8);
  });
});
