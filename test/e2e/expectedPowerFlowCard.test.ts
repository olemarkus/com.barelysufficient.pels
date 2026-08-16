import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

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
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  // Neither autocomplete excludes a device that declares `settings.load` any
  // more. For the expected-power action a manual value outranks the declared
  // load, so overriding a wrong one is the point rather than a conflict; for the
  // headroom condition the exclusion never had a reason of its own.
  it('offers devices with settings.load in both autocompletes', async () => {
    const deviceWithLoad = new MockDevice('dev-load', 'With Load', ['target_temperature', 'measure_power']);
    await deviceWithLoad.setCapabilityValue('measure_power', 800);
    deviceWithLoad.setSettings({ load: 800 });
    const deviceNoLoad = new MockDevice('dev-noload', 'No Load', ['target_temperature', 'measure_power']);
    await deviceNoLoad.setCapabilityValue('measure_power', 0);

    setMockDrivers({ driverA: new MockDriver('driverA', [deviceWithLoad, deviceNoLoad]) });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-load': true, 'dev-noload': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-load': true, 'dev-noload': true });

    const app = createApp();
    await app.onInit();

    const actionAutocomplete = mockHomeyInstance.flow._actionCardAutocompleteListeners.set_expected_power_usage?.device;
    expect(actionAutocomplete).toBeDefined();
    const actionOptions = await actionAutocomplete?.('') || [];
    expect(actionOptions).toEqual([
      { id: 'dev-noload', name: 'No Load' },
      { id: 'dev-load', name: 'With Load' },
    ]);

    // The headroom condition no longer filters them out either. `loadKw` is gone
    // from the snapshot — `settings.load` is a settings read the producer already
    // consumed — and the exclusion had no reason of its own here: this card is a
    // READ ("is there available power for this device"), and a device declaring
    // its load is precisely one PELS has a good estimate for.
    const condAutocompleteListener = (mockHomeyInstance.flow as any)._conditionCardAutocompleteListeners?.has_headroom_for_device?.device;
    expect(condAutocompleteListener).toBeDefined();
    const condOptions = await condAutocompleteListener?.('') || [];
    expect(condOptions).toEqual([
      { id: 'dev-noload', name: 'No Load' },
      { id: 'dev-load', name: 'With Load' },
    ]);

    await app.onUninit?.();
  });

  it('omits auto-tracked observe-only battery/PV devices from the expected-power autocomplete', async () => {
    // A role-detected home battery (class:'battery') and PV (class:'solarpanel') are
    // FORCE-MANAGED observe-only devices: tracked in the snapshot but non-controllable,
    // so an expected-power override on them is a meaningless no-op pick. They must not
    // be OFFERED in the autocomplete. A normal controllable heater still IS.
    const heater = new MockDevice('dev-heater', 'Heater', ['target_temperature']);
    const battery = new MockDevice('dev-batt', 'Home Battery', ['measure_battery', 'measure_power'], 'battery');
    const solar = new MockDevice('dev-pv', 'Solar Roof', ['measure_power', 'meter_power'], 'solarpanel');

    setMockDrivers({ driverA: new MockDriver('driverA', [heater, battery, solar]) });
    // The user never opts the battery/PV into managed — they ride the snapshot purely
    // from role detection (managed observe-only). Only the heater is user-managed.
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-heater': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-heater': true });

    const app = createApp();
    await app.onInit();

    // Sanity: the observe-only devices DO ride the backend snapshot (still tracked).
    const snapshot = (app as any).latestTargetSnapshot as Array<{ id: string }>;
    expect(snapshot.map((d) => d.id)).toEqual(expect.arrayContaining(['dev-batt', 'dev-pv']));

    const actionAutocomplete = mockHomeyInstance.flow._actionCardAutocompleteListeners.set_expected_power_usage?.device;
    expect(actionAutocomplete).toBeDefined();
    const options = (await actionAutocomplete?.('') || []) as Array<{ id: string }>;
    const offeredIds = options.map((option: { id: string }) => option.id);
    expect(offeredIds).toContain('dev-heater');
    expect(offeredIds).not.toContain('dev-batt');
    expect(offeredIds).not.toContain('dev-pv');

    await app.onUninit?.();
  });

  // A manual value is an instruction and is NOT temporary: a later, higher
  // measurement no longer replaces it. The live draw still reaches restore sizing
  // through the measured axis (`getHighestKnownPowerKw` takes the max), so the
  // only thing that changed is that PELS stops rewriting what the owner typed.
  it('keeps the manual expected power when a real measurement arrives', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff', 'measure_power']);
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    await expect(runAction({ device: { id: 'dev-1' }, power_w: 1500 })).resolves.toBe(true);

    const snapshot = (app as any).latestTargetSnapshot as Array<{ id: string; expectedPowerKw?: number }>;
    const snapDev = snapshot.find((d) => d.id === 'dev-1');
    expect(snapDev?.expectedPowerKw).toBeCloseTo(1.5);

    // When the device reports real power again, override is cleared
    await device.setCapabilityValue('measure_power', 2000);
    await (app as any).refreshTargetDevicesSnapshot();

    const refreshedSnapshot = (app as any).latestTargetSnapshot as Array<{ id: string; expectedPowerKw?: number }>;
    const refreshedDev = refreshedSnapshot.find((d) => d.id === 'dev-1');
    expect(refreshedDev?.expectedPowerKw).toBeCloseTo(1.5);
    expect((app as any).expectedPowerKwOverrides['dev-1']).toBeTruthy();
  });

  it('does not rewrite override when requested expected power is unchanged', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff', 'measure_power']);
    await device.setCapabilityValue('onoff', true);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    (app as any).expectedPowerKwOverrides['dev-1'] = { kw: 1.25, ts: 12345 };
    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    await expect(runAction({ device: { id: 'dev-1' }, power_w: 1250 })).resolves.toBe(true);
    expect((app as any).expectedPowerKwOverrides['dev-1']).toEqual({ kw: 1.25, ts: 12345 });
  });

  // Was: rejected with "Device already has load configured in settings". That
  // refusal contradicted the agreed precedence — a manual value outranks
  // `settings.load` — and made the ladder's top rung unreachable for exactly the
  // owner most likely to need it: someone whose declared load is wrong.
  it('accepts an override on a device that declares settings.load, and that override wins', async () => {
    const device = new MockDevice('dev-2', 'Heater', ['target_temperature', 'measure_power']);
    await device.setCapabilityValue('measure_power', 1000);
    device.setSettings({ load: 500 });

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-2': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-2': true });

    const app = createApp();
    await app.onInit();

    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    await expect(runAction({ device: { id: 'dev-2' }, power_w: 1200 })).resolves.toBe(true);

    const snapshot = (app as any).latestTargetSnapshot as Array<{
      id: string; expectedPowerKw?: number; expectedPowerSource?: string;
    }>;
    const snapDev = snapshot.find((d) => d.id === 'dev-2');
    expect(snapDev?.expectedPowerKw).toBeCloseTo(1.2);
    expect(snapDev?.expectedPowerSource).toBe('manual');
  });

  it('rejects invalid payloads and stepped-load devices', async () => {
    const steppedDevice = new MockDevice('dev-step', 'Stepped Heater', ['onoff', 'measure_power']);
    await steppedDevice.setCapabilityValue('measure_power', 1000);
    const plainDevice = new MockDevice('dev-plain', 'Plain Heater', ['onoff', 'measure_power']);
    await plainDevice.setCapabilityValue('measure_power', 1000);

    setMockDrivers({ driverA: new MockDriver('driverA', [steppedDevice, plainDevice]) });
    mockHomeyInstance.settings.set('device_control_profiles', {
      'dev-step': {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-step': true, 'dev-plain': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-step': true, 'dev-plain': true });

    const app = createApp();
    await app.onInit();

    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    await expect(runAction({ power_w: 1000 })).rejects.toThrow('Device must be provided');
    await expect(runAction({ device: { id: 'dev-plain' }, power_w: 0 })).rejects.toThrow(
      'Expected power must be a positive number',
    );
    await expect(runAction({ device: { id: 'dev-step' }, power_w: 1000 })).rejects.toThrow(
      'Stepped load devices use configured planning power per step',
    );

    const actionAutocomplete = mockHomeyInstance.flow._actionCardAutocompleteListeners.set_expected_power_usage?.device;
    await expect(actionAutocomplete?.('plain')).resolves.toEqual([{ id: 'dev-plain', name: 'Plain Heater' }]);
    await expect(actionAutocomplete?.('missing')).resolves.toEqual([]);
  });

  it('rejects expected-power overrides for snapshot-only stepped-load devices', async () => {
    const device = new MockDevice('dev-target-power', 'Target Power Heater', ['onoff', 'measure_power']);
    await device.setCapabilityValue('measure_power', 1000);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('device_target_power_configs', {
      'dev-target-power': {
        enabled: true,
        max: 3000,
        step: 1500,
      },
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-target-power': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-target-power': true });

    const app = createApp();
    await app.onInit();

    const snapshot = (app as any).latestTargetSnapshot as Array<{ id: string; steppedLoadProfile?: unknown }>;
    expect(snapshot.find((entry) => entry.id === 'dev-target-power')?.steppedLoadProfile).toBeDefined();

    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    await expect(runAction({ device: { id: 'dev-target-power' }, power_w: 1000 })).rejects.toThrow(
      'Stepped load devices use configured planning power per step',
    );
  });

  // The whole ladder, end to end, in its agreed order:
  // manual › settings.load › measured peak › homey-energy › 1 kW default.
  it('walks the ladder: load, then a manual value that outranks it and survives measurement, else 1 kW', async () => {
    const device = new MockDevice('dev-3', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    device.setSettings({ load: 700 });
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    // With load set, should use it
    const snapshotWithLoad = (app as any).latestTargetSnapshot as Array<{ id: string; expectedPowerKw?: number }>;
    const snapWithLoad = snapshotWithLoad.find((d) => d.id === 'dev-3');
    expect(snapWithLoad?.expectedPowerKw).toBeCloseTo(0.7);

    // Remove load to test recency between override and measurement
    device.setSettings({ load: 0 });
    await (app as any).refreshTargetDevicesSnapshot();
    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    await runAction({ device: { id: 'dev-3' }, power_w: 1500 }); // override first
    await (app as any).refreshTargetDevicesSnapshot();
    const snapshotOverride = (app as any).latestTargetSnapshot as Array<{ id: string; expectedPowerKw?: number }>;
    const snapOverride = snapshotOverride.find((d) => d.id === 'dev-3');
    expect(snapOverride?.expectedPowerKw).toBeCloseTo(1.5);

    // A measurement below the manual value does not lower it.
    await device.setCapabilityValue('measure_power', 900);
    await (app as any).refreshTargetDevicesSnapshot();
    const snapshotMeasured = (app as any).latestTargetSnapshot as Array<{ id: string; expectedPowerKw?: number }>;
    const snapMeasured = snapshotMeasured.find((d) => d.id === 'dev-3');
    expect(snapMeasured?.expectedPowerKw).toBeCloseTo(1.5);

    // A measurement ABOVE the manual value no longer replaces it either. The old
    // ladder promoted it to `measured-peak`, so the number the owner typed could
    // be rewritten from underneath them; restore sizing still sees the live
    // 1.6 kW through the measured axis.
    await device.setCapabilityValue('measure_power', 1600);
    await (app as any).refreshTargetDevicesSnapshot();
    const snapshotHigh = (app as any).latestTargetSnapshot as Array<{
      id: string; expectedPowerKw?: number; expectedPowerSource?: string;
    }>;
    const snapHigh = snapshotHigh.find((d) => d.id === 'dev-3');
    expect(snapHigh?.expectedPowerKw).toBeCloseTo(1.5);
    expect(snapHigh?.expectedPowerSource).toBe('manual');

    // Clear overrides and measurements -> fallback to 1kW
    Object.keys((app as any).expectedPowerKwOverrides).forEach((k) => delete (app as any).expectedPowerKwOverrides[k]);
    Object.keys((app as any).lastPositiveMeasuredPowerKw).forEach((k) => delete (app as any).lastPositiveMeasuredPowerKw[k]);
    Object.keys((app as any).lastKnownPowerKw).forEach((k) => delete (app as any).lastKnownPowerKw[k]);
    const snapshotFallback = (app as any).deviceManager.parseDeviceListForTests([
      {
        id: 'dev-3',
        capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
        capabilitiesObj: {
          measure_temperature: { value: 20 },
          target_temperature: { value: 21 },
        },
        name: 'Heater',
        class: 'heater',
        settings: {},
      },
    ]);
    expect(snapshotFallback[0]?.expectedPowerKw).toBe(1);
  });
});
