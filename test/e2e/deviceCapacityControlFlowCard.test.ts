import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { buildSetpointBatteryDevice } from '../helpers/homeBatteryMock';

describe('Capacity control device condition', () => {
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
    vi.clearAllTimers();
  });

  afterEach(async () => {
    // A refusal case spies on settings reads; a failing one must not leak its
    // spy into the cases after it.
    vi.restoreAllMocks();
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('returns true when the device is capacity controlled', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_capacity_controlled;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' } })).resolves.toBe(true);

    await app.onUninit?.();
  });

  it('returns false when the device is not capacity controlled', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': false });

    const app = createApp();
    await app.onInit();

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_capacity_controlled;
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

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_capacity_controlled;
    expect(runCondition).toBeDefined();

    await expect(runCondition(null)).resolves.toBe(false);
    await expect(runCondition({ device: '' })).resolves.toBe(false);
    await expect(runCondition({ device: { id: 'missing' } })).resolves.toBe(false);

    await app.onUninit?.();
  });

  it('returns false for a device the owner never opted in', async () => {
    // No `managed_devices` or `controllable_devices` entry: the app reads the
    // device as not capacity controlled. (A managed device with no
    // capacity-control entry is migrated to controlled at startup.)
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    // The card knows the device: `false` here is an answer about it, not the
    // unknown-device fallback.
    const autocomplete = mockHomeyInstance.flow._conditionCardAutocompleteListeners.is_device_capacity_controlled.device;
    const offered = ((await autocomplete('')) as Array<{ id: string }>).map((option) => option.id);
    expect(offered).toContain('dev-1');

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_capacity_controlled;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' } })).resolves.toBe(false);

    await app.onUninit?.();
  });

  // The stored map holds other devices' capacity control, and the read the
  // card makes fails: the SDK's transient `null` on a listed key, or a value
  // that is not a boolean map. A map built from that read would hold only
  // `dev-1`, so saving it would hand every other device out of capacity control.
  it.each([
    ['enable_device_capacity_control', 'reads back null', null],
    ['disable_device_capacity_control', 'reads back null', null],
    ['enable_device_capacity_control', 'reads back malformed', 'not-a-map'],
    ['disable_device_capacity_control', 'reads back malformed', 'not-a-map'],
  ])('%s refuses to save over a map that %s, and keeps every entry', async (cardId, _label, failedRead) => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true, 'dev-2': true });
    const stored = { 'dev-1': true, 'dev-2': true };
    mockHomeyInstance.settings.set('controllable_devices', stored);

    const app = createApp();
    await app.onInit();

    const listener = mockHomeyInstance.flow._actionCardListeners[cardId];
    const settings = mockHomeyInstance.settings;
    const realGet = settings.get.bind(settings);
    const read = vi.spyOn(settings, 'get').mockImplementation((key: string) => (
      key === 'controllable_devices' ? failedRead : realGet(key)
    ));
    const write = vi.spyOn(settings, 'set');

    await expect(listener({ device: 'dev-1' }))
      .rejects.toThrow('PELS could not save the power-limit control. Try again shortly.');

    expect(write).not.toHaveBeenCalledWith('controllable_devices', expect.anything());
    read.mockRestore();
    expect(settings.get('controllable_devices')).toEqual(stored);

    await app.onUninit?.();
  });

  it('answers for a home battery by whether PELS can drive it, and grants Power-limit control only to one it can', async () => {
    const drivable = buildSetpointBatteryDevice({ id: 'batt-drive', claimValue: 'anti_feed' });
    // Mode-only: its app reports power and level but gives Homey no setpoint.
    const modeOnly = new MockDevice('batt-mode', 'Mode battery', ['measure_battery', 'measure_power'], 'battery');
    await modeOnly.setCapabilityValue('measure_battery', 40);
    await modeOnly.setCapabilityValue('measure_power', 0);
    setMockDrivers({ batteries: new MockDriver('batteries', [drivable, modeOnly]) });

    const app = createApp();
    await app.onInit();

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_capacity_controlled;
    await expect(runCondition({ device: { id: 'batt-drive' } })).resolves.toBe(true);
    await expect(runCondition({ device: { id: 'batt-mode' } })).resolves.toBe(false);

    const enableOptions = await mockHomeyInstance.flow._actionCardAutocompleteListeners
      .enable_device_capacity_control.device('') as Array<{ id: string }>;
    expect(enableOptions.map((option) => option.id)).toContain('batt-drive');
    expect(enableOptions.map((option) => option.id)).not.toContain('batt-mode');

    const enable = mockHomeyInstance.flow._actionCardListeners.enable_device_capacity_control;
    await enable({ device: { id: 'batt-mode' } });
    expect(mockHomeyInstance.settings.get('controllable_devices') ?? {}).not.toHaveProperty('batt-mode');
    await enable({ device: { id: 'batt-drive' } });
    expect(mockHomeyInstance.settings.get('controllable_devices')).toMatchObject({ 'batt-drive': true });

    await app.onUninit?.();
  });
});
