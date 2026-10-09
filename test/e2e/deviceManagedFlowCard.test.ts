import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

describe('Managed device condition', () => {
  beforeEach(() => {
    resetMockHomey();
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('returns true when the device is managed by PELS', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_managed;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' } })).resolves.toBe(true);

    await app.onUninit?.();
  });

  it('returns false when the device is explicitly unmanaged', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': false });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_managed;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' } })).resolves.toBe(false);

    await app.onUninit?.();
  });

  it('returns false for missing device args or unknown devices', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_managed;
    expect(runCondition).toBeDefined();

    await expect(runCondition(null)).resolves.toBe(false);
    await expect(runCondition({ device: '' })).resolves.toBe(false);
    await expect(runCondition({ device: { id: 'missing' } })).resolves.toBe(false);

    await app.onUninit?.();
  });

  it('returns false for a device the owner never set Managed for', async () => {
    // No `managed_devices` entry at all: the app reads the device as not managed
    // and, with no device opted in, still carries it in the runtime snapshot.
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    // The card knows the device: `false` here is an answer about it, not the
    // unknown-device fallback.
    const autocomplete = mockHomeyInstance.flow._conditionCardAutocompleteListeners.is_device_managed.device;
    const offered = ((await autocomplete('')) as Array<{ id: string }>).map((option) => option.id);
    expect(offered).toContain('dev-1');

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_managed;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' } })).resolves.toBe(false);

    await app.onUninit?.();
  });
});
