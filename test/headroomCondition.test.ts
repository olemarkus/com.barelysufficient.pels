import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

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

    // Force a known headroom value
    const guard = (app as any).capacityGuard;
    guard.getHeadroom = () => 0.4; // kW

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

    const guard = (app as any).capacityGuard;
    guard.getHeadroom = () => 0.4;

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(true);

    await device.setCapabilityValue('measure_power', 1200);
    await (app as any).refreshTargetDevicesSnapshot();

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

    const guard = (app as any).capacityGuard;
    guard.getHeadroom = () => 0.4;

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    expect(runCondition).toBeDefined();

    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 0.9 })).resolves.toBe(true);

    await device.setCapabilityValue('measure_power', 490);
    await (app as any).refreshTargetDevicesSnapshot();
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

    const guard = (app as any).capacityGuard;
    guard.getHeadroom = () => 1.35;

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    const runSetExpected = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    expect(runCondition).toBeDefined();
    expect(runSetExpected).toBeDefined();

    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 3000 })).resolves.toBe(true);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(false);

    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 1750 })).resolves.toBe(true);

    const loweredSnapshot = ((app as any).latestTargetSnapshot as Array<{
      id: string;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
      measuredPowerKw?: number;
    }>).find((entry) => entry.id === 'dev-1');
    expect(loweredSnapshot?.expectedPowerKw).toBeCloseTo(1.75);
    expect(loweredSnapshot?.expectedPowerSource).toBe('manual');
    expect(loweredSnapshot?.measuredPowerKw).toBeCloseTo(1.19);

    await device.setCapabilityValue('measure_power', 2870);
    await (app as any).refreshTargetDevicesSnapshot();

    const raisedMeasurementSnapshot = ((app as any).latestTargetSnapshot as Array<{
      id: string;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
      measuredPowerKw?: number;
    }>).find((entry) => entry.id === 'dev-1');
    expect(raisedMeasurementSnapshot?.expectedPowerKw).toBeCloseTo(2.87);
    expect(raisedMeasurementSnapshot?.expectedPowerSource).toBe('measured-peak');
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

    const guard = (app as any).capacityGuard;
    guard.getHeadroom = () => 2.28;

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    const runSetExpected = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    expect(runCondition).toBeDefined();
    expect(runSetExpected).toBeDefined();

    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 3000 })).resolves.toBe(true);
    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 1750 })).resolves.toBe(true);

    await device.setCapabilityValue('measure_power', 2870);
    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = ((app as any).latestTargetSnapshot as Array<{
      id: string;
      expectedPowerKw?: number;
      expectedPowerSource?: string;
      measuredPowerKw?: number;
    }>).find((entry) => entry.id === 'dev-1');
    expect(snapshot?.expectedPowerKw).toBeCloseTo(2.87);
    expect(snapshot?.expectedPowerSource).toBe('measured-peak');
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

    const guard = (app as any).capacityGuard;
    let currentPowerKw = 4.28;
    guard.getSoftLimit = () => 4.5;
    guard.getLastTotalPower = () => currentPowerKw;
    guard.getHeadroom = () => 4.5 - currentPowerKw;

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    const runSetExpected = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    expect(runCondition).toBeDefined();
    expect(runSetExpected).toBeDefined();

    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 3000 })).resolves.toBe(true);

    vi.advanceTimersByTime(2389);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(false);

    currentPowerKw = 3.02;
    vi.advanceTimersByTime(5049);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(true);

    currentPowerKw = 4.21;
    vi.advanceTimersByTime(53985);
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 3.0 })).resolves.toBe(false);

    vi.advanceTimersByTime(1468);
    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 1750 })).resolves.toBe(true);

    await device.setCapabilityValue('measure_power', 2870);
    await (app as any).refreshTargetDevicesSnapshot();
    currentPowerKw = 4.23;

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

    const guard = (app as any).capacityGuard;
    guard.getHeadroom = () => 0.4;

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    expect(runCondition).toBeDefined();

    (app as any).planEngine.state.lastDeviceShedMs['dev-1'] = Date.now();
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 0.9 })).resolves.toBe(false);
    await expect(runCondition({ device: { id: 'dev-2' }, required_kw: 0.9 })).resolves.toBe(true);

    delete (app as any).planEngine.state.lastDeviceShedMs['dev-1'];
    (app as any).planEngine.state.lastDeviceRestoreMs['dev-1'] = Date.now();
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 0.9 })).resolves.toBe(false);
    await expect(runCondition({ device: { id: 'dev-2' }, required_kw: 0.9 })).resolves.toBe(true);
  });
});
