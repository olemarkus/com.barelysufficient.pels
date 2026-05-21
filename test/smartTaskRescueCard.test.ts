import type { DeferredObjectiveSettingsEntry, DeferredObjectiveSettingsV1 } from '../lib/plan/deferredObjectives';
import { DEFERRED_OBJECTIVES_SETTINGS } from '../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { cleanupApps, createApp } from './utils/appTestUtils';

const seedTemperatureTask = (deviceId: string): void => {
  const settings: DeferredObjectiveSettingsV1 = {
    version: 1,
    objectivesByDeviceId: {
      [deviceId]: {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 65,
        deadlineAtMs: Date.now() + 6 * 60 * 60 * 1000,
      },
    },
  };
  mockHomeyInstance.settings.set(DEFERRED_OBJECTIVES_SETTINGS, settings);
};

const readEntry = (deviceId: string): DeferredObjectiveSettingsEntry | undefined => {
  const settings = mockHomeyInstance.settings.get(DEFERRED_OBJECTIVES_SETTINGS) as DeferredObjectiveSettingsV1 | undefined;
  return settings?.objectivesByDeviceId[deviceId];
};

describe('allow_smart_task_rescue flow card', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    mockHomeyInstance.api.clearRealtimeEvents();
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  const initApp = async (deviceId = 'dev-1') => {
    const device = new MockDevice(deviceId, 'Heater', ['measure_power', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    const app = createApp();
    await app.onInit();
    return app;
  };

  const listener = () => mockHomeyInstance.flow._actionCardListeners.allow_smart_task_rescue;

  it('sets exempt-from-budget to always (when planned to run) on the smart task entry', async () => {
    seedTemperatureTask('dev-1');
    const app = await initApp();
    expect(listener()).toBeDefined();

    await expect(listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'always' })).resolves.toBe(true);
    expect(readEntry('dev-1')?.rescue).toEqual({ exemptFromBudget: 'always' });

    await app.onUninit?.();
  });

  it('sets limit-lower-priority and keeps the two permissions independent', async () => {
    seedTemperatureTask('dev-1');
    const app = await initApp();

    await expect(listener()({ device: 'dev-1', property: 'limit_lower_priority', when: 'always' })).resolves.toBe(true);
    expect(readEntry('dev-1')?.rescue).toEqual({ limitLowerPriorityDevices: 'always' });

    // Adding exempt-from-budget keeps the existing limit permission.
    await listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'always' });
    expect(readEntry('dev-1')?.rescue).toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' });

    // Clearing limit leaves exempt intact.
    await listener()({ device: 'dev-1', property: 'limit_lower_priority', when: 'never' });
    expect(readEntry('dev-1')?.rescue).toEqual({ exemptFromBudget: 'always' });

    await app.onUninit?.();
  });

  it('drops the rescue object entirely when the last permission is set to never', async () => {
    seedTemperatureTask('dev-1');
    const app = await initApp();

    await listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'always' });
    await listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'never' });
    expect(readEntry('dev-1')?.rescue).toBeUndefined();

    await app.onUninit?.();
  });

  it('is idempotent — re-setting the same mode leaves the stored settings unchanged', async () => {
    seedTemperatureTask('dev-1');
    const app = await initApp();

    await listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'always' });
    const before = JSON.stringify(mockHomeyInstance.settings.get(DEFERRED_OBJECTIVES_SETTINGS));
    await expect(listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'always' })).resolves.toBe(true);
    expect(JSON.stringify(mockHomeyInstance.settings.get(DEFERRED_OBJECTIVES_SETTINGS))).toBe(before);

    await app.onUninit?.();
  });

  it('throws when the device has no smart task', async () => {
    const app = await initApp();
    await expect(listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'always' }))
      .rejects.toThrow(/no smart task/i);
    await app.onUninit?.();
  });

  it('throws on an unknown property or when value', async () => {
    seedTemperatureTask('dev-1');
    const app = await initApp();
    await expect(listener()({ device: 'dev-1', property: 'nope', when: 'always' })).rejects.toThrow();
    await expect(listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'maybe' })).rejects.toThrow();
    await app.onUninit?.();
  });

  it('throws when no device is provided', async () => {
    seedTemperatureTask('dev-1');
    const app = await initApp();
    await expect(listener()({ property: 'exempt_from_budget', when: 'always' })).rejects.toThrow(/device/i);
    await app.onUninit?.();
  });
});
