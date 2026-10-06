import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { transportSnapshotFixtures } from '../utils/deviceSnapshotFixture';
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

  it('returns false when controllable is undefined in the snapshot', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 1000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    app.deviceManager.setSnapshotForTests(transportSnapshotFixtures([{ available: true, expectedPowerKw: 0, expectedPowerSource: 'default', id: 'dev-1', name: 'Heater', targets: [] }]));

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.is_device_capacity_controlled;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' } })).resolves.toBe(false);

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
