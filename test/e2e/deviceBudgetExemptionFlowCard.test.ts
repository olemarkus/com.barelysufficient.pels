import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

describe('Budget exemption flow cards', () => {
  beforeEach(() => {
    resetMockHomey();
    vi.clearAllTimers();
  });

  afterEach(async () => {
    // A refusal case spies on settings reads; a failing one must not leak its
    // spy into the cases after it.
    vi.restoreAllMocks();
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('adds a budget exemption for a device', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
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
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
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

  // The stored map holds other devices' exemptions, and the read the card makes
  // fails: the SDK's transient `null` on a listed key, or a value that is not a
  // boolean map. A map built from that read would hold only `dev-1`, so saving
  // it would erase every other exemption.
  it.each([
    ['reads back null', null],
    ['reads back malformed', [true]],
  ])('refuses to save over an exemption map that %s, and keeps every entry', async (_label, failedRead) => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    const stored = { 'dev-2': true, 'dev-3': true };
    mockHomeyInstance.settings.set('budget_exempt_devices', stored);

    const app = createApp();
    await app.onInit();

    const addListener = mockHomeyInstance.flow._actionCardListeners.add_budget_exemption;
    const settings = mockHomeyInstance.settings;
    const realGet = settings.get.bind(settings);
    const read = vi.spyOn(settings, 'get').mockImplementation((key: string) => (
      key === 'budget_exempt_devices' ? failedRead : realGet(key)
    ));
    const write = vi.spyOn(settings, 'set');

    await expect(addListener({ device: 'dev-1' }))
      .rejects.toThrow('PELS could not save the budget exemption. Try again shortly.');

    expect(write).not.toHaveBeenCalledWith('budget_exempt_devices', expect.anything());
    read.mockRestore();
    expect(settings.get('budget_exempt_devices')).toEqual(stored);

    await app.onUninit?.();
  });

  it('returns true when the device has a budget exemption', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
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
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
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
