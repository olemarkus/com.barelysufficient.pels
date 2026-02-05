import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

jest.mock('../lib/app/appLifecycleHelpers', () => ({
  startAppServices: async (params: any) => {
    params.loadPowerTracker();
    params.loadPriceOptimizationSettings();
    params.initOptimizer();
    params.startHeartbeat();
    await params.updateOverheadToken();
    await params.refreshTargetDevicesSnapshot();
    await params.rebuildPlanFromCache();
    params.setLastNotifiedOperatingMode(params.getOperatingMode());
    params.registerFlowCards();
    params.startPeriodicSnapshotRefresh();
    // Intentionally skip price refresh/optimization timers to keep tests fast and deterministic.
  },
}));

const flushPromises = () => new Promise<void>((resolve) => {
  const queueMicrotaskFn = (globalThis as any).queueMicrotask as ((cb: () => void) => void) | undefined;
  if (typeof queueMicrotaskFn === 'function') {
    queueMicrotaskFn(() => resolve());
    return;
  }
  if (typeof setImmediate === 'function') {
    setImmediate(() => resolve());
    return;
  }
  setTimeout(() => resolve(), 0);
});

const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await flushPromises();
  }
};

describe('Mode device targets', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set('price_scheme', 'flow');
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
  });

  it('applies device targets when operating_mode or mode_device_targets changes', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });
    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    // Inject mock homeyApi that updates the actual device
    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'dev-1': {
            id: 'dev-1',
            name: 'Heater',
            class: 'heater',
            capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
            capabilitiesObj: {
              measure_power: { value: 1200, id: 'measure_power' },
              measure_temperature: { value: 21, id: 'measure_temperature' },
              target_temperature: { value: 20, id: 'target_temperature' },
            },
            settings: {},
          },
        }),
        setCapabilityValue: async ({ deviceId, capabilityId, value }: any) => {
          const drivers = mockHomeyInstance.drivers.getDrivers();
          for (const driver of Object.values(drivers)) {
            for (const device of driver.getDevices()) {
              if (device.idValue === deviceId) {
                await device.setCapabilityValue(capabilityId, value);
              }
            }
          }
        },
      },
    };

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 19 } });
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    await waitFor(() => heater.getSetCapabilityValue('target_temperature') === 19);

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(19);
  });

  it('updates temperatures when targets change for the active mode', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Preload active mode before app init.
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    // Inject mock homeyApi that updates the actual device
    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'dev-1': {
            id: 'dev-1',
            name: 'Heater',
            class: 'heater',
            capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
            capabilitiesObj: {
              measure_power: { value: 1200, id: 'measure_power' },
              measure_temperature: { value: 21, id: 'measure_temperature' },
              target_temperature: { value: 20, id: 'target_temperature' },
            },
            settings: {},
          },
        }),
        setCapabilityValue: async ({ deviceId, capabilityId, value }: any) => {
          const drivers = mockHomeyInstance.drivers.getDrivers();
          for (const driver of Object.values(drivers)) {
            for (const device of driver.getDevices()) {
              if (device.idValue === deviceId) {
                await device.setCapabilityValue(capabilityId, value);
              }
            }
          }
        },
      },
    };

    // Update targets for the current mode; should immediately apply.
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21.5 } });

    await waitFor(() => heater.getSetCapabilityValue('target_temperature') === 21.5);

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(21.5);
  });
});
