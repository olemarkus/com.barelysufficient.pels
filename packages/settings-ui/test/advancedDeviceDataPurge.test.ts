import {
  CAPACITY_PRIORITIES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  EV_BOOST_SETTINGS,
  EV_CHARGE_TARGET_SETTINGS,
  MODE_DEVICE_TARGETS,
  OVERSHOOT_BEHAVIORS,
  RESPECT_EXTERNAL_OFF_DEVICES,
  TEMPERATURE_BOOST_SETTINGS,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
} from '../../shared-domain/src/settings/settingsKeys.ts';
import {
  SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH,
  SETTINGS_UI_SMART_TASK_CANCEL_PATH,
} from '../../contracts/src/settingsUiApi.ts';
import type { DeferredObjectiveSettingsEntry } from '../../contracts/src/deferredObjectiveSettings.ts';
import { createHomeyMock } from './helpers/homeyApiMock.ts';

const DEVICE_ID = 'heater-1';
const KEEP_ID = 'heater-2';
const CONTROL_PROFILE = {
  steps: [{ id: 'off', planningPowerW: 0 }],
};
const PRICE_CONFIG = {
  enabled: true,
  cheapDelta: 5,
  expensiveDelta: -5,
  priceConfigured: true,
  surplusWilling: false,
  surplusDelta: 2,
};

const SMART_TASK: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 65,
  deadlineAtMs: Date.UTC(2030, 0, 1),
};

