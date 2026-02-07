import {
  mockHomeyInstance,
  setMockDrivers,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
} from '../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../lib/utils/types';

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

// Use fake timers to prevent resource leaks from periodic refresh and control timing deterministically
jest.useFakeTimers({ doNotFake: ['nextTick', 'Date'] });

const buildAirtreatmentApiDevice = (overrides?: Partial<{
  id: string;
  name: string;
  targetTemperature: number;
  measureTemperature: number;
  measurePower: number;
  class: string;
  capabilities: string[];
}>) => ({
  id: overrides?.id ?? 'airtreatment-1',
  name: overrides?.name ?? 'Nordic S4 REL',
  class: overrides?.class ?? 'airtreatment',
  virtualClass: null,
  capabilities: overrides?.capabilities ?? [
    'measure_power',
    'measure_temperature',
    'target_temperature',
    'fan_mode',
  ],
  capabilitiesObj: {
    measure_power: { id: 'measure_power', value: overrides?.measurePower ?? 245.73 },
    measure_temperature: { id: 'measure_temperature', value: overrides?.measureTemperature ?? 18, units: '°C' },
    target_temperature: {
      id: 'target_temperature',
      value: overrides?.targetTemperature ?? 19,
      units: '°C',
      min: 10,
      max: 30,
      step: 0.5,
    },
    fan_mode: { id: 'fan_mode', value: 'home' },
  },
  settings: {},
});

describe('Airtreatment device integration', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
  });

  it('builds a snapshot entry for an airtreatment temperature device', async () => {
    setMockDrivers({});

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'airtreatment-1': buildAirtreatmentApiDevice(),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as TargetDeviceSnapshot[];
    const entry = snapshot.find((device) => device.id === 'airtreatment-1');

    expect(entry).toBeDefined();
    expect(entry?.deviceClass).toBe('airtreatment');
    expect(entry?.deviceType).toBe('temperature');
    expect(entry?.powerCapable).toBe(true);
  });

  it('enforces set_temperature with sane default when capacity control is enabled', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('managed_devices', { 'airtreatment-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'airtreatment-1': true });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'airtreatment-1': { action: 'turn_off' },
    });

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'airtreatment-1': buildAirtreatmentApiDevice({ targetTemperature: 19 }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const overshootBehaviors = mockHomeyInstance.settings.get('overshoot_behaviors') as Record<string, { action: string; temperature?: number }>;
    expect(overshootBehaviors['airtreatment-1']).toEqual({ action: 'set_temperature', temperature: 16 });
  });

  it('sheds airtreatment devices by target_temperature, not onoff', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { 'airtreatment-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'airtreatment-1': true });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'airtreatment-1': { action: 'turn_off' },
    });

    const app = createApp();
    await app.onInit();

    const setCapSpy = jest.fn().mockResolvedValue(undefined);
    const homeyApiStub = {
      devices: {
        getDevices: async () => ({
          'airtreatment-1': buildAirtreatmentApiDevice({ targetTemperature: 19, measurePower: 245.73 }),
        }),
        setCapabilityValue: setCapSpy,
      },
    };
    (app as any).homeyApi = homeyApiStub;
    (app as any).deviceManager.homeyApi = homeyApiStub;

    await (app as any).refreshTargetDevicesSnapshot();

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    await (app as any).recordPowerSample(5000);
    jest.advanceTimersByTime(100);
    await flushPromises();

    expect(setCapSpy).toHaveBeenCalledWith({
      deviceId: 'airtreatment-1',
      capabilityId: 'target_temperature',
      value: 16,
    });

    const onoffCalls = setCapSpy.mock.calls.filter(
      (call: Array<{ capabilityId?: string; value?: unknown }>) => call[0]?.capabilityId === 'onoff' && call[0]?.value === false,
    );
    expect(onoffCalls).toHaveLength(0);
  });
});
