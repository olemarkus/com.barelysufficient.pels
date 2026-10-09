import type Homey from 'homey';
import { partialDouble } from '../helpers/partialDouble';
import {
  seedTemperatureShedFloorDefaults,
  isManagedFilterActive,
  listModeTargetFillDevices,
  type ResolveOperatingModeForDevice,
} from '../../setup/appDeviceSupport';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  MAIN_HOME_ID,
  OPERATING_MODE_SETTING,
  PRICE_OPTIMIZATION_SETTINGS,
} from '../../lib/utils/settingsKeys';

// The main home's mode, as production's resolver reports it for a main-home device.
const mainHomeMode = (mode: string | null): ResolveOperatingModeForDevice => () => ({
  state: 'resolved',
  mode,
  homeId: MAIN_HOME_ID,
  catalogHomeId: MAIN_HOME_ID,
});
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { TemperatureDiscriminantProbe } from '../../lib/plan/planTypes';
import { buildPlanInputDevice, fixtureControlPosture } from '../utils/planTestUtils';

type AppSettings = Homey.App['homey']['settings'];
// Passes the mock store across the production seam with its provided members
// typechecked against the real settings manager.
const asAppSettings = (s: { get: unknown; getKeys: unknown; set: unknown }): AppSettings => partialDouble<AppSettings>({
  get: s.get as AppSettings['get'],
  getKeys: s.getKeys as AppSettings['getKeys'],
  set: s.set as AppSettings['set'],
});

const makeSettings = (initial: Record<string, unknown>) => {
  const store: Record<string, unknown> = { ...initial };
  return {
    get: vi.fn((key: string) => store[key]),
    // The real SDK exposes the key list, and the seeder uses it to tell a
    // never-written catalog from a transiently-empty read.
    getKeys: vi.fn(() => Object.keys(store)),
    set: vi.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
  };
};

const buildUnsupportedThermostat = (): TargetDeviceSnapshot => ({ available: true, expectedPowerKw: 1, expectedPowerSource: 'default',
  id: 'vt-1',
  name: 'VThermo',
  deviceClass: 'thermostat',
  deviceType: 'temperature',
  isEvCharger: false,
  isBatteryOrSolar: false,
  binaryControllable: false,
  powerCapable: false,
  targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
});

describe('seedTemperatureShedFloorDefaults', () => {
  it('does not write when the owner already opted out', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 'vt-1': false },
      [CONTROLLABLE_DEVICES]: { 'vt-1': false },
      [PRICE_OPTIMIZATION_SETTINGS]: {
        'vt-1': { enabled: false, cheapDelta: 5, expensiveDelta: -5 },
      },
    });
    const debugStructured = vi.fn();

    seedTemperatureShedFloorDefaults({
      snapshot: [buildUnsupportedThermostat()],
      settings: asAppSettings(settings),
      debugStructured,
      resolveOperatingModeForDevice: mainHomeMode(null),
    });

    expect(settings.set).not.toHaveBeenCalled();
    expect(debugStructured).not.toHaveBeenCalled();
  });

  it('seeds the shed floor when the active mode is stored malformed', () => {
    // Regression: this path parsed `mode_device_targets` itself and read a
    // malformed mode as `unavailable`, so the seed was skipped — a third policy
    // for one key. Through the key's owner a malformed mode is an EMPTY mode,
    // so the target reads as absent and the default is derived as usual.
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 'panel-1': true },
      [CONTROLLABLE_DEVICES]: { 'panel-1': true },
      [OPERATING_MODE_SETTING]: 'Home',
      mode_device_targets: { Home: null },
    });

    seedTemperatureShedFloorDefaults({
      snapshot: [{
        available: true,
        expectedPowerKw: 1,
        expectedPowerSource: 'default',
        id: 'panel-1',
        name: 'Panel heater',
        deviceType: 'temperature',
        deviceClass: 'heater',
        isEvCharger: false,
        isBatteryOrSolar: false,
        binaryControllable: false,
        powerCapable: true,
        capabilities: ['target_temperature'],
        targets: [{ id: 'target_temperature', value: 21, unit: '°C', min: 5, max: 35, step: 0.5 }],
      }],
      settings: asAppSettings(settings),
      debugStructured: vi.fn(),
      resolveOperatingModeForDevice: mainHomeMode('Home'),
    });

    expect(settings.set).toHaveBeenCalledWith('overshoot_behaviors', expect.objectContaining({
      'panel-1': expect.objectContaining({ action: 'set_temperature' }),
    }));
  });

  it('preserves owner settings when a snapshot has no power evidence', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 'vt-1': true },
      [CONTROLLABLE_DEVICES]: { 'vt-1': true },
      [PRICE_OPTIMIZATION_SETTINGS]: {
        'vt-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
      },
    });
    const debugStructured = vi.fn();

    seedTemperatureShedFloorDefaults({
      snapshot: [buildUnsupportedThermostat()],
      settings: asAppSettings(settings),
      debugStructured,
      resolveOperatingModeForDevice: mainHomeMode(null),
    });

    expect(settings.set).not.toHaveBeenCalled();
    expect(debugStructured).not.toHaveBeenCalled();
  });

  it('keeps managed intent for a live-report-only device until its first reading', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 'vt-1': true },
      [CONTROLLABLE_DEVICES]: { 'vt-1': true },
      [PRICE_OPTIMIZATION_SETTINGS]: {
        'vt-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
      },
    });
    const debugStructured = vi.fn();

    seedTemperatureShedFloorDefaults({
      snapshot: [buildUnsupportedThermostat()],
      settings: asAppSettings(settings),
      debugStructured,
      resolveOperatingModeForDevice: mainHomeMode(null),
    });

    expect(settings.set).not.toHaveBeenCalled();
    expect(debugStructured).not.toHaveBeenCalled();
  });
});

