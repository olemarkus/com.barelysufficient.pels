import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { getPerfSnapshot } from '../../lib/utils/perfCounters';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES } from '../../lib/utils/settingsKeys';

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

  it('refreshes and rebuilds once for a burst of Managed changes', async () => {
    const devices = Array.from({ length: 10 }, (_, index) =>
      new MockDevice(`heater-${index}`, `Heater ${index}`, ['measure_power', 'onoff']));
    for (const device of devices) {
      await device.setCapabilityValue('onoff', true);
      await device.setCapabilityValue('measure_power', 100);
    }
    setMockDrivers({ driverA: new MockDriver('driverA', devices) });
    const enabled = Object.fromEntries(devices.map(({ idValue }) => [idValue, true]));
    mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);

    const app = createApp();
    await app.onInit();
    const get = vi.spyOn(mockHomeyInstance.api, 'get');
    const fullReads = () => get.mock.calls.filter(([path]) => path === 'manager/devices/device');
    const rebuildCount = () => getPerfSnapshot().counts.plan_rebuild_total ?? 0;
    const startingRebuilds = rebuildCount();
    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_managed;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    try {
      let managed = enabled;
      for (const { idValue: id } of devices) {
        managed = { ...managed, [id]: false };
        mockHomeyInstance.settings.set(MANAGED_DEVICES, managed);
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(fullReads()).toHaveLength(0);
      await expect(runCondition({ device: { id: devices[0].idValue } })).resolves.toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      expect(fullReads()).toHaveLength(1);
      expect(rebuildCount() - startingRebuilds).toBe(1);
      for (const { idValue: id } of devices) {
        await expect(runCondition({ device: { id } })).resolves.toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the final Managed value after a Limit edit reloaded an intermediate value', async () => {
    const id = 'heater';
    const heater = new MockDevice(id, 'Heater', ['measure_power', 'onoff']);
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', 100);
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });

    const app = createApp();
    await app.onInit();
    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_managed;
    const isManaged = () => runCondition({ device: { id } });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    try {
      mockHomeyInstance.settings.set(MANAGED_DEVICES, { [id]: false });
      await vi.advanceTimersByTimeAsync(500);
      await expect(isManaged()).resolves.toBe(false);

      mockHomeyInstance.settings.set(MANAGED_DEVICES, { [id]: true });
      // The unbatched Limit handler adopts the intermediate Managed value.
      mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [id]: true });
      await vi.advanceTimersByTimeAsync(0);
      await expect(isManaged()).resolves.toBe(true);

      mockHomeyInstance.settings.set(MANAGED_DEVICES, { [id]: false });
      await vi.advanceTimersByTimeAsync(500);
      await expect(isManaged()).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
