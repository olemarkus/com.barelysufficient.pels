import {
  mockHomeyInstance,
  setMockDrivers,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import type { TargetDeviceSnapshot } from '../lib/utils/types';
import { CAPACITY_DRY_RUN } from '../lib/utils/settingsKeys';

jest.useFakeTimers({ doNotFake: ['nextTick', 'Date'] });
const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

const buildVThermoApiDevice = (overrides?: Partial<{
  id: string;
  name: string;
  onoff: boolean;
  targetTemperature: number;
  measureTemperature: number;
  class: string;
  capabilities: string[];
  load: number;
}>) => ({
  id: overrides?.id ?? 'vthermo-1',
  name: overrides?.name ?? 'Virtual Thermostat',
  class: overrides?.class ?? 'thermostat',
  virtualClass: null,
  capabilities: overrides?.capabilities ?? [
    'onoff',
    'vt_onoff',
    'target_temperature',
    'measure_temperature',
  ],
  capabilitiesObj: {
    onoff: { id: 'onoff', value: overrides?.onoff ?? true },
    target_temperature: {
      id: 'target_temperature',
      value: overrides?.targetTemperature ?? 22,
      units: '°C',
      min: 10,
      max: 30,
    },
    measure_temperature: {
      id: 'measure_temperature',
      value: overrides?.measureTemperature ?? 21,
      units: '°C',
    },
  },
  settings: {
    load: overrides?.load ?? 0,
  },
});

describe('VThermo device integration', () => {
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

  it('keeps VThermo managed for price-only control but disables capacity control when no power capability exists', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('managed_devices', { 'vthermo-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'vthermo-1': true });
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'vthermo-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
    });

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'vthermo-1': buildVThermoApiDevice(),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as TargetDeviceSnapshot[];
    const entry = snapshot.find((device) => device.id === 'vthermo-1');
    expect(entry).toBeDefined();
    expect(entry?.deviceClass).toBe('thermostat');
    expect(entry?.deviceType).toBe('temperature');
    expect(entry?.loadKw).toBeUndefined();
    expect(entry?.powerCapable).toBe(false);

    const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
    const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
    const priceSettings = mockHomeyInstance.settings.get('price_optimization_settings') as Record<string, { enabled?: boolean }>;

    expect(managed['vthermo-1']).toBe(true);
    expect(controllable['vthermo-1']).toBe(false);
    expect(priceSettings['vthermo-1']?.enabled).toBe(true);
  });

  it('applies mode targets for VThermo even when it lacks power capabilities', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'vthermo-1': 19 } });
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { 'vthermo-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'vthermo-1': true });

    const app = createApp();
    await app.onInit();

    const setCapSpy = jest.fn().mockResolvedValue(undefined);
    const homeyApiStub = {
      devices: {
        getDevices: async () => ({
          'vthermo-1': buildVThermoApiDevice({ targetTemperature: 22 }),
        }),
        setCapabilityValue: setCapSpy,
      },
    };
    (app as any).homeyApi = homeyApiStub;
    (app as any).deviceManager.homeyApi = homeyApiStub;

    await (app as any).refreshTargetDevicesSnapshot();

    const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
    expect(controllable['vthermo-1']).toBe(false);

    await (app as any).planService.rebuildPlanFromCache();
    await flushPromises();

    expect(setCapSpy).toHaveBeenCalledWith({
      deviceId: 'vthermo-1',
      capabilityId: 'target_temperature',
      value: 19,
    });
  });
});
