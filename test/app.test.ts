import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';

// app.ts uses CommonJS export (module.exports = class ...)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MyApp = require('../app');

const GLOBAL_SETTING_KEY = 'global_target_temperature';

describe('MyApp applyGlobalTargetTemperature', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
  });

  it('sets target temperature on devices with target capabilities', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature']);
    const plainSwitch = new MockDevice('dev-2', 'Switch', ['onoff']);

    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
      driverB: new MockDriver('driverB', [plainSwitch]),
    });

    const app = new MyApp();
    await app.onInit();

    mockHomeyInstance.settings.set(GLOBAL_SETTING_KEY, 22);

    await new Promise((resolve) => setImmediate(resolve));

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(22);
    expect(plainSwitch.getSetCapabilityValue('target_temperature')).toBeUndefined();
  });

  it('ignores invalid target temperature values', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = new MyApp();
    await app.onInit();

    mockHomeyInstance.settings.set(GLOBAL_SETTING_KEY, 'not-a-number');
    await new Promise((resolve) => setImmediate(resolve));

    expect(heater.getSetCapabilityValue('target_temperature')).toBeUndefined();
  });
});