describe('isManagedFilterActive', () => {
  it('reports inactive for an empty managed map', () => {
    expect(isManagedFilterActive({})).toBe(false);
  });

  it('reports inactive for an all-false managed map', () => {
    // Explicit opt-outs alone must not switch the runtime to the explicit-only
    // managed set; devices with no key remain implicitly managed.
    expect(isManagedFilterActive({ 'vt-1': false, 'socket-1': false })).toBe(false);
  });

  it('reports active when at least one device is explicitly enabled', () => {
    expect(isManagedFilterActive({ 'ev1': true })).toBe(true);
    expect(isManagedFilterActive({ 'ev1': true, 'vt-1': false })).toBe(true);
  });
});

describe('listModeTargetFillDevices', () => {
  // PLAN devices, because that is what the projection takes: the control
  // projection has already run, so a device whose owner switched temperature
  // control off arrives here as a plain non-temperature device and this fixture
  // cannot express the flag at all. The fill itself is
  // `lib/home/modeDeviceTargetFill.ts` (`modeDeviceTargetFill.test.ts`).
  const thermostatDefaults = {
    id: 't-1',
    name: 'Stue',
    deviceType: 'temperature' as const,
    currentTarget: 21,
    currentTemperature: 21,
    targets: [{ id: 'target_temperature', value: 21, unit: '°C', min: 5, max: 35, step: 0.5 }],
    currentDrawKw: 1,
  };
  const buildThermostat = (
    overrides: Partial<PlanInputDevice> & TemperatureDiscriminantProbe = {},
  ): PlanInputDevice => buildPlanInputDevice({ ...thermostatDefaults, ...overrides });
  const buildUnmeteredThermostat = (): PlanInputDevice => (
    buildPlanInputDevice({ ...thermostatDefaults, unmetered: true })
  );

  it('lists a planned thermostat with the setpoint PELS holds it at', () => {
    expect(listModeTargetFillDevices([buildThermostat()]))
      .toEqual([{ id: 't-1', name: 'Stue', heldSetpointC: 21 }]);
  });

  it('lists a thermostat without a per-device reading, since the plan still sets its mode target', () => {
    expect(listModeTargetFillDevices([buildUnmeteredThermostat()]))
      .toEqual([{ id: 't-1', name: 'Stue', heldSetpointC: 21 }]);
  });

  it('normalizes the held setpoint through the target capability bounds and step', () => {
    // Capability step=0.5, min=5, max=35; raw current 21.34 should snap to 21.5
    const thermostat = buildThermostat({
      targets: [{ id: 'target_temperature', value: 21.34, unit: '°C', min: 5, max: 35, step: 0.5 }],
    });

    expect(listModeTargetFillDevices([thermostat]))
      .toEqual([{ id: 't-1', name: 'Stue', heldSetpointC: 21.5 }]);
  });

  it('lists no device with no usable setpoint', () => {
    const thermostat = buildThermostat({
      targets: [{ id: 'target_temperature', value: Number.NaN, unit: '°C' }],
    });

    expect(listModeTargetFillDevices([thermostat])).toEqual([]);
  });

  it('lists no device whose temperature control is off', () => {
    // The projection has no concept of the flag. `toPlanDevice` resolved it
    // away, so the device reaches here as a plain non-temperature device — the
    // SAME shape as an on/off load, which is the point: one predicate covers
    // both reasons a device has no setpoint.
    expect(listModeTargetFillDevices([buildThermostat({ deviceType: 'onoff', targets: [] })])).toEqual([]);
  });

  it('ignores a device the planner does not plan and one with no setpoint', () => {
    // `control.managed` is the planner's own answer: `managed_devices` resolved
    // per device, where a device with no entry is not managed. Filling a target
    // for it would seed a setpoint PELS does not hold.
    expect(listModeTargetFillDevices([
      buildThermostat({ id: 't-unmanaged', control: fixtureControlPosture({ managed: false }) }),
      buildThermostat({ id: 't-notemp', deviceType: 'onoff', targets: [] }),
    ])).toEqual([]);
  });

  it('lists a device whose capacity control is off', () => {
    // A metered thermostat remains eligible for mode-target filling even when
    // its power-limit switch is off. That switch governs shedding; it does not
    // remove the temperature target axis.
    expect(listModeTargetFillDevices([buildThermostat({ control: fixtureControlPosture({ controllable: false }) })]))
      .toEqual([{ id: 't-1', name: 'Stue', heldSetpointC: 21 }]);
  });
});