const TASKS = { version: 1, objectivesByDeviceId: { [DEVICE_ID]: SMART_TASK } };

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
      [EV_CHARGE_TARGET_SETTINGS]: perDeviceMap({ targetPercent: 60, chargeBeforeLevelKnown: true }),
      price_optimization_settings: perDeviceMap(PRICE_CONFIG),
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
    state.evChargeTargetSettings = perDeviceMap({ targetPercent: 60, chargeBeforeLevelKnown: true });
    state.priceOptimizationSettings = perDeviceMap(PRICE_CONFIG);
    state.temperatureControlDisabledMap = perDeviceMap(true);
    state.capacityPriorities = settings[CAPACITY_PRIORITIES];
    state.modeTargets = settings[MODE_DEVICE_TARGETS];
    state.loadedModeHomeId = 'main';
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    // The transient null on a map the page knows holds the device fails the purge
    // rather than reading as cleared.
    await expect(clearMultipleDeviceSettings([DEVICE_ID])).rejects.toThrow('Could not read managed_devices');

    expect(state.controllableMap).toEqual({ [KEEP_ID]: true });
    expect(state.managedMap).toEqual(perDeviceMap(true));
    expect(state.deviceControlProfiles).toEqual({ [KEEP_ID]: CONTROL_PROFILE });
    expect(state.deviceTargetPowerConfigs).toEqual({ [KEEP_ID]: { targetPowerW: 1_000 } });
    expect(state.shedBehaviors).toEqual({ [KEEP_ID]: { action: 'turn_off' } });
    expect(state.temperatureBoostSettings).toEqual({ [KEEP_ID]: { enabled: true } });
    expect(state.evBoostSettings).toEqual({ [KEEP_ID]: { enabled: true } });
    expect(state.evChargeTargetSettings).toEqual({ [KEEP_ID]: { targetPercent: 60, chargeBeforeLevelKnown: true } });
    expect(state.priceOptimizationSettings).toEqual({ [KEEP_ID]: PRICE_CONFIG });
    expect(state.temperatureControlDisabledMap).toEqual(perDeviceMap(true));
    // The persisted preference was removed, but a transient managed-map read
    // must retain the live device and give it a resolved rank until retry succeeds.
    expect(homey.__settingsStore[CAPACITY_PRIORITIES]).toEqual({ Home: { [KEEP_ID]: 2 } });
    expect(state.capacityPriorities).toEqual({ Home: { [KEEP_ID]: 1, [DEVICE_ID]: 2 } });
    expect(state.modeTargets).toEqual({ Home: { [KEEP_ID]: 21 } });

    await clearMultipleDeviceSettings([DEVICE_ID]);
    expect(state.managedMap).toEqual({ [KEEP_ID]: true });
    expect(state.capacityPriorities).toEqual({ Home: { [KEEP_ID]: 1 } });
    expect(state.temperatureControlDisabledMap).toEqual({ [KEEP_ID]: true });
    expect(homey.__settingsStore[TEMPERATURE_CONTROL_DISABLED_DEVICES]).toEqual({ [KEEP_ID]: true });
  });

  it('purges a catalog the store already holds with a malformed mode', async () => {
    // Regression: the write guard refuses a malformed catalog, so a stored
    // `Away: null` used to abort "Clear device data" — after sibling purge
    // writes had already landed. The raw catalog goes through the key's owner
    // on the way in, so the guard sees a repaired one on the way out.
    const homey = createHomeyMock({ settings: {
      [CAPACITY_PRIORITIES]: { Home: { [DEVICE_ID]: 1, [KEEP_ID]: 2 } },
      [MODE_DEVICE_TARGETS]: { Home: { [DEVICE_ID]: 20, [KEEP_ID]: 21 }, Away: null },
    } });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    state.capacityPriorities = { Home: { [DEVICE_ID]: 1, [KEEP_ID]: 2 } };
    state.modeTargets = { Home: { [DEVICE_ID]: 20, [KEEP_ID]: 21 } };
    state.loadedModeHomeId = 'main';
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await expect(clearMultipleDeviceSettings([DEVICE_ID])).resolves.toBeUndefined();
    // The purged device is gone, the kept one survives, and the malformed mode
    // is retained as an empty one rather than dropped.
    expect(homey.__settingsStore[MODE_DEVICE_TARGETS]).toEqual({
      Home: { [KEEP_ID]: 21 },
      Away: {},
    });
  });

  it('fails on a stored map it cannot read, and a retry finishes the purge', async () => {
    const homey = createHomeyMock({ settings: {
      managed_devices: perDeviceMap(true),
      [TEMPERATURE_CONTROL_DISABLED_DEVICES]: perDeviceMap(true),
    } });
    const originalGet = homey.get.getMockImplementation();
    let managedReadFailures = 1;
    homey.get.mockImplementation((key, callback) => {
      if (key === 'managed_devices' && managedReadFailures > 0) {
        managedReadFailures -= 1;
        callback(new Error('read failed'));
        return;
      }
      originalGet?.(key, callback);
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await expect(clearMultipleDeviceSettings([DEVICE_ID])).rejects.toThrow('read failed');
    expect(homey.__settingsStore.managed_devices).toEqual(perDeviceMap(true));
    expect(state.managedMap).toEqual(perDeviceMap(true));

    await clearMultipleDeviceSettings([DEVICE_ID]);
    expect(homey.__settingsStore.managed_devices).toEqual({ [KEEP_ID]: true });
    expect(state.temperatureControlDisabledMap).toEqual({ [KEEP_ID]: true });
  });

  it('lists and purges a device whose only data is a smart task and a leave-off opt-in', async () => {
    // The task is runtime-owned: the purge clears it through the Smart tasks
    // page's cancel op, so its key and its card go with the device.
    const cancelledDeviceIds: unknown[] = [];
    const homey = createHomeyMock({
      settings: { [RESPECT_EXTERNAL_OFF_DEVICES]: perDeviceMap(true) },
      apiHandlers: {
        [`GET ${SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH}`]: () => TASKS,
        [`POST ${SETTINGS_UI_SMART_TASK_CANCEL_PATH}`]: ({ body }) => {
          cancelledDeviceIds.push((body as { deviceId: string }).deviceId);
          return { ok: true };
        },
      },
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    state.respectExternalOffMap = { [KEEP_ID]: true };
    // The boot read, as the page does it.
    const { loadDeferredObjectiveSettings } = await import('../src/ui/deferredObjectiveSettings.ts');
    await loadDeferredObjectiveSettings();
    const {
      clearMultipleDeviceSettings,
      resolveUnknownDeviceIdsFromSettings,
    } = await import('../src/ui/advancedDeviceDataPurge.ts');

    expect(resolveUnknownDeviceIdsFromSettings().sort()).toEqual([DEVICE_ID, KEEP_ID]);

    await clearMultipleDeviceSettings([DEVICE_ID, KEEP_ID]);

    expect(cancelledDeviceIds).toEqual([DEVICE_ID]);
    expect(homey.__settingsStore[RESPECT_EXTERNAL_OFF_DEVICES]).toEqual({});
    expect(state.respectExternalOffMap).toEqual({});
  });

  it('treats an already-ended smart task as cleared and fails on a refused cancel', async () => {
    const reasons = ['task_not_found', 'write_conflict'];
    const homey = createHomeyMock({
      settings: { [RESPECT_EXTERNAL_OFF_DEVICES]: perDeviceMap(true) },
      apiHandlers: {
        [`GET ${SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH}`]: () => TASKS,
        [`POST ${SETTINGS_UI_SMART_TASK_CANCEL_PATH}`]: () => ({ ok: false, reason: reasons.shift() }),
      },
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    state.respectExternalOffMap = perDeviceMap(true);
    // No boot read of the task map: the purge must load it rather than take the
    // empty default for "no tasks".
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await expect(clearMultipleDeviceSettings([DEVICE_ID])).resolves.toBeUndefined();
    await expect(clearMultipleDeviceSettings([KEEP_ID])).resolves.toBeUndefined();
    // KEEP_ID has no task, so it asked nothing; DEVICE_ID's refused cancel fails the purge.
    await expect(clearMultipleDeviceSettings([DEVICE_ID])).rejects.toThrow('write_conflict');
  });
  it('purges from the store when the page copies never loaded', async () => {
    // A failed or pending boot read leaves the page's copies at empty defaults;
    // writing those would erase every other device's settings.
    const homey = createHomeyMock({
      settings: {
        managed_devices: perDeviceMap(true),
        [DEVICE_CONTROL_PROFILES]: perDeviceMap(CONTROL_PROFILE),
        [RESPECT_EXTERNAL_OFF_DEVICES]: perDeviceMap(true),
      },
      apiHandlers: { [`GET ${SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH}`]: () => ({ version: 1, objectivesByDeviceId: {} }) },
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await clearMultipleDeviceSettings([DEVICE_ID]);

    expect(homey.__settingsStore.managed_devices).toEqual({ [KEEP_ID]: true });
    expect(homey.__settingsStore[DEVICE_CONTROL_PROFILES]).toEqual({ [KEEP_ID]: CONTROL_PROFILE });
    expect(homey.__settingsStore[RESPECT_EXTERNAL_OFF_DEVICES]).toEqual({ [KEEP_ID]: true });
    expect(state.deviceControlProfiles).toEqual({ [KEEP_ID]: CONTROL_PROFILE });
  });

  it('edits the stored leave-off map, not the page copy, and never overwrites a malformed one', async () => {
    // The runtime releases the hold of every device that leaves this map, so
    // writing the page's stale or default copy would release other devices' holds.
    const homey = createHomeyMock({
      settings: { [RESPECT_EXTERNAL_OFF_DEVICES]: perDeviceMap(true) },
      apiHandlers: { [`GET ${SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH}`]: () => ({ version: 1, objectivesByDeviceId: {} }) },
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    state.respectExternalOffMap = {};
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await clearMultipleDeviceSettings([DEVICE_ID]);
    expect(homey.__settingsStore[RESPECT_EXTERNAL_OFF_DEVICES]).toEqual({ [KEEP_ID]: true });
    expect(state.respectExternalOffMap).toEqual({ [KEEP_ID]: true });

    const malformed = { [KEEP_ID]: 'yes' };
    homey.__settingsStore[RESPECT_EXTERNAL_OFF_DEVICES] = malformed;
    // The runtime keeps its last-good map, which still holds the opt-in, so the
    // purge says it could not clear it rather than claiming it is gone.
    await expect(clearMultipleDeviceSettings([KEEP_ID])).rejects.toThrow('Could not read respect_external_off_devices');
    expect(homey.__settingsStore[RESPECT_EXTERNAL_OFF_DEVICES]).toBe(malformed);
    expect(state.respectExternalOffMap).toEqual({ [KEEP_ID]: true });
  });

  it('reconciles past a malformed leave-off map after a failed write', async () => {
    const malformed = ['not', 'a', 'map'];
    const homey = createHomeyMock({
      settings: { [RESPECT_EXTERNAL_OFF_DEVICES]: malformed, managed_devices: perDeviceMap(true) },
      apiHandlers: { [`GET ${SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH}`]: () => ({ version: 1, objectivesByDeviceId: {} }) },
    });
    const originalSet = homey.set.getMockImplementation();
    let failManagedWrite = true;
    homey.set.mockImplementation((key, value, callback) => {
      if (key === 'managed_devices' && failManagedWrite) {
        failManagedWrite = false;
        callback?.(new Error('write failed'));
        return;
      }
      originalSet?.(key, value, callback);
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    state.managedMap = perDeviceMap(true);
    state.respectExternalOffMap = { [KEEP_ID]: true };
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await expect(clearMultipleDeviceSettings([DEVICE_ID])).rejects.toThrow('write failed');
    expect(state.respectExternalOffMap).toEqual({ [KEEP_ID]: true });

    await clearMultipleDeviceSettings([DEVICE_ID]);
    expect(homey.__settingsStore.managed_devices).toEqual({ [KEEP_ID]: true });
    expect(homey.__settingsStore[RESPECT_EXTERNAL_OFF_DEVICES]).toBe(malformed);
  });

  it('leaves a map its owner rejects alone and still purges the rest', async () => {
    const homey = createHomeyMock({ settings: {
      managed_devices: perDeviceMap(true),
      temperature_control_modes: [],
    } });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(homey);
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await clearMultipleDeviceSettings([DEVICE_ID]);
    expect(homey.__settingsStore.managed_devices).toEqual({ [KEEP_ID]: true });
    expect(homey.__settingsStore.temperature_control_modes).toEqual([]);
  });

  it('keeps a retained device\'s temperature authority derived from its control mode', async () => {
    const homey = createHomeyMock({ settings: {
      temperature_control_modes: { [DEVICE_ID]: 'mode', [KEEP_ID]: 'external' },
      [TEMPERATURE_CONTROL_DISABLED_DEVICES]: {},
    } });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const { state } = await import('../src/ui/state.ts');
    setHomeyClient(homey);
    state.temperatureControlModes = { [DEVICE_ID]: 'mode', [KEEP_ID]: 'external' };
    state.temperatureControlDisabledMap = { [DEVICE_ID]: false, [KEEP_ID]: true };
    const { clearMultipleDeviceSettings } = await import('../src/ui/advancedDeviceDataPurge.ts');

    await clearMultipleDeviceSettings([DEVICE_ID]);
    expect(homey.__settingsStore.temperature_control_modes).toEqual({ [KEEP_ID]: 'external' });
    expect(homey.__settingsStore[TEMPERATURE_CONTROL_DISABLED_DEVICES]).toEqual({});
    expect(state.temperatureControlDisabledMap).toEqual({ [KEEP_ID]: true });
  });
});
