import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MyApp = require('../app');

describe('Mode device targets', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
  });

  it('applies device targets when capacity_mode or mode_device_targets changes', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = new MyApp();
    await app.onInit();

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 19 } });
    mockHomeyInstance.settings.set('capacity_mode', 'Home');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(19);
  });

  it('updates temperatures when targets change for the active mode', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Preload active mode before app init.
    mockHomeyInstance.settings.set('capacity_mode', 'Home');

    const app = new MyApp();
    await app.onInit();

    // Update targets for the current mode; should immediately apply.
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21.5 } });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(21.5);
  });
});
