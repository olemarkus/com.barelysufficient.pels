import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
} from '../lib/utils/settingsKeys';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate', 'Date'] });

const buildOnOffDevice = async (options?: { id?: string; name?: string; on?: boolean; powerW?: number }) => {
  const deviceId = options?.id ?? 'device-a';
  const deviceName = options?.name ?? 'On/Off Socket';
  const device = new MockDevice(
    deviceId,
    deviceName,
    ['onoff', 'measure_power', 'meter_power', 'rms_voltage', 'rms_current'],
    'socket',
  );
  await device.setCapabilityValue('onoff', options?.on ?? true);
  await device.setCapabilityValue('measure_power', options?.powerW ?? 1200);
  return device;
};

const buildOnOffApiDevice = (overrides?: Partial<{
  id: string;
  name: string;
  onoff: boolean;
  measurePower: number;
  class: string;
  virtualClass: string;
  capabilities: string[];
}>) => ({
  id: overrides?.id ?? 'device-a',
  name: overrides?.name ?? 'On/Off Socket',
  class: overrides?.class ?? 'socket',
  virtualClass: overrides?.virtualClass ?? 'appliance',
  capabilities: overrides?.capabilities ?? ['onoff', 'measure_power', 'meter_power', 'rms_voltage', 'rms_current'],
  capabilitiesObj: {
    onoff: { id: 'onoff', value: overrides?.onoff ?? true },
    measure_power: { id: 'measure_power', value: overrides?.measurePower ?? 0 },
  },
  settings: {},
});

describe('On/off device integration', () => {
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

  it('builds a snapshot entry for a socket-class on/off device', async () => {
    const device = await buildOnOffDevice({ on: true, powerW: 1200 });
    setMockDrivers({
      driverA: new MockDriver('driverA', [device]),
    });

    const app = createApp();
    await app.onInit();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      deviceType?: string;
      deviceClass?: string;
      targets?: Array<unknown>;
      currentOn?: boolean;
      powerKw?: number;
    }>;
    const entry = snapshot.find((snap) => snap.id === 'device-a');

    expect(entry?.deviceType).toBe('onoff');
    expect(entry?.deviceClass).toBe('socket');
    expect(entry?.targets?.length ?? 0).toBe(0);
    expect(entry?.currentOn).toBe(true);
    expect(entry?.powerKw).toBeCloseTo(1.2, 2);
  });

  it('does not apply mode targets for on/off devices', async () => {
    const device = await buildOnOffDevice({ on: true, powerW: 0 });
    setMockDrivers({
      driverA: new MockDriver('driverA', [device]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'device-a': 18 } });
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'device-a': true });

    const app = createApp();
    await app.onInit();

    const setCapSpy = jest.fn().mockResolvedValue(undefined);
    const homeyApiStub = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({ onoff: true, measurePower: 0 }),
        }),
        setCapabilityValue: setCapSpy,
      },
    };
    (app as any).homeyApi = homeyApiStub;
    (app as any).deviceManager.homeyApi = homeyApiStub;

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    await setModeListener({ mode: 'Home' });
    await flushPromises();

    expect(setCapSpy).not.toHaveBeenCalled();
  });

  it('excludes on/off devices without measure_power', async () => {
    setMockDrivers({});
    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['onoff'],
          }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{ id: string }>;
    expect(snapshot.find((entry) => entry.id === 'device-a')).toBeUndefined();
  });

  it('excludes devices missing onoff capability when no temperature targets exist', async () => {
    setMockDrivers({});
    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['measure_power'],
          }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{ id: string }>;
    expect(snapshot.find((entry) => entry.id === 'device-a')).toBeUndefined();
  });

  it('excludes devices with unsupported classes', async () => {
    setMockDrivers({});
    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            class: 'light',
          }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{ id: string }>;
    expect(snapshot.find((entry) => entry.id === 'device-a')).toBeUndefined();
  });

  it('excludes devices that only expose virtualClass', async () => {
    setMockDrivers({});
    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': {
            ...buildOnOffApiDevice({
              class: '',
              virtualClass: 'socket',
            }),
            class: undefined,
          },
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{ id: string }>;
    expect(snapshot.find((entry) => entry.id === 'device-a')).toBeUndefined();
  });

  it('sheds an on/off device by turning it off when headroom is insufficient', async () => {
    const device = await buildOnOffDevice({ on: true, powerW: 2000 });
    setMockDrivers({
      driverA: new MockDriver('driverA', [device]),
    });

    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'device-a': true });

    const app = createApp();
    await app.onInit();

    const setCapSpy = jest.fn().mockResolvedValue(undefined);
    (app as any).deviceManager.homeyApi = {
      devices: {
        setCapabilityValue: setCapSpy,
      },
    };

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    await (app as any).recordPowerSample(5000);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(setCapSpy).toHaveBeenCalledWith({
      deviceId: 'device-a',
      capabilityId: 'onoff',
      value: false,
    });
  });

  it('never uses set_temperature shed action without target_temperature', async () => {
    const device = await buildOnOffDevice({ on: true, powerW: 2000 });
    setMockDrivers({
      driverA: new MockDriver('driverA', [device]),
    });

    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, true);
    mockHomeyInstance.settings.set('controllable_devices', { 'device-a': true });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'device-a': { action: 'set_temperature', temperature: 40 },
    });

    const app = createApp();
    await app.onInit();

    const snapshot = (app as any).deviceManager.getSnapshot();
    const snapDevice = snapshot.find((entry: any) => entry.id === 'device-a');
    expect(snapDevice?.deviceType).toBe('onoff');
    expect(snapDevice?.targets?.length ?? 0).toBe(0);

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    await (app as any).recordPowerSample(5000);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const planDevice = plan.devices.find((entry: any) => entry.id === 'device-a');
    expect(planDevice?.shedAction).toBe('turn_off');
    expect(planDevice?.plannedTarget).toBeNull();
    expect(planDevice?.currentTarget).toBeNull();
    expect(planDevice?.shedTemperature).toBeNull();
  });
});
