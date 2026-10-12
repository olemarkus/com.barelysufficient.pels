import type { ObjectiveObservedQuantity } from '../../packages/shared-domain/src/objectiveObservedQuantity';
import { withResolvedCurrentDraw } from '../utils/objectiveSampleDevice';
import {
  updateDeviceObjectiveProfile,
  updateObjectiveProfilesFromSnapshot,
} from '../../lib/objectives/profiles';
import type { DeviceObjectiveProfileSample } from '../../lib/objectives/types';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { MeasuredPowerObservedProbe, TargetDeviceSnapshot, TemperatureObservedProbe, ThermalDirection } from '../../packages/contracts/src/types';

const startMs = Date.UTC(2026, 0, 10, 10, 0, 0);
const HALF_HOUR_MS = 30 * 60 * 1000;

const sampleAt = (observedAtMs: number, value: number): DeviceObjectiveProfileSample => ({
  observedAtMs,
  value,
  crediblePowerW: 2000,
});

type TemperatureDeviceOverrides = Partial<TargetDeviceSnapshot & TemperatureObservedProbe
  & MeasuredPowerObservedProbe> & { currentTemperature?: number; thermalDirection?: ThermalDirection };

const temperatureDevice = (overrides: TemperatureDeviceOverrides = {}): TargetDeviceSnapshot & TemperatureObservedProbe & MeasuredPowerObservedProbe & { currentDrawKw: number; observedQuantity: ObjectiveObservedQuantity; thermalDirection: ThermalDirection } => {
  const { currentTemperature = 50, ...rest } = overrides;
  const target = { id: 'target_temperature' as const, value: 55, unit: '°C' };
  return withResolvedCurrentDraw({
  available: true,
  id: 'heater-1',
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Water heater',
  targets: [target],
  deviceClass: 'thermostat',
  deviceType: 'temperature',
  isEvCharger: false,
  isBatteryOrSolar: false,
  binaryControllable: true,
  managed: true,
  binaryControl: { on: true },
  temperature: { currentTemperature, target },
  lastFreshDataMs: startMs,
  measuredPowerKw: 2,
  ...rest,
  });
};

describe('objective profile outdoor-temperature covariate', () => {
  it('stamps outdoorTemperatureC on the recorded observation when provided', () => {
    const initial = updateDeviceObjectiveProfile(undefined, sampleAt(startMs, 50), 'dev', 'Device', () => undefined, undefined);
    const updated = updateDeviceObjectiveProfile(
      initial,
      sampleAt(startMs + HALF_HOUR_MS, 51),
      'dev',
      'Device',
      () => undefined,
      -5.5,
    );
    expect(updated.samples).toHaveLength(1);
    expect(updated.samples?.[0]).toMatchObject({
      inputValue: 50.5,
      kwhPerUnit: 1,
      outdoorTemperatureC: -5.5,
    });
  });

  it('omits the field entirely when no outdoor temperature is available', () => {
    const initial = updateDeviceObjectiveProfile(undefined, sampleAt(startMs, 50), 'dev', 'Device', () => undefined, undefined);
    const updated = updateDeviceObjectiveProfile(
      initial,
      sampleAt(startMs + HALF_HOUR_MS, 51),
      'dev',
      'Device',
      () => undefined,
      undefined,
    );
    expect(updated.samples).toHaveLength(1);
    expect('outdoorTemperatureC' in (updated.samples?.[0] ?? {})).toBe(false);
  });

  it('threads the covariate through the snapshot-level update', () => {
    let state: PowerTrackerState = {};
    state = updateObjectiveProfilesFromSnapshot(state, [temperatureDevice()], startMs, () => undefined, undefined);
    state = updateObjectiveProfilesFromSnapshot(
      state,
      [temperatureDevice({ currentTemperature: 51, lastFreshDataMs: startMs + HALF_HOUR_MS })],
      startMs + HALF_HOUR_MS,
      () => undefined,
      -8,
    );
    expect(state.objectiveProfiles?.['heater-1']?.samples?.[0]?.outdoorTemperatureC).toBe(-8);
  });
});
