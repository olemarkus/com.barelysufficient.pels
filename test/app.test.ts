import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';

// app.ts uses CommonJS export (module.exports = class ...)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MyApp = require('../app');

describe('MyApp initialization', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
  });

  it('initializes and creates device snapshot', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);

    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = new MyApp();
    await app.onInit();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot');
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot[0]).toMatchObject({
      name: 'Heater',
    });
  });

  it('set_capacity_mode flow card changes mode and persists to settings', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = new MyApp();
    await app.onInit();

    // Get the registered listener for set_capacity_mode
    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    expect(setModeListener).toBeDefined();

    // Call the flow card with a new mode
    const result = await setModeListener({ mode: 'Away' });
    expect(result).toBe(true);

    // Verify mode was persisted to settings
    expect(mockHomeyInstance.settings.get('capacity_mode')).toBe('Away');

    // Verify internal state was updated
    expect((app as any).capacityMode).toBe('Away');
  });

  it('set_capacity_mode flow card throws if mode is empty', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = new MyApp();
    await app.onInit();

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];

    await expect(setModeListener({ mode: '' })).rejects.toThrow('Mode must be provided');
    await expect(setModeListener({ mode: '   ' })).rejects.toThrow('Mode must be provided');
  });

  it('set_capacity_mode flow card handles autocomplete object format', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = new MyApp();
    await app.onInit();

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];

    // Autocomplete returns an object with id and name, not a plain string
    const result = await setModeListener({ mode: { id: 'Away', name: 'Away' } });
    expect(result).toBe(true);

    expect(mockHomeyInstance.settings.get('capacity_mode')).toBe('Away');
    expect((app as any).capacityMode).toBe('Away');
  });

  it('set_capacity_mode applies device targets when not in dry run', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set up mode targets before init
    mockHomeyInstance.settings.set('mode_device_targets', { Away: { 'dev-1': 16 } });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    // Inject mock homeyApi
    const setCapSpy = jest.fn().mockResolvedValue(undefined);
    (app as any).homeyApi = {
      devices: {
        getDevices: async () => ({
          'dev-1': {
            id: 'dev-1',
            name: 'Heater',
            capabilities: ['target_temperature', 'onoff'],
            capabilitiesObj: { target_temperature: { value: 20 }, onoff: { value: true } },
            settings: {},
          },
        }),
        setCapabilityValue: setCapSpy,
      },
    };

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    await setModeListener({ mode: 'Away' });

    // Verify setCapabilityValue was called to apply the target
    expect(setCapSpy).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      value: 16,
    });
  });
});
