import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

describe('Expected power flow card', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    mockHomeyInstance.api.clearRealtimeEvents();
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
  });

  it('omits devices with settings.load from autocomplete lists', async () => {
    const deviceWithLoad = new MockDevice('dev-load', 'With Load', ['target_temperature']);
    deviceWithLoad.setSettings({ load: 800 });
    const deviceNoLoad = new MockDevice('dev-noload', 'No Load', ['target_temperature']);

    setMockDrivers({ driverA: new MockDriver('driverA', [deviceWithLoad, deviceNoLoad]) });

    const app = createApp();
    await app.onInit();

    const actionAutocomplete = mockHomeyInstance.flow._actionCardAutocompleteListeners.set_expected_power_usage?.device;
    expect(actionAutocomplete).toBeDefined();
    const actionOptions = await actionAutocomplete?.('') || [];
    expect(actionOptions).toEqual([{ id: 'dev-noload', name: 'No Load' }]);

    // Headroom condition also filters out devices with settings.load
    const condAutocompleteListener = (mockHomeyInstance.flow as any)._conditionCardAutocompleteListeners?.has_headroom_for_device?.device;
    expect(condAutocompleteListener).toBeDefined();
    const condOptions = await condAutocompleteListener?.('') || [];
    expect(condOptions).toEqual([{ id: 'dev-noload', name: 'No Load' }]);

    await app.onUninit?.();
  });

  it('sets temporary expected power until real measurement arrives', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff', 'measure_power']);
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    await expect(runAction({ device: { id: 'dev-1' }, power_w: 1500 })).resolves.toBe(true);

    const snapshot = (app as any).latestTargetSnapshot as Array<{ id: string; powerKw?: number }>;
    const snapDev = snapshot.find((d) => d.id === 'dev-1');
    expect(snapDev?.powerKw).toBeCloseTo(1.5);

    // When the device reports real power again, override is cleared
    await device.setCapabilityValue('measure_power', 2000);
    await (app as any).refreshTargetDevicesSnapshot();

    const refreshedSnapshot = (app as any).latestTargetSnapshot as Array<{ id: string; powerKw?: number }>;
    const refreshedDev = refreshedSnapshot.find((d) => d.id === 'dev-1');
    expect(refreshedDev?.powerKw).toBeCloseTo(2.0);
    // Override remains stored but measurement took precedence because it is newer
    expect((app as any).expectedPowerKwOverrides['dev-1']).toBeTruthy();
  });

  it('fails when device has configured load setting', async () => {
    const device = new MockDevice('dev-2', 'Heater', ['target_temperature']);
    device.setSettings({ load: 500 });

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    await expect(runAction({ device: { id: 'dev-2' }, power_w: 1200 })).rejects.toThrow('Device already has load configured in settings');
  });

  it('uses settings.load before overrides or measurements, then newest override/measurement, else 1kW', async () => {
    const device = new MockDevice('dev-3', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    device.setSettings({ load: 700 });
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    // With load set, should use it
    const snapshotWithLoad = (app as any).latestTargetSnapshot as Array<{ id: string; powerKw?: number }>;
    const snapWithLoad = snapshotWithLoad.find((d) => d.id === 'dev-3');
    expect(snapWithLoad?.powerKw).toBeCloseTo(0.7);

    // Remove load to test recency between override and measurement
    device.setSettings({ load: 0 });
    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    await runAction({ device: { id: 'dev-3' }, power_w: 1500 }); // override first
    await (app as any).refreshTargetDevicesSnapshot();
    const snapshotOverride = (app as any).latestTargetSnapshot as Array<{ id: string; powerKw?: number }>;
    const snapOverride = snapshotOverride.find((d) => d.id === 'dev-3');
    expect(snapOverride?.powerKw).toBeCloseTo(1.5);

    // Now report a measurement (later timestamp) - should take precedence
    await device.setCapabilityValue('measure_power', 900);
    await (app as any).refreshTargetDevicesSnapshot();
    const snapshotMeasured = (app as any).latestTargetSnapshot as Array<{ id: string; powerKw?: number }>;
    const snapMeasured = snapshotMeasured.find((d) => d.id === 'dev-3');
    expect(snapMeasured?.powerKw).toBeCloseTo(0.9);

    // Clear overrides and measurements -> fallback to 1kW
    (app as any).expectedPowerKwOverrides = {};
    (app as any).lastMeasuredPowerKw = {};
    const snapshotFallback = (app as any).parseDeviceList([
      {
        id: 'dev-3',
        capabilities: ['target_temperature'],
        capabilitiesObj: {},
        name: 'Heater',
        settings: {},
      },
    ]);
    expect(snapshotFallback[0]?.powerKw).toBe(1);
  });
});
