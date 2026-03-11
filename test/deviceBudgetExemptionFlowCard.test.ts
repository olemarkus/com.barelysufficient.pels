import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

describe('Budget exemption flow cards', () => {
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
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
  });

  it('adds a budget exemption for a device', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    const addListener = mockHomeyInstance.flow._actionCardListeners.add_budget_exemption;
    expect(addListener).toBeDefined();

    await expect(addListener({ device: 'dev-1' })).resolves.toBe(true);
    expect(mockHomeyInstance.settings.get('budget_exempt_devices')).toEqual({ 'dev-1': true });

    await app.onUninit?.();
  });

  it('removes a budget exemption for a device', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('budget_exempt_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    const removeListener = mockHomeyInstance.flow._actionCardListeners.remove_budget_exemption;
    expect(removeListener).toBeDefined();

    await expect(removeListener({ device: { id: 'dev-1', name: 'Heater' } })).resolves.toBe(true);
    expect(mockHomeyInstance.settings.get('budget_exempt_devices')).toEqual({ 'dev-1': false });

    await app.onUninit?.();
  });

  it('returns true when the device has a budget exemption', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('budget_exempt_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_budget_exempt;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' } })).resolves.toBe(true);

    await app.onUninit?.();
  });

  it('returns false when the device does not have a budget exemption', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('budget_exempt_devices', { 'dev-1': false });

    const app = createApp();
    await app.onInit();

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_budget_exempt;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' } })).resolves.toBe(false);

    await app.onUninit?.();
  });
});
