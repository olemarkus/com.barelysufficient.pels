import {
  CAPACITY_PRIORITIES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  EV_BOOST_SETTINGS,
  MODE_DEVICE_TARGETS,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
} from '../../contracts/src/settingsKeys.ts';
import { createHomeyMock } from './helpers/homeyApiMock.ts';

const DEVICE_ID = 'heater-1';
const KEEP_ID = 'heater-2';
const CONTROL_PROFILE = {
  model: 'stepped_load' as const,
  steps: [{ id: 'off', planningPowerW: 0 }],
};

const perDeviceMap = <T>(value: T): Record<string, T> => ({
  [DEVICE_ID]: value,
  [KEEP_ID]: value,
});

describe('advanced device data purge', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reconciles every affected map after a partial write failure before retrying', async () => {
    const settings = {
      controllable_devices: perDeviceMap(true),
      managed_devices: perDeviceMap(true),
      [DEVICE_CONTROL_PROFILES]: perDeviceMap(CONTROL_PROFILE),
      [DEVICE_TARGET_POWER_CONFIGS]: perDeviceMap({ targetPowerW: 1_000 }),
      [OVERSHOOT_BEHAVIORS]: perDeviceMap({ action: 'turn_off' }),
      [TEMPERATURE_BOOST_SETTINGS]: perDeviceMap({ enabled: true }),
      [EV_BOOST_SETTINGS]: perDeviceMap({ enabled: true }),
      price_optimization_settings: perDeviceMap({ enabled: true }),
      [TEMPERATURE_CONTROL_DISABLED_DEVICES]: perDeviceMap(true),
      [CAPACITY_PRIORITIES]: { Home: { [DEVICE_ID]: 1, [KEEP_ID]: 2 } },
      [MODE_DEVICE_TARGETS]: { Home: { [DEVICE_ID]: 20, [KEEP_ID]: 21 } },
    };
    const homey = createHomeyMock({ settings });
    const originalSet = homey.set.getMockImplementation();
    let failTemperatureControlWrite = true;
    homey.set.mockImplementation((key, value, callback) => {
      if (key === TEMPERATURE_CONTROL_DISABLED_DEVICES && failTemperatureControlWrite) {
        failTemperatureControlWrite = false;
        callback?.(new Error('write failed'));
        return;
      }
      originalSet?.(key, value, callback);
    });
    const originalGet = homey.get.getMockImplementation();
    let returnTransientNull = true;
    homey.get.mockImplementation((key, callback) => {
      if (key === 'managed_devices' && returnTransientNull) {
        returnTransientNull = false;
        callback(null, null);
        return;
      }
      originalGet?.(key, callback);
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    state.controllableMap = perDeviceMap(true);
    state.managedMap = perDeviceMap(true);
    state.deviceControlProfiles = perDeviceMap(CONTROL_PROFILE);
    state.deviceTargetPowerConfigs = perDeviceMap({ targetPowerW: 1_000 }) as typeof state.deviceTargetPowerConfigs;
    state.shedBehaviors = perDeviceMap({ action: 'turn_off' }) as typeof state.shedBehaviors;
    state.temperatureBoostSettings = perDeviceMap({ enabled: true }) as typeof state.temperatureBoostSettings;
    state.evBoostSettings = perDeviceMap({ enabled: true }) as typeof state.evBoostSettings;
    state.priceOptimizationSettings = perDeviceMap({ enabled: true }) as typeof state.priceOptimizationSettings;
    state.temperatureControlDisabledMap = perDeviceMap(true);
    state.capacityPriorities = settings[CAPACITY_PRIORITIES];
    state.modeTargets = settings[MODE_DEVICE_TARGETS];
    state.loadedModeHomeId = 'main';
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await expect(clearMultipleDeviceSettings([DEVICE_ID])).rejects.toThrow('write failed');

    expect(state.controllableMap).toEqual({ [KEEP_ID]: true });
    expect(state.managedMap).toEqual(perDeviceMap(true));
    expect(state.deviceControlProfiles).toEqual({ [KEEP_ID]: CONTROL_PROFILE });
    expect(state.deviceTargetPowerConfigs).toEqual({ [KEEP_ID]: { targetPowerW: 1_000 } });
    expect(state.shedBehaviors).toEqual({ [KEEP_ID]: { action: 'turn_off' } });
    expect(state.temperatureBoostSettings).toEqual({ [KEEP_ID]: { enabled: true } });
    expect(state.evBoostSettings).toEqual({ [KEEP_ID]: { enabled: true } });
    expect(state.priceOptimizationSettings).toEqual({ [KEEP_ID]: { enabled: true } });
    expect(state.temperatureControlDisabledMap).toEqual(perDeviceMap(true));
    expect(state.capacityPriorities).toEqual({ Home: { [KEEP_ID]: 2 } });
    expect(state.modeTargets).toEqual({ Home: { [KEEP_ID]: 21 } });

    await clearMultipleDeviceSettings([DEVICE_ID]);
    expect(state.managedMap).toEqual({ [KEEP_ID]: true });
    expect(state.temperatureControlDisabledMap).toEqual({ [KEEP_ID]: true });
    expect(homey.__settingsStore[TEMPERATURE_CONTROL_DISABLED_DEVICES]).toEqual({ [KEEP_ID]: true });
  });

  it('blocks later purge writes until a failed reconciliation succeeds', async () => {
    const homey = createHomeyMock({ settings: {
      [TEMPERATURE_CONTROL_DISABLED_DEVICES]: perDeviceMap(true),
      [CAPACITY_PRIORITIES]: { Home: { [DEVICE_ID]: 1 } },
      [MODE_DEVICE_TARGETS]: { Home: { [DEVICE_ID]: 20 } },
    } });
    const originalSet = homey.set.getMockImplementation();
    let failTemperatureControlWrite = true;
    homey.set.mockImplementation((key, value, callback) => {
      if (key === TEMPERATURE_CONTROL_DISABLED_DEVICES && failTemperatureControlWrite) {
        failTemperatureControlWrite = false;
        callback?.(new Error('write failed'));
        return;
      }
      originalSet?.(key, value, callback);
    });
    const originalGet = homey.get.getMockImplementation();
    let reconciliationReadFailures = 2;
    homey.get.mockImplementation((key, callback) => {
      if (key === 'managed_devices' && reconciliationReadFailures > 0) {
        reconciliationReadFailures -= 1;
        callback(new Error('reconcile failed'));
        return;
      }
      originalGet?.(key, callback);
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    state.temperatureControlDisabledMap = perDeviceMap(true);
    state.capacityPriorities = { Home: { [DEVICE_ID]: 1 } };
    state.modeTargets = { Home: { [DEVICE_ID]: 20 } };
    state.loadedModeHomeId = 'main';
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await expect(clearMultipleDeviceSettings([DEVICE_ID])).rejects.toThrow('reconcile failed');
    const writesAfterPartialFailure = homey.set.mock.calls.length;

    await expect(clearMultipleDeviceSettings([DEVICE_ID])).rejects.toThrow('reconcile failed');
    expect(homey.set).toHaveBeenCalledTimes(writesAfterPartialFailure);

    await clearMultipleDeviceSettings([DEVICE_ID]);
    expect(state.temperatureControlDisabledMap).toEqual({ [KEEP_ID]: true });
  });
});
