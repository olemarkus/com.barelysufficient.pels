import { registerAllowSmartTaskRescueCard } from '../flowCards/smartTaskRescueCard';
import type { DeferredObjectiveSettingsEntry } from '../lib/objectives/deferredObjectives';
import { PER_DEVICE_OBJECTIVE_KEY_PREFIX } from '../lib/objectives/deferredObjectives/objectiveStore';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { cleanupApps, createApp } from './utils/appTestUtils';

const keyFor = (deviceId: string): string => `${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${deviceId}`;

const seedTemperatureTask = (deviceId: string): void => {
  // Per-device-key storage: the task lives under the device's own key.
  mockHomeyInstance.settings.set(keyFor(deviceId), {
    enabled: true,
    kind: 'temperature',
    enforcement: 'soft',
    targetTemperatureC: 65,
    deadlineAtMs: Date.now() + 6 * 60 * 60 * 1000,
  });
};

const readEntry = (deviceId: string): DeferredObjectiveSettingsEntry | undefined => (
  mockHomeyInstance.settings.get(keyFor(deviceId)) as DeferredObjectiveSettingsEntry | undefined
);

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
    const before = JSON.stringify(mockHomeyInstance.settings.get(keyFor('dev-1')));
    await expect(listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'always' })).resolves.toBe(true);
    expect(JSON.stringify(mockHomeyInstance.settings.get(keyFor('dev-1')))).toBe(before);

    await app.onUninit?.();
  });

  it('throws when the device has no smart task', async () => {
    const app = await initApp();
    await expect(listener()({ device: 'dev-1', property: 'exempt_from_budget', when: 'always' }))
      .rejects.toThrow(/add a smart task for this device first/i);
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

  it('THROWS (retryable) when the underlying write refuses (no silent success)', async () => {
    // The read finds the device's task (so the card reaches the write), but the
    // device-scoped write refuses to persist (transient un-confirmable migration
    // / untrustworthy settings read). The card must throw a retryable error so
    // Homey surfaces the failure instead of reporting success while the rescue
    // permission never changed.
    const existing: DeferredObjectiveSettingsEntry = {
      enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 65, deadlineAtMs: Date.now() + 3.6e6,
    };
    const cardListeners: Record<string, (args: unknown) => Promise<boolean>> = {};
    const upsertDeferredObjectiveForDevice = vi.fn(() => ({ persisted: false as const, reason: 'untrusted_absence' as const }));
    const deps = {
      homey: {
        flow: {
          getActionCard: () => ({
            registerRunListener: (fn: (args: unknown) => Promise<boolean>) => { cardListeners.run = fn; },
            registerArgumentAutocompleteListener: () => {},
          }),
        },
        settings: { get: () => undefined, set: () => {}, unset: () => {}, getKeys: () => [] },
      },
      getDeferredObjectiveSettings: () => ({ version: 1 as const, objectivesByDeviceId: { 'dev-1': existing } }),
      getSnapshot: async () => [],
      upsertDeferredObjectiveForDevice,
    } as unknown as Parameters<typeof registerAllowSmartTaskRescueCard>[0];
    registerAllowSmartTaskRescueCard(deps);
    await expect(cardListeners.run({ device: 'dev-1', property: 'exempt_from_budget', when: 'always' }))
      .rejects.toThrow(/try again/i);
    expect(upsertDeferredObjectiveForDevice).toHaveBeenCalledOnce();
  });

  it('lists smart-task-capable devices in the autocomplete even with no active task', async () => {
    // Regression: the device dropdown filtered by current active tasks, so it was empty while
    // building the flow (before any task existed). It must list capable devices instead.
    const device = new MockDevice('therm-1', 'Heater', ['measure_power', 'onoff', 'target_temperature']);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    const app = createApp();
    await app.onInit();
    const autocomplete = mockHomeyInstance.flow._actionCardAutocompleteListeners.allow_smart_task_rescue?.device;
    if (!autocomplete) throw new Error('device autocomplete not registered');
    const results = await autocomplete('');
    expect(results.map((option: { id: string }) => option.id)).toContain('therm-1');
    await app.onUninit?.();
  });
});
