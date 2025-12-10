import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate', 'Date'] });

describe('Mode device targets', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
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

    const app = createApp();
    await app.onInit();

    // Inject mock homeyApi that updates the actual device
    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'dev-1': {
            id: 'dev-1',
            name: 'Heater',
            capabilities: ['target_temperature'],
            capabilitiesObj: { target_temperature: { value: 20, id: 'target_temperature' } },
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

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(19);
  });

  it('updates temperatures when targets change for the active mode', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Preload active mode before app init.
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    const app = createApp();
    await app.onInit();

    // Inject mock homeyApi that updates the actual device
    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'dev-1': {
            id: 'dev-1',
            name: 'Heater',
            capabilities: ['target_temperature'],
            capabilitiesObj: { target_temperature: { value: 20, id: 'target_temperature' } },
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

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(21.5);
  });
});
