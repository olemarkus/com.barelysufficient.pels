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

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

// Use fake timers to prevent resource leaks from periodic refresh and control timing deterministically
jest.useFakeTimers({ doNotFake: ['nextTick', 'Date'] });

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
  settings: Record<string, unknown>;
  energyObj: Record<string, unknown> | null;
  energy: Record<string, unknown> | null;
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
  settings: overrides?.settings ?? {},
  energyObj: overrides?.energyObj,
  energy: overrides?.energy,
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
    mockHomeyInstance.settings.set('managed_devices', { 'device-a': true });

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

  it('includes on/off devices without power capability but marks them unsupported', async () => {
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

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{ id: string; powerCapable?: boolean }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry?.powerCapable).toBe(false);
  });

  it('supports on/off devices with Homey energy approximation delta', async () => {
    setMockDrivers({});
    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['onoff'],
            energyObj: {
              approximation: {
                usageOn: 110,
                usageOff: 10,
              },
            },
          }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      powerCapable?: boolean;
      powerKw?: number;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
    }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      powerCapable: true,
      expectedPowerSource: 'homey-energy',
    });
    expect(entry?.expectedPowerKw).toBeCloseTo(0.1, 6);
    expect(entry?.powerKw).toBeCloseTo(0.1, 6);
  });

  it('uses canonical settings energy values for on/off devices when present', async () => {
    setMockDrivers({});
    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['onoff'],
            onoff: false,
            settings: {
              energy_value_on: 12.5,
              energy_value_off: 0,
            },
            energyObj: {
              W: 0,
              approximation: null,
            },
          }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      powerCapable?: boolean;
      powerKw?: number;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
    }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry).toEqual(expect.objectContaining({
      powerCapable: true,
      expectedPowerSource: 'homey-energy',
    }));
    expect(entry?.expectedPowerKw).toBeCloseTo(0.0125, 6);
    expect(entry?.powerKw).toBeCloseTo(0.0125, 6);
  });

  it('supports on/off devices using Homey live report when power capabilities are absent', async () => {
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
      energy: {
        getLiveReport: async () => ({
          items: [
            {
              type: 'device',
              id: 'device-a',
              values: { W: 125 },
            },
          ],
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      powerCapable?: boolean;
      powerKw?: number;
      measuredPowerKw?: number;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
    }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry?.powerCapable).toBe(true);
    expect(entry?.expectedPowerSource).toBe('measured-peak');
    expect(entry?.measuredPowerKw).toBeCloseTo(0.125, 6);
    expect(entry?.expectedPowerKw).toBeCloseTo(0.125, 6);
    expect(entry?.powerKw).toBeCloseTo(0.125, 6);
  });

  it('supports on/off devices with Homey energy W fallback when approximation is missing', async () => {
    setMockDrivers({});
    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['onoff'],
            onoff: true,
            energyObj: {
              W: 0.125,
              approximation: null,
            },
          }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      powerCapable?: boolean;
      powerKw?: number;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
    }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry).toEqual(expect.objectContaining({
      powerCapable: true,
      expectedPowerSource: 'homey-energy',
    }));
    expect(entry?.expectedPowerKw).toBeCloseTo(0.000125, 9);
    expect(entry?.powerKw).toBeCloseTo(0.000125, 9);
  });

  it('does not use Homey energy W fallback for explicitly off on/off devices but keeps them power-capable', async () => {
    setMockDrivers({});
    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['onoff'],
            onoff: false,
            energyObj: {
              W: 0.125,
              approximation: null,
            },
          }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      powerCapable?: boolean;
      powerKw?: number;
      expectedPowerSource?: string;
    }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry?.powerCapable).toBe(true);
    expect(entry?.expectedPowerSource).toBe('default');
    expect(entry?.powerKw).toBe(1);
  });

  it('does not treat usageConstant-only approximation as power-capable', async () => {
    setMockDrivers({});
    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['onoff'],
            onoff: true,
            energyObj: {
              approximation: {
                usageConstant: 350,
              },
            },
          }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      powerCapable?: boolean;
      powerKw?: number;
      expectedPowerSource?: string;
    }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry?.powerCapable).toBe(false);
    expect(entry?.expectedPowerSource).toBe('default');
    expect(entry?.powerKw).toBe(1);
  });

  it('keeps off sockets manageable when Homey energy W metadata is present (including 0W)', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('managed_devices', { 'device-a': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'device-a': true });

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['onoff'],
            onoff: false,
            energyObj: {
              W: 0,
              approximation: null,
            },
          }),
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      powerCapable?: boolean;
      expectedPowerSource?: string;
    }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry?.powerCapable).toBe(true);
    expect(entry?.expectedPowerSource).toBe('default');

    const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
    const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
    expect(managed['device-a']).toBe(true);
    expect(controllable['device-a']).toBe(true);
  });

  it('bug: should recover power-capable support after off->on transition when W metadata appears', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('managed_devices', { 'device-a': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'device-a': true });

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['onoff'],
            onoff: false,
            energyObj: {
              W: 0,
              approximation: null,
            },
          }),
        }),
      },
    };
    await (app as any).refreshTargetDevicesSnapshot();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': buildOnOffApiDevice({
            capabilities: ['onoff'],
            onoff: true,
            energyObj: {
              W: 0.125,
              approximation: null,
            },
          }),
        }),
      },
    };
    await (app as any).refreshTargetDevicesSnapshot();
    await flushPromises();
    await flushPromises();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      powerCapable?: boolean;
      expectedPowerSource?: string;
    }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry).toEqual(expect.objectContaining({
      powerCapable: true,
      expectedPowerSource: 'homey-energy',
    }));

    const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
    const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
    expect(managed['device-a']).toBe(true);
    expect(controllable['device-a']).toBe(true);
  });

  it('bug: off virtual socket/light should remain user-manageable even when W=0 and live report has no device entry', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('managed_devices', { 'device-a': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'device-a': true });

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'device-a': {
            ...buildOnOffApiDevice({
              class: 'socket',
              virtualClass: 'light',
              capabilities: ['onoff', 'dim', 'light_temperature', 'light_hue', 'light_saturation', 'light_mode'],
              onoff: false,
            }),
            capabilitiesObj: {
              onoff: { id: 'onoff', value: false },
              dim: { id: 'dim', value: 0.01 },
              light_temperature: { id: 'light_temperature', value: 1 },
              light_hue: { id: 'light_hue', value: 0.14 },
              light_saturation: { id: 'light_saturation', value: 0.68 },
              light_mode: { id: 'light_mode', value: 'temperature' },
            },
            energy: null,
            energyObj: {
              W: 0,
              approximation: null,
            },
          },
        }),
      },
      energy: {
        getLiveReport: async () => ({
          zoneId: 'zone-1',
          items: [
            { type: 'zone', id: 'z1', values: { W: 10 } },
            { type: 'device', id: 'some-other-device', values: { W: 0 } },
          ],
        }),
      },
    };

    await (app as any).refreshTargetDevicesSnapshot();
    await flushPromises();
    await flushPromises();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      powerCapable?: boolean;
      expectedPowerSource?: string;
      powerKw?: number;
    }>;
    const entry = snapshot.find((device) => device.id === 'device-a');
    expect(entry).toBeDefined();
    expect(entry).toEqual(expect.objectContaining({
      powerCapable: true,
      expectedPowerSource: 'default',
      powerKw: 1,
    }));

    const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
    const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
    expect(managed['device-a']).toBe(true);
    expect(controllable['device-a']).toBe(true);
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
    mockHomeyInstance.settings.set('managed_devices', { 'device-a': true });

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
    jest.advanceTimersByTime(100);
    await flushPromises();

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
    mockHomeyInstance.settings.set('managed_devices', { 'device-a': true });
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
    jest.advanceTimersByTime(100);
    await flushPromises();

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const planDevice = plan.devices.find((entry: any) => entry.id === 'device-a');
    expect(planDevice?.shedAction).toBe('turn_off');
    expect(planDevice?.plannedTarget).toBeNull();
    expect(planDevice?.currentTarget).toBeNull();
    expect(planDevice?.shedTemperature).toBeNull();
  });
});
