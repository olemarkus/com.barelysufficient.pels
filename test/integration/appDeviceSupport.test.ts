import type Homey from 'homey';
import { partialDouble } from '../helpers/partialDouble';
import {
  seedTemperatureShedFloorDefaults,
  isManagedFilterActive,
  persistFilledModeTargets,
  __resetModeTargetFillDedupeForTests,
} from '../../setup/appDeviceSupport';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
  PRICE_OPTIMIZATION_SETTINGS,
} from '../../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { TemperatureDiscriminantProbe } from '../../lib/plan/planTypes';
import { buildPlanInputDevice } from '../utils/planTestUtils';

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
  deviceType: 'temperature',
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
        powerCapable: true,
        capabilities: ['target_temperature'],
        targets: [{ id: 'target_temperature', value: 21, unit: '°C', min: 5, max: 35, step: 0.5 }],
      }],
      settings: asAppSettings(settings),
      debugStructured: vi.fn(),
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

describe('persistFilledModeTargets', () => {
  beforeEach(() => {
    __resetModeTargetFillDedupeForTests();
  });

  // A PLAN device, because that is what the pass takes: the control projection
  // has already run, so a device whose owner switched temperature control off
  // arrives here as a plain non-temperature device and this fixture cannot
  // express the flag at all.
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

  const baseSettings = (modeTargets: Record<string, Record<string, number>>) => makeSettings({
    [MANAGED_DEVICES]: { 't-1': true },
    [CONTROLLABLE_DEVICES]: { 't-1': true },
    mode_device_targets: modeTargets,
  });

  it('seeds missing entries from the device current setpoint', () => {
    const settings = baseSettings({ Home: {}, Away: {}, Night: {} });
    const structuredLog = vi.fn();
    const debugStructured = vi.fn();

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(settings),
      structuredLog,
      debugStructured,
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21 },
      Away: { 't-1': 21 },
      Night: { 't-1': 21 },
    });
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_target_filled',
      deviceId: 't-1',
      filledModes: ['Home', 'Away', 'Night'],
      targetC: 21,
    }));
  });

  it('does not seed a thermostat target until its per-device reading is trusted', () => {
    const settings = baseSettings({ Home: {} });
    const structuredLog = vi.fn();

    persistFilledModeTargets({
      devices: [buildUnmeteredThermostat()],
      settings: asAppSettings(settings),
      structuredLog,
      debugStructured: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
    expect(structuredLog).not.toHaveBeenCalled();
  });

  it('is a no-op when every entry is already populated', () => {
    const settings = baseSettings({ Home: { 't-1': 19 }, Away: { 't-1': 17 } });

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('only seeds the missing modes, leaving existing entries intact', () => {
    const settings = baseSettings({ Home: { 't-1': 19 }, Away: {}, Night: { 't-1': 16 } });
    const structuredLog = vi.fn();

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(settings),
      structuredLog,
      debugStructured: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 19 },
      Away: { 't-1': 21 },
      Night: { 't-1': 16 },
    });
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_target_filled',
      filledModes: ['Away'],
    }));
  });

  it('normalizes the seed value through the target capability bounds and step', () => {
    const settings = baseSettings({ Home: {} });
    // Capability step=0.5, min=5, max=35; raw current 21.34 should snap to 21.5
    const thermostat = buildThermostat({
      targets: [{ id: 'target_temperature', value: 21.34, unit: '°C', min: 5, max: 35, step: 0.5 }],
    });

    persistFilledModeTargets({
      devices: [thermostat],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21.5 },
    });
  });

  it('writes no target for a device with no usable setpoint', () => {
    const settings = baseSettings({ Home: {}, Away: {} });
    const thermostat = buildThermostat({
      targets: [{ id: 'target_temperature', value: Number.NaN, unit: '°C' }],
    });

    persistFilledModeTargets({
      devices: [thermostat],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('writes no target for a device whose temperature control is off', () => {
    // The pass has no concept of the flag. `toPlanDevice` resolved it away, so
    // the device reaches here as a plain non-temperature device — the SAME shape
    // as an on/off load, which is the point: one predicate covers both reasons a
    // device has no setpoint.
    const settings = baseSettings({ Home: {} });

    persistFilledModeTargets({
      devices: [buildThermostat({ deviceType: 'onoff', targets: [] })],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('ignores an explicitly unmanaged device and one with no setpoint', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-unmanaged': false },
      mode_device_targets: { Home: {} },
    });

    persistFilledModeTargets({
      devices: [
        buildThermostat({ id: 't-unmanaged' }),
        buildThermostat({ id: 't-notemp', deviceType: 'onoff', targets: [] }),
      ],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('seeds an implicitly managed device — the planner plans it too', () => {
    // `managed` absent is the state of every device on an install where the
    // owner never opened the Devices screen. `isRuntimePlannedDevice` is
    // `managed !== false`, so PELS plans and sheds these; requiring an explicit
    // opt-in here left them with no target to be restored to.
    const settings = makeSettings({ mode_device_targets: { Home: {} } });

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', { Home: { 't-1': 21 } });
  });

  it('seeds a device whose capacity control is off', () => {
    // A metered thermostat remains eligible for mode-target seeding even when
    // its power-limit switch is off. That switch governs shedding; it does not
    // remove the temperature target axis.
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true },
      [CONTROLLABLE_DEVICES]: { 't-1': false },
      mode_device_targets: { Home: {} },
    });

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', { Home: { 't-1': 21 } });
  });

  it('creates the default mode when the catalog has never been written', () => {
    // Main's `mode_device_targets` is only ever written by the settings UI, so
    // an owner who never opened the Modes screen had NO mode targets at all —
    // while the planner still planned their heaters and auto-assigned them a
    // setpoint shed. There has to be a mode to seed against.
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true },
      [CONTROLLABLE_DEVICES]: { 't-1': true },
    });

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', { Home: { 't-1': 21 } });
  });

  it('creates the default mode when the stored catalog is an empty object', () => {
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true },
      mode_device_targets: {},
    });

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', { Home: { 't-1': 21 } });
  });

  it('writes nothing when the catalog read cannot be trusted', () => {
    // The next act is a whole-blob `set`. A malformed payload, a thrown read,
    // and an empty key list are all states where one transient SDK miss would
    // otherwise become a wipe — decide nothing and retry next refresh.
    const malformed = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true },
      mode_device_targets: ['not', 'a', 'catalog'],
    });
    const emptyKeyList = makeSettings({ [MANAGED_DEVICES]: { 't-1': true } });
    emptyKeyList.getKeys.mockReturnValue([]);
    const throwingRead = makeSettings({ [MANAGED_DEVICES]: { 't-1': true } });
    throwingRead.get.mockImplementation((key: string) => {
      if (key === 'mode_device_targets') throw new Error('boom');
      return { 't-1': true };
    });

    [malformed, emptyKeyList, throwingRead].forEach((settings) => {
      persistFilledModeTargets({
        devices: [buildThermostat()],
        settings: asAppSettings(settings),
        structuredLog: vi.fn(),
        debugStructured: vi.fn(),
      });

      expect(settings.set).not.toHaveBeenCalled();
    });
  });

  it('preserves mode keys whose stored value is null/primitive and seeds them', () => {
    // Mimic corrupted settings where a mode key exists but its value is not a
    // plain object (e.g. legacy/import path wrote `null`). Dropping the mode
    // would silently lose user configuration on the next write.
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true },
      [CONTROLLABLE_DEVICES]: { 't-1': true },
      mode_device_targets: { Home: { 't-1': 19 }, Borte: null, Natt: 'oops' },
    });

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(settings),
      structuredLog: vi.fn(),
      debugStructured: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 19 },
      Borte: { 't-1': 21 },
      Natt: { 't-1': 21 },
    });
  });

  it('does not re-seed an entry the user cleared after we already seeded it', () => {
    // Race regression: the snapshot refresh used to re-seed any missing
    // (mode, device) entry. If the user cleared an auto-seeded entry from
    // the settings UI between refreshes, the next cycle would silently put
    // it back. Edge-trigger the seeder per (mode, deviceId) so a user-clear
    // sticks within the session.
    const initial = baseSettings({ Home: {}, Away: {} });
    const structuredLog = vi.fn();

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(initial),
      structuredLog,
      debugStructured: vi.fn(),
    });
    expect(initial.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21 },
      Away: { 't-1': 21 },
    });

    // Simulate a user-clear of the Home entry between snapshot refreshes:
    // the entry is now missing again but we've already seeded it once.
    const afterClear = baseSettings({ Home: {}, Away: { 't-1': 21 } });
    structuredLog.mockClear();

    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(afterClear),
      structuredLog,
      debugStructured: vi.fn(),
    });

    expect(afterClear.set).not.toHaveBeenCalled();
    expect(structuredLog).not.toHaveBeenCalled();
  });

  it('seeds a freshly added device whose entries have never been seeded', () => {
    // Positive case alongside the user-clear regression: a brand-new device
    // appearing mid-session (no prior fingerprint) must still be seeded on
    // the next snapshot refresh. Ensures the dedupe is keyed per device, not
    // applied process-wide.
    const settings = makeSettings({
      [MANAGED_DEVICES]: { 't-1': true, 't-new': true },
      [CONTROLLABLE_DEVICES]: { 't-1': true, 't-new': true },
      mode_device_targets: { Home: {}, Away: {} },
    });
    const structuredLog = vi.fn();

    // First pass seeds the original device, recording its fingerprints.
    persistFilledModeTargets({
      devices: [buildThermostat()],
      settings: asAppSettings(settings),
      structuredLog,
      debugStructured: vi.fn(),
    });
    settings.set.mockClear();
    structuredLog.mockClear();

    // A new device appears in the snapshot — never seeded — and must be
    // seeded normally even though the prior device's fingerprints exist.
    persistFilledModeTargets({
      devices: [
        buildThermostat(),
        buildThermostat({ id: 't-new', name: 'Bad', targets: [
          { id: 'target_temperature', value: 19, unit: '°C', min: 5, max: 35, step: 0.5 },
        ] }),
      ],
      settings: asAppSettings(settings),
      structuredLog,
      debugStructured: vi.fn(),
    });

    expect(settings.set).toHaveBeenCalledWith('mode_device_targets', {
      Home: { 't-1': 21, 't-new': 19 },
      Away: { 't-1': 21, 't-new': 19 },
    });
    expect(structuredLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_target_filled',
      deviceId: 't-new',
      filledModes: ['Home', 'Away'],
      targetC: 19,
    }));
  });
});
