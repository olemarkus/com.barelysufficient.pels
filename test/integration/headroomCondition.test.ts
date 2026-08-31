import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

describe('Headroom for device condition', () => {
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
    vi.useRealTimers();
  });

  it('returns true only when headroom plus device estimate meets the required kW', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await device.setCapabilityValue('measure_power', 600); // 0.6 kW measured
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();
    app.computeDynamicSoftLimit = () => 0.4; // kW
    app.powerTracker = { ...app.powerTracker, lastPowerW: 0 };

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    expect(runCondition).toBeDefined();

    // headroom (0.4) + device estimate (0.6) = 1.0 >= 0.9 -> true
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 0.9 })).resolves.toBe(true);
    // headroom (0.4) + device estimate (0.6) = 1.0 >= 1.2 -> false
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 1.2 })).resolves.toBe(false);

    await app.onUninit?.();
  });

  it('does not block headroom when only measured power drops, because expected usage was not lowered', async () => {
    const device = new MockDevice('dev-1', 'Charger', ['measure_power', 'onoff']);
    await device.setCapabilityValue('measure_power', 3000);
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    app.computeDynamicSoftLimit = () => 0.4;
    app.powerTracker = { ...app.powerTracker, lastPowerW: 0 };

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(true);

    await device.setCapabilityValue('measure_power', 1200);
    await app.refreshTargetDevicesSnapshot();

    // The device may have reached a setpoint. That should not create a cooldown by itself.
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 1.5 })).resolves.toBe(true);
  });

  it('does not create a cooldown on first observation or on small drops below the noise threshold', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('measure_power', 600);
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    app.computeDynamicSoftLimit = () => 0.4;
    app.powerTracker = { ...app.powerTracker, lastPowerW: 0 };

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 0.9 })).resolves.toBe(true);

    await device.setCapabilityValue('measure_power', 490);
    await app.refreshTargetDevicesSnapshot();
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 0.8 })).resolves.toBe(true);
  });

  it('does not keep headroom blocked after expected power is lowered if measured draw rises again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T14:07:20.000Z'));

    const device = new MockDevice('dev-1', 'Connected 300', ['measure_power', 'onoff']);
    await device.setCapabilityValue('measure_power', 1190);
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    app.computeDynamicSoftLimit = () => 1.35;
    app.powerTracker = { ...app.powerTracker, lastPowerW: 0 };

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    const runSetExpected = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    expect(runCondition).toBeDefined();
    expect(runSetExpected).toBeDefined();

    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 3000 })).resolves.toBe(true);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(false);

    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 1750 })).resolves.toBe(true);

    const loweredSnapshot = (app.latestTargetSnapshot as Array<{
      id: string;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
      measuredPowerKw?: number;
    }>).find((entry) => entry.id === 'dev-1');
    expect(loweredSnapshot?.expectedPowerKw).toBeCloseTo(1.75);
    expect(loweredSnapshot?.expectedPowerSource).toBe('manual');
    expect(loweredSnapshot?.measuredPowerKw).toBeCloseTo(1.19);

    await device.setCapabilityValue('measure_power', 2870);
    await app.refreshTargetDevicesSnapshot();

    const raisedMeasurementSnapshot = (app.latestTargetSnapshot as Array<{
      id: string;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
      measuredPowerKw?: number;
    }>).find((entry) => entry.id === 'dev-1');
    // The manual value STAYS — it is an instruction, and a higher measurement no
    // longer rewrites it. The headroom answer below is unaffected, because the
    // condition sizes on the highest KNOWN source and the live 2.87 kW reaches it
    // through the measured axis rather than by overwriting what the owner typed.
    expect(raisedMeasurementSnapshot?.expectedPowerKw).toBeCloseTo(1.75);
    expect(raisedMeasurementSnapshot?.expectedPowerSource).toBe('manual');
    expect(raisedMeasurementSnapshot?.measuredPowerKw).toBeCloseTo(2.87);

    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(true);

    vi.advanceTimersByTime(60 * 1000);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(true);
  });

  it('allows when the first headroom check happens only after expected power was lowered and measurement rose again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T14:36:40.000Z'));

    const device = new MockDevice('dev-1', 'Connected 300', ['measure_power', 'onoff']);
    await device.setCapabilityValue('measure_power', 1190);
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    app.computeDynamicSoftLimit = () => 2.28;
    app.powerTracker = { ...app.powerTracker, lastPowerW: 0 };

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    const runSetExpected = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    expect(runCondition).toBeDefined();
    expect(runSetExpected).toBeDefined();

    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 3000 })).resolves.toBe(true);
    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 1750 })).resolves.toBe(true);

    await device.setCapabilityValue('measure_power', 2870);
    await app.refreshTargetDevicesSnapshot();

    const snapshot = (app.latestTargetSnapshot as Array<{
      id: string;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
      measuredPowerKw?: number;
    }>).find((entry) => entry.id === 'dev-1');
    // Same inversion as above: the manual value survives the higher measurement,
    // and the condition still allows because it sizes on the highest known
    // source, which the live 2.87 kW reaches through the measured axis.
    expect(snapshot?.expectedPowerKw).toBeCloseTo(1.75);
    expect(snapshot?.expectedPowerSource).toBe('manual');
    expect(snapshot?.measuredPowerKw).toBeCloseTo(2.87);

    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(true);
  });

  it('allows after lowering expected power late in the session when a later measured-peak check passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T14:51:45.274Z'));

    const device = new MockDevice('dev-1', 'Connected 300', ['measure_power', 'onoff']);
    await device.setCapabilityValue('measure_power', 1670);
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    app.computeDynamicSoftLimit = () => 4.5;
    const setPowerKw = (kw: number) => {
      app.powerTracker = { ...app.powerTracker, lastPowerW: kw * 1000 };
    };
    setPowerKw(4.28);

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    const runSetExpected = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    expect(runCondition).toBeDefined();
    expect(runSetExpected).toBeDefined();

    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 3000 })).resolves.toBe(true);

    vi.advanceTimersByTime(2389);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(false);

    setPowerKw(3.02);
    vi.advanceTimersByTime(5049);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(true);

    setPowerKw(4.21);
    vi.advanceTimersByTime(53985);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(false);

    vi.advanceTimersByTime(1468);
    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 1750 })).resolves.toBe(true);

    await device.setCapabilityValue('measure_power', 2870);
    await app.refreshTargetDevicesSnapshot();
    setPowerKw(4.23);

    vi.advanceTimersByTime(2721);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(true);
  });

  it('blocks only the same device during recent PELS shed or restore cooldowns', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T12:00:00.000Z'));

    const deviceA = new MockDevice('dev-1', 'Heater A', ['measure_power', 'onoff']);
    const deviceB = new MockDevice('dev-2', 'Heater B', ['measure_power', 'onoff']);
    await deviceA.setCapabilityValue('measure_power', 600);
    await deviceA.setCapabilityValue('onoff', true);
    await deviceB.setCapabilityValue('measure_power', 600);
    await deviceB.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [deviceA, deviceB]) });

    const app = createApp();
    await app.onInit();

    app.computeDynamicSoftLimit = () => 0.4;
    app.powerTracker = { ...app.powerTracker, lastPowerW: 0 };

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    expect(runCondition).toBeDefined();

    app.planEngine.state.lastDeviceShedMs['dev-1'] = Date.now();
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 0.9 })).resolves.toBe(false);
    await expect(runCondition({ device: { id: 'dev-2' }, required_kw: 0.9 })).resolves.toBe(true);

    delete app.planEngine.state.lastDeviceShedMs['dev-1'];
    app.planEngine.state.lastDeviceRestoreMs['dev-1'] = Date.now();
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 0.9 })).resolves.toBe(false);
    await expect(runCondition({ device: { id: 'dev-2' }, required_kw: 0.9 })).resolves.toBe(true);
  });
});
