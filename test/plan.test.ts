import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate', 'Date'] });

// Factory for creating a Hoiax Connected 300 water heater mock
function createHoiaxWaterHeater(id: string, name: string = 'Connected 300') {
  const device = new MockDevice(id, name, [
    'meter_power.in_tank',
    'meter_power',
    'measure_power',
    'measure_humidity.fill_level',
    'target_temperature',
    'measure_temperature',
    'onoff.hwBoost',
    'onoff',
    'max_power_3000',
  ]);
  // Set realistic default values
  device.setCapabilityValue('measure_power', 0);
  device.setCapabilityValue('target_temperature', 65);
  device.setCapabilityValue('onoff', true);
  device.setCapabilityValue('max_power_3000', '3'); // Max power by default
  return device;
}

describe('Device plan snapshot', () => {
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

  it('emits plan_updated realtime event when plan changes', async () => {
    const device = new MockDevice('dev-1', 'Test Heater', ['target_temperature', 'measure_power']);
    await device.setCapabilityValue('measure_power', 1000);

    setMockDrivers({
      driverA: new MockDriver('driverA', [device]),
    });

    const app = createApp();
    await app.onInit();

    // Clear events from initialization
    mockHomeyInstance.api.clearRealtimeEvents();

    // Trigger a plan rebuild by recording power
    await (app as any).recordPowerSample(1000);

    // Check that plan_updated event was emitted
    const planEvents = mockHomeyInstance.api._realtimeEvents.filter((e) => e.event === 'plan_updated');
    expect(planEvents.length).toBeGreaterThan(0);

    // Verify the event data contains the plan
    const lastPlanEvent = planEvents[planEvents.length - 1];
    expect(lastPlanEvent.data).toHaveProperty('meta');
    expect(lastPlanEvent.data).toHaveProperty('devices');
    expect(Array.isArray(lastPlanEvent.data.devices)).toBe(true);
  });

  it('sheds devices with higher priority NUMBER first (priority 1 = most important, shed last)', async () => {
    // Priority 1 = most important = should be kept longest
    // Priority 10 = least important = should be shed first
    const dev1 = new MockDevice('dev-1', 'Important Heater', ['target_temperature', 'measure_power']);
    const dev2 = new MockDevice('dev-2', 'Less Important Heater', ['target_temperature', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 5000); // 5 kW
    await dev2.setCapabilityValue('measure_power', 4000); // 4 kW

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2]),
    });

    // dev-1 is priority 1 (most important), dev-2 is priority 10 (less important)
    // When over limit, dev-2 should be shed first
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1, 'dev-2': 10 } });

    const app = createApp();
    await app.onInit();

    // Deterministic soft limit for the test.
    (app as any).computeDynamicSoftLimit = () => 9;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 9);
    }

    // Report 12 kW total; over the 9 kW soft limit
    await (app as any).recordPowerSample(12000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan).toBeTruthy();

    // dev-2 (priority 10, less important) should be shed
    const dev2Plan = plan.devices.find((d: any) => d.id === 'dev-2');
    expect(dev2Plan?.plannedState).toBe('shed');

    // dev-1 (priority 1, most important) should be kept
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan?.plannedState).toBe('keep');
  });

  it('marks less important devices as shed when over soft limit (priority 1 = most important)', async () => {
    const dev1 = new MockDevice('dev-1', 'Important Heater', ['target_temperature', 'measure_power']);
    const dev2 = new MockDevice('dev-2', 'Less Important Heater', ['target_temperature', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 5000); // 5 kW
    await dev2.setCapabilityValue('measure_power', 4000); // 4 kW

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2]),
    });

    // dev-1 is priority 1 (most important), dev-2 is priority 10 (less important)
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1, 'dev-2': 10 } });

    const app = createApp();
    await app.onInit();

    // Deterministic soft limit for the test.
    (app as any).computeDynamicSoftLimit = () => 9;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 9);
    }

    // Report 12 kW total; over the 9 kW soft limit
    await (app as any).recordPowerSample(12000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan).toBeTruthy();
    // dev-2 (priority 10, less important) should be shed first
    const dev2Plan = plan.devices.find((d: any) => d.id === 'dev-2');
    expect(dev2Plan?.plannedState).toBe('shed');
    // dev-1 (priority 1, most important) should be kept
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan?.plannedState).toBe('keep');
  });

  it('sets a shed temperature instead of turning off when configured', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 21);
    await dev1.setCapabilityValue('measure_power', 4000); // 4 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 15 } });

    const app = createApp();
    await app.onInit();

    // Force overshoot
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    await (app as any).recordPowerSample(5000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.shedAction).toBe('set_temperature');
    expect(devPlan?.plannedTarget).toBe(15);
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.reason).toContain('shed');
  });

  it('uses concise reason when shedding to a minimum temperature', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 21);
    await dev1.setCapabilityValue('measure_power', 4000); // 4 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 16 } });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    await (app as any).recordPowerSample(5000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.reason).toContain('shed');
  });

  it('keeps a device marked as shed when it is already at its shed temperature', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 16); // already set to min temp
    await dev1.setCapabilityValue('measure_power', 0);
    await dev1.setCapabilityValue('onoff', false); // currently off, so would not be selected as a shed candidate

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 16 } });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }

    await (app as any).recordPowerSample(1000); // force overshoot (will try to shed but already at min temp)

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.reason).toContain('shed due to capacity');
  });

  it('uses the same shed reason for minimum-temperature shedding and turn-off shedding', async () => {
    const minTempDev = new MockDevice('dev-min', 'Min Temp', ['target_temperature', 'measure_power', 'onoff']);
    await minTempDev.setCapabilityValue('target_temperature', 20);
    await minTempDev.setCapabilityValue('measure_power', 1000); // 1 kW
    await minTempDev.setCapabilityValue('onoff', true);

    const offDev = new MockDevice('dev-off', 'Turn Off', ['target_temperature', 'measure_power', 'onoff']);
    await offDev.setCapabilityValue('target_temperature', 20);
    await offDev.setCapabilityValue('measure_power', 800); // 0.8 kW
    await offDev.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [minTempDev, offDev]),
    });

    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-min': 11, 'dev-off': 10 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-min': { action: 'set_temperature', temperature: 16 } });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }

    await (app as any).recordPowerSample(1800); // total 1.8 kW -> shed both

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const minPlan = plan.devices.find((d: any) => d.id === 'dev-min');
    const offPlan = plan.devices.find((d: any) => d.id === 'dev-off');

    expect(minPlan?.plannedState).toBe('shed');
    expect(minPlan?.shedAction).toBe('set_temperature');
    expect(minPlan?.plannedTarget).toBe(16);
    expect(minPlan?.reason).toContain('shed due to capacity');

    expect(offPlan?.plannedState).toBe('shed');
    expect(offPlan?.shedAction).toBe('turn_off');
    expect(offPlan?.reason).toContain('shed due to capacity');
  });

  it('uses shortfall reason for minimum-temperature shedding when in shortfall', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 21);
    await dev1.setCapabilityValue('measure_power', 1200); // 1.2 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 16 } });

    const app = createApp();
    await app.onInit();

    // Force shortfall state and an overshoot so shedding occurs.
    (app as any).capacityGuard.isInShortfall = () => true;
    (app as any).inShortfall = true;
    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }
    await (app as any).recordPowerSample(1200);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.shedAction).toBe('set_temperature');
    expect(devPlan?.reason).toBe('temperature lowered while in capacity shortfall');
  });

  it('keeps a min-temperature shed device marked as shed during cooldown even if its target was overwritten', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 21);
    await dev1.setCapabilityValue('measure_power', 1200); // 1.2 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 16 } });

    const app = createApp();
    await app.onInit();

    // Trigger an initial shed to set deviceLastShedMs.
    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }
    await (app as any).recordPowerSample(1200);

    expect(await dev1.getCapabilityValue('target_temperature')).toBe(16);

    // Force cooldown window for device by keeping lastDeviceShedMs recent.
    (app as any).lastDeviceShedMs['dev-1'] = Date.now();
    (app as any).lastSheddingMs = Date.now();

    // Now plan with ample headroom but still within cooldown.
    (app as any).computeDynamicSoftLimit = () => 5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 5);
    }
    await (app as any).recordPowerSample(500);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.plannedTarget).toBe(16);
    expect(devPlan?.reason).toContain('cooldown');
  });

  it('does not overwrite a shed device target when applying mode targets', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 21);
    await dev1.setCapabilityValue('measure_power', 4000); // 4 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 16 } });

    const app = createApp();
    await app.onInit();

    // Trigger shed to set min-temp.
    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }
    await (app as any).recordPowerSample(5000);

    expect(await dev1.getCapabilityValue('target_temperature')).toBe(16);

    // Apply mode targets while device is shed; should be skipped.
    await (app as any).applyDeviceTargetsForMode('Home');

    // Rebuild plan to reflect current snapshot.
    (app as any).computeDynamicSoftLimit = () => 5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 5);
    }
    await (app as any).recordPowerSample(500);

    expect(await dev1.getCapabilityValue('target_temperature')).toBe(16);
    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.plannedTarget).toBe(16);
  });

  it('keeps minimum-temperature shedding in cooldown while leaving power on', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 21);
    await dev1.setCapabilityValue('measure_power', 1200); // 1.2 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 16 } });

    const app = createApp();
    await app.onInit();

    // Initial overshoot to start shedding and record timestamps.
    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }
    await (app as any).recordPowerSample(1200);

    // Force cooldown window and rebuild plan with available headroom.
    (app as any).lastSheddingMs = Date.now();
    (app as any).lastOvershootMs = Date.now();
    (app as any).computeDynamicSoftLimit = () => 5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 5);
    }

    await (app as any).recordPowerSample(500);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.shedAction).toBe('set_temperature');
    expect(devPlan?.plannedTarget).toBe(16);
    expect(devPlan?.reason).toContain('stay shed during cooldown before restore');
  });

  it('restores minimum-temperature shedding after cooldown with normal reason and targets', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 21);
    await dev1.setCapabilityValue('measure_power', 1200); // 1.2 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 16 } });

    const app = createApp();
    await app.onInit();

    // Initial overshoot to shed.
    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }
    await (app as any).recordPowerSample(1200);

    // Move past cooldown and provide ample headroom so device should restore.
    (app as any).lastSheddingMs = Date.now() - 180000; // cooldown expired
    (app as any).lastOvershootMs = Date.now() - 180000;
    (app as any).computeDynamicSoftLimit = () => 5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 5);
    }

    await (app as any).recordPowerSample(500);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('keep');
    expect(devPlan?.plannedTarget).toBe(21);
    expect(devPlan?.reason).toContain('keep');
    expect(devPlan?.reason).not.toContain('cooldown');
  });

  it('marks off devices as staying off during cooldown with a short reason', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('measure_power', 0);
    await dev1.setCapabilityValue('onoff', false); // currently off
    await dev1.setCapabilityValue('target_temperature', 20);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    const app = createApp();
    await app.onInit();

    // Plenty of headroom but still in cooldown due to a recent shed
    (app as any).computeDynamicSoftLimit = () => 5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 5);
    }
    (app as any).lastSheddingMs = Date.now(); // force cooldown window

    await (app as any).recordPowerSample(1000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.reason).toContain('stay shed during cooldown before restore');
  });

  it('does not start shedding cooldown when no devices can be shed', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('measure_power', 0);
    await dev1.setCapabilityValue('onoff', true);
    await dev1.setCapabilityValue('target_temperature', 20);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    // Make device non-controllable so no shedding is possible
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': false });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }

    await (app as any).recordPowerSample(600); // 0.6 kW total, overshoot of 0.1 kW

    expect((app as any).lastOvershootMs).toBeNull();
  });

  it('executes shedding action when plan says shed and dry run is off', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    const spy = jest.fn().mockResolvedValue(undefined);
    (app as any).applySheddingToDevice = spy;

    const plan = {
      devices: [
        {
          id: 'dev-1',
          name: 'Heater A',
          plannedState: 'shed',
          currentState: 'on',
          plannedTarget: null,
          currentTarget: null,
          controllable: true,
        },
      ],
    };

    await (app as any).applyPlanActions(plan);
    expect(spy).toHaveBeenCalledWith('dev-1', 'Heater A', undefined);
  });

  it('applies shed temperature via actuator when configured to avoid turning off', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 20);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 12 } });

    const app = createApp();
    await app.onInit();

    await (app as any).applySheddingToDevice('dev-1', 'Heater A', 'test overshoot');

    expect(await dev1.getCapabilityValue('target_temperature')).toBe(12);
    expect(await dev1.getCapabilityValue('onoff')).toBe(true);
  });

  it('does not plan swaps using devices constrained to minimum temperature shedding', async () => {
    const minTempDev = new MockDevice('dev-min', 'Low Pri', ['target_temperature', 'measure_power', 'onoff']);
    await minTempDev.setCapabilityValue('measure_power', 1000); // 1 kW on
    await minTempDev.setCapabilityValue('onoff', true);
    await minTempDev.setCapabilityValue('target_temperature', 20);

    const highPriDev = new MockDevice('dev-high', 'High Pri', ['target_temperature', 'onoff']);
    await highPriDev.setCapabilityValue('onoff', false);
    await highPriDev.setCapabilityValue('target_temperature', 21);

    setMockDrivers({
      driverA: new MockDriver('driverA', [minTempDev, highPriDev]),
    });

    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-high': 1, 'dev-min': 11 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-min': { action: 'set_temperature', temperature: 16 } });

    const app = createApp();
    await app.onInit();

    // Soft limit 1.3 kW, current total 1.0 kW -> headroom 0.3 kW (not enough for ~1 kW restore)
    (app as any).computeDynamicSoftLimit = () => 1.3;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1.3);
    }
    await (app as any).recordPowerSample(1000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const highPlan = plan.devices.find((d: any) => d.id === 'dev-high');
    const minPlan = plan.devices.find((d: any) => d.id === 'dev-min');

    expect(highPlan?.plannedState).toBe('shed');
    expect(highPlan?.reason).toContain('insufficient headroom');
    expect(minPlan?.plannedState).not.toBe('shed'); // not swapped out because min-temp devices are non-swappable
  });

  it('ignores non-controllable devices when planning shedding', async () => {
    const controllable = new MockDevice('dev-ctl', 'Heater A', ['target_temperature']);
    const nonCtl = new MockDevice('dev-non', 'Heater B', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [controllable, nonCtl]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-ctl': true, 'dev-non': false });

    const app = createApp();
    await app.onInit();

    // Force soft limit low and total high to trigger shedding.
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }
    await (app as any).recordPowerSample(5000); // 5 kW total, over limit

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const ctlPlan = plan.devices.find((d: any) => d.id === 'dev-ctl');
    const nonCtlPlan = plan.devices.find((d: any) => d.id === 'dev-non');

    expect(ctlPlan?.plannedState).toBe('shed');
    expect(nonCtlPlan?.plannedState).toBe('keep');
  });

  it('updates planned target when switching modes', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 19 }, Comfort: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    const app = createApp();
    await app.onInit();

    // Ensure plan exists for Home.
    await (app as any).recordPowerSample(1000);
    let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const homePlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(homePlan?.plannedTarget).toBe(19);

    // Switch mode; settings listener should rebuild snapshot/plan.
    mockHomeyInstance.settings.set('operating_mode', 'Comfort');
    await new Promise((resolve) => setTimeout(resolve, 0));

    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const comfortPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(comfortPlan?.plannedTarget).toBe(21);
  });

  it('keeps device shed until headroom exceeds restore margin', async () => {
    // This test verifies hysteresis behavior:
    // 1. Device gets shed during overshoot
    // 2. Device stays shed when headroom is positive but below restore margin
    // 3. Device restores when headroom exceeds restore margin + device power

    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 1000); // 1 kW device
    await dev1.setCapabilityValue('onoff', true);
    await dev1.setCapabilityValue('target_temperature', 20);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('capacity_margin', 0.2); // 200W restore margin

    const app = createApp();
    await app.onInit();

    // Step 1: Overshoot - device should be shed
    // Set soft limit low enough to trigger shedding
    (app as any).computeDynamicSoftLimit = () => 0.5; // 500W limit
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }

    await (app as any).recordPowerSample(1000); // 1kW total, 500W limit => -500W headroom
    let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-1')?.plannedState).toBe('shed');

    // Step 2: Small positive headroom (below restore margin) - device should STAY shed
    // First, update mock device to reflect it was turned off
    await dev1.setCapabilityValue('onoff', false);
    (app as any).lastSnapshotRefreshMs = 0; // Force refresh

    // Clear shedding-related cooldowns but NOT restore margin consideration
    (app as any).lastSheddingMs = 0;
    (app as any).lastOvershootMs = 0;
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.sheddingActive = false;
    }

    // Now set headroom to small positive (0.1 kW) - below device power (1kW) + margin (0.2kW)
    // With device off, power drops. Say power is now 0.5kW (other loads).
    // Soft limit 0.7 => headroom = 0.2kW. Device needs 1kW + 0.2kW margin = 1.2kW. Not enough.
    (app as any).computeDynamicSoftLimit = () => 0.7;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.7);
    }

    await (app as any).recordPowerSample(500); // 500W with device off
    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    // Device should stay shed because headroom (0.2kW) < device power (1kW) + margin (0.2kW)
    expect(plan.devices.find((d: any) => d.id === 'dev-1')?.plannedState).toBe('shed');

    // Step 3: Large headroom - device should restore
    // Clear all cooldowns to allow restoration
    (app as any).lastSheddingMs = 0;
    (app as any).lastOvershootMs = 0;
    (app as any).lastRestoreMs = 0;

    // Set soft limit high enough for restoration: need > device power + margin
    // Power 500W, soft limit 2kW => headroom 1.5kW. Device needs 1kW + 0.2kW = 1.2kW. OK!
    (app as any).computeDynamicSoftLimit = () => 2;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 2);
    }

    await (app as any).recordPowerSample(500);
    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-1')?.plannedState).toBe('keep');
  });

  it('does not turn a shed device back on if headroom is below its power need', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Force headroom small; monkey-patch guard headroom and margin.
    (app as any).capacitySettings.marginKw = 0.2;
    (app as any).capacityGuard.getHeadroom = () => 0.3;

    const plan = {
      devices: [
        {
          id: 'dev-1',
          name: 'Heater A',
          plannedState: 'keep',
          currentState: 'off',
          plannedTarget: null,
          currentTarget: null,
          powerKw: 2, // needs at least 2 + margin headroom
          controllable: true,
        },
      ],
    };

    const findSpy = jest.fn();
    (app as any).findDeviceInstance = findSpy;

    await (app as any).applyPlanActions(plan);
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('keeps planned state as shed when headroom is below device need even after turn-off', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2500); // 2.5 kW
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    const app = createApp();
    await app.onInit();

    // Force soft limit to 2 kW and total to 2.1 kW -> shed.
    (app as any).computeDynamicSoftLimit = () => 2;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 2);
    }
    await (app as any).recordPowerSample(2100);
    let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-1')?.plannedState).toBe('shed');

    // Simulate device now off, but headroom still below need (2.5 + margin).
    plan = (app as any).buildDevicePlanSnapshot([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 2.5,
        priority: 1,
        currentOn: false,
        controllable: true,
      },
    ]);
    const nextState = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(nextState?.plannedState).toBe('shed');
  });

  it('sheds a controllable device when overshooting with real power sample (non-dry-run)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000); // 2 kW
    await dev1.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    // Force soft limit to 1 kW so 2 kW total is an overshoot.
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    const shedSpy = jest.fn().mockResolvedValue(undefined);
    (app as any).applySheddingToDevice = shedSpy;

    await (app as any).recordPowerSample(2000);

    expect(shedSpy).toHaveBeenCalledWith('dev-1', 'Heater A', undefined);
    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const planned = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(planned?.plannedState).toBe('shed');
  });

  it('sheds multiple lowest-priority devices until headroom is non-negative', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    const dev2 = new MockDevice('dev-2', 'Heater B', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 1700); // 1.7 kW
    await dev2.setCapabilityValue('measure_power', 1000); // 1.0 kW
    await dev1.setCapabilityValue('onoff', true);
    await dev2.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2]),
    });

    // Mark both devices controllable.
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true, 'dev-2': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Force soft limit to about 3.1 kW so total 5.63 kW is an overshoot of ~2.53 kW.
    (app as any).computeDynamicSoftLimit = () => 3.1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3.1);
    }

    const shedSpy = jest.spyOn(app as any, 'applySheddingToDevice').mockResolvedValue(undefined);

    await (app as any).recordPowerSample(5630); // 5.63 kW total

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const shedIds = plan.devices.filter((d: any) => d.plannedState === 'shed').map((d: any) => d.id);
    expect(shedIds).toEqual(expect.arrayContaining(['dev-1', 'dev-2']));
    expect(shedSpy).toHaveBeenCalledWith('dev-1', 'Heater A', undefined);
    expect(shedSpy).toHaveBeenCalledWith('dev-2', 'Heater B', undefined);
  });

  it('does not shed additional devices without a new power sample after an initial shed', async () => {
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true, 'dev-2': true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1, 'dev-2': 10 } });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
        priority: 1,
      },
      {
        id: 'dev-2',
        name: 'Heater B',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
        priority: 10,
      },
    ]);

    await (app as any).recordPowerSample(2000, 1000);

    let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const initialShed = plan.devices.filter((d: any) => d.plannedState === 'shed').map((d: any) => d.id);
    expect(initialShed).toEqual(['dev-2']);

    // Simulate the shed device turning off, but no new measurement arrives.
    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
        priority: 1,
      },
      {
        id: 'dev-2',
        name: 'Heater B',
        targets: [],
        powerKw: 1,
        currentOn: false,
        controllable: true,
        priority: 10,
      },
    ]);

    (app as any).rebuildPlanFromCache();
    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan?.plannedState).toBe('keep');
  });

  it('allows additional shedding after a new power sample arrives', async () => {
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true, 'dev-2': true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1, 'dev-2': 10 } });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
        priority: 1,
      },
      {
        id: 'dev-2',
        name: 'Heater B',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
        priority: 10,
      },
    ]);

    await (app as any).recordPowerSample(2000, 1000);

    // Simulate the first shed taking effect.
    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
        priority: 1,
      },
      {
        id: 'dev-2',
        name: 'Heater B',
        targets: [],
        powerKw: 1,
        currentOn: false,
        controllable: true,
        priority: 10,
      },
    ]);

    await (app as any).recordPowerSample(2000, 2000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan?.plannedState).toBe('shed');
  });

  it('throttles repeated shedding commands for the same device', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff']);
    await dev1.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Inject mock homeyApi for the test
    const mockHomeyApi = {
      devices: {
        setCapabilityValue: jest.fn().mockResolvedValue(undefined),
      },
    };
    (app as any).deviceManager.homeyApi = mockHomeyApi;

    // Clear snapshot so the second call would normally try again.
    app.setSnapshotForTests([]);

    await (app as any).applySheddingToDevice('dev-1', 'Heater A');
    // Simulate plan still thinks it is on to force a second attempt.
    app.setSnapshotForTests([]);
    await (app as any).applySheddingToDevice('dev-1', 'Heater A');

    expect(mockHomeyApi.devices.setCapabilityValue).toHaveBeenCalledTimes(1);
  });

  it('does not repeatedly shed the same device across consecutive samples (flap guard)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power', 'target_temperature']);
    await dev1.setCapabilityValue('measure_power', 2000); // 2 kW
    await dev1.setCapabilityValue('onoff', true);
    await dev1.setCapabilityValue('target_temperature', 20);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Inject mock homeyApi for the test
    const mockHomeyApi = {
      devices: {
        setCapabilityValue: jest.fn().mockResolvedValue(undefined),
      },
    };
    (app as any).deviceManager.homeyApi = mockHomeyApi;

    // Force a low soft limit so the device must be shed.
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    // First overshoot triggers shedding.
    await (app as any).recordPowerSample(5000);
    // Wait for async applyPlanActions to complete before second sample.
    await new Promise((r) => setTimeout(r, 100));
    // Second overshoot arrives before cooldown; should not call setCapabilityValue again.
    await (app as any).recordPowerSample(5000);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockHomeyApi.devices.setCapabilityValue).toHaveBeenCalledTimes(1);
  });

  it('uses settings.load as power when measure_power is zero', async () => {
    const app = createApp();
    await app.onInit();

    const sampleDevice = {
      id: 'thermostat-1',
      name: 'Room Thermostat',
      capabilities: ['onoff', 'target_temperature', 'measure_power'],
      capabilitiesObj: {
        onoff: { value: false, id: 'onoff' },
        target_temperature: { value: 22, units: '°C', id: 'target_temperature' },
        measure_power: { value: 0, id: 'measure_power' },
      },
      settings: { load: 450 },
    };

    const parsed = app.parseDevicesForTests([sampleDevice]);
    expect(parsed[0].powerKw).toBeCloseTo(0.45, 2);
    expect(parsed[0].targets[0].value).toBe(22);
  });

  it('does not count already-off devices toward shedding need', async () => {
    const devOn = new MockDevice('dev-on', 'On Device', ['target_temperature', 'onoff', 'measure_power']);
    const devOff = new MockDevice('dev-off', 'Off Device', ['target_temperature', 'onoff', 'measure_power']);
    await devOn.setCapabilityValue('measure_power', 1700); // 1.7 kW
    await devOn.setCapabilityValue('onoff', true);
    await devOff.setCapabilityValue('measure_power', 1000); // 1.0 kW but already off
    await devOff.setCapabilityValue('onoff', false);

    setMockDrivers({
      driverA: new MockDriver('driverA', [devOn, devOff]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-on': true, 'dev-off': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Soft limit 3 kW, total 6.3 kW -> need ~3.3 kW. Off device should not be counted as shed.
    (app as any).computeDynamicSoftLimit = () => 3;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3);
    }

    const shedSpy = jest.spyOn(app as any, 'applySheddingToDevice').mockResolvedValue(undefined);

    await (app as any).recordPowerSample(6300);

    expect(shedSpy).toHaveBeenCalledWith('dev-on', 'On Device', undefined);
    expect(shedSpy).not.toHaveBeenCalledWith('dev-off', 'Off Device');
  });

  it('triggers capacity_shortfall when deficit remains after shedding all controllables', async () => {
    // Shortfall triggers when power exceeds the shortfall threshold AND no devices left to shed.
    // The shortfall threshold is based on remaining hourly budget / remaining time.
    // At any point in the hour with no usage, threshold = (limit - margin) / remainingHours.
    // To ensure shortfall triggers regardless of when the test runs, use a low limit.
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_limit_kw', 5); // Low limit ensures threshold is exceeded
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const triggerSpy = jest.fn().mockReturnValue({ catch: jest.fn() });
    const originalGetTrigger = mockHomeyInstance.flow.getTriggerCard as any;
    mockHomeyInstance.flow.getTriggerCard = ((id: string) => {
      if (id === 'capacity_shortfall') {
        return { trigger: triggerSpy };
      }
      return originalGetTrigger();
    }) as any;

    const app = createApp();
    await app.onInit();

    // Only 1 kW available to shed
    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
      },
    ]);
    // Sync the snapshot to the guard so it knows about controllable devices
    // Guard no longer needs explicit sync - Plan calls Guard methods directly

    // Use very high power to ensure it exceeds any threshold
    // Even at minute 1 (59 mins left): threshold = 5 / 0.983 = ~5.1kW
    // At minute 59 (1 min left): threshold = 5 / 0.0167 = ~300kW
    // So use 500kW to be safe
    await (app as any).recordPowerSample(500000); // 500kW definitely exceeds threshold
    // Shortfall is now detected by Plan calling checkShortfall() - no need for tick()
    expect(triggerSpy).toHaveBeenCalled();

    mockHomeyInstance.flow.getTriggerCard = originalGetTrigger;
  });

  it('does not trigger capacity_shortfall when controllables can cover the deficit', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    const dev2 = new MockDevice('dev-2', 'Heater B', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 1500); // 1.5 kW
    await dev2.setCapabilityValue('measure_power', 1200); // 1.2 kW
    await dev1.setCapabilityValue('onoff', true);
    await dev2.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true, 'dev-2': true });

    const triggerSpy = jest.fn();
    const originalGetTrigger = mockHomeyInstance.flow.getTriggerCard as any;
    mockHomeyInstance.flow.getTriggerCard = ((id: string) => {
      if (id === 'capacity_shortfall') return { trigger: triggerSpy } as any;
      return originalGetTrigger();
    }) as any;

    const app = createApp();
    await app.onInit();

    // Soft limit 3.2 kW, total 5.6 kW -> need 2.4 kW, controllables can cover ~2.7 kW so no shortfall.
    (app as any).computeDynamicSoftLimit = () => 3.2;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3.2);
    }

    await (app as any).recordPowerSample(5600);
    expect(triggerSpy).not.toHaveBeenCalled();

    mockHomeyInstance.flow.getTriggerCard = originalGetTrigger;
  });

  // TODO: This test relies on deprecated Guard tick() mechanism
  // Shortfall detection now works via Plan calling checkShortfall()
  // Shortfall behavior is tested in capacityGuard.test.ts
  it.skip('does not trigger capacity_shortfall repeatedly while already in shortfall state', async () => {
    // Shortfall triggers when power exceeds the shortfall threshold.
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const triggerSpy = jest.fn().mockReturnValue({ catch: jest.fn() });
    const originalGetTrigger = mockHomeyInstance.flow.getTriggerCard as any;
    mockHomeyInstance.flow.getTriggerCard = ((id: string) => {
      if (id === 'capacity_shortfall') {
        return { trigger: triggerSpy };
      }
      return originalGetTrigger();
    }) as any;

    const app = createApp();
    await app.onInit();

    // Only 1 kW available to shed
    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
      },
    ]);
    // Sync the snapshot to the guard so it knows about controllable devices
    // Guard no longer needs explicit sync

    // First shortfall sample - should trigger (500kW definitely exceeds threshold)
    await (app as any).recordPowerSample(500000);
    await (app as any).capacityGuard?.tick();
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    // Second shortfall sample - should NOT trigger again (already in shortfall)
    await (app as any).recordPowerSample(550000);
    await (app as any).capacityGuard?.tick();
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    // Third shortfall sample - should still NOT trigger
    await (app as any).recordPowerSample(520000);
    await (app as any).capacityGuard?.tick();
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    mockHomeyInstance.flow.getTriggerCard = originalGetTrigger;
  });

  // TODO: This test relies on deprecated Guard tick() mechanism
  it.skip('triggers capacity_shortfall again after shortfall is resolved and re-enters', async () => {
    // Shortfall triggers when power exceeds shortfall threshold.
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 500);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const triggerSpy = jest.fn().mockReturnValue({ catch: jest.fn() });
    const originalGetTrigger = mockHomeyInstance.flow.getTriggerCard as any;
    mockHomeyInstance.flow.getTriggerCard = ((id: string) => {
      if (id === 'capacity_shortfall') {
        return { trigger: triggerSpy };
      }
      return originalGetTrigger();
    }) as any;

    const app = createApp();
    await app.onInit();

    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 0.5,
        currentOn: true,
        controllable: true,
      },
    ]);
    // Sync the snapshot to the guard so it knows about controllable devices
    // Guard no longer needs explicit sync

    // First shortfall - should trigger (500kW definitely exceeds threshold)
    await (app as any).recordPowerSample(500000);
    await (app as any).capacityGuard?.tick();
    expect(triggerSpy).toHaveBeenCalledTimes(1);
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).toBe(true);

    // Power drops way below threshold - shortfall resolved (needs sustained time)
    await (app as any).recordPowerSample(1000); // 1kW
    // Need to tick multiple times with time passing to clear shortfall (60s sustained)
    const originalNow = Date.now;
    let mockTime = originalNow();
    jest.spyOn(Date, 'now').mockImplementation(() => mockTime);
    await (app as any).capacityGuard?.tick(); // starts timer
    mockTime += 30000;
    await (app as any).capacityGuard?.tick();
    mockTime += 31000; // total 61s
    await (app as any).capacityGuard?.tick();
    jest.restoreAllMocks();
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).toBe(false);

    // Shortfall returns - should trigger again (500kW exceeds threshold)
    await (app as any).recordPowerSample(500000);
    await (app as any).capacityGuard?.tick();
    expect(triggerSpy).toHaveBeenCalledTimes(2);
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).toBe(true);

    mockHomeyInstance.flow.getTriggerCard = originalGetTrigger;
  });

  // TODO: This test relies on deprecated Guard tick() mechanism
  it.skip('updates capacity_shortfall setting for device sync', async () => {
    // Shortfall triggers when power exceeds shortfall threshold.
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const triggerSpy = jest.fn().mockReturnValue({ catch: jest.fn() });
    const originalGetTrigger = mockHomeyInstance.flow.getTriggerCard as any;
    mockHomeyInstance.flow.getTriggerCard = ((id: string) => {
      if (id === 'capacity_shortfall') {
        return { trigger: triggerSpy };
      }
      return originalGetTrigger();
    }) as any;

    const app = createApp();
    await app.onInit();

    // Initially not in shortfall
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).toBeFalsy();

    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 0.5,
        currentOn: true,
        controllable: true,
      },
    ]);
    // Sync the snapshot to the guard so it knows about controllable devices
    // Guard no longer needs explicit sync

    // Enter shortfall - setting should be true (500kW definitely exceeds threshold)
    await (app as any).recordPowerSample(500000);
    await (app as any).capacityGuard?.tick();
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).toBe(true);

    // Exit shortfall - setting should be false (needs sustained time)
    await (app as any).recordPowerSample(1000); // 1kW
    // Need to tick multiple times with time passing to clear shortfall (60s sustained)
    const originalNow = Date.now;
    let mockTime = originalNow();
    jest.spyOn(Date, 'now').mockImplementation(() => mockTime);
    await (app as any).capacityGuard?.tick(); // starts timer
    mockTime += 30000;
    await (app as any).capacityGuard?.tick();
    mockTime += 31000; // total 61s
    await (app as any).capacityGuard?.tick();
    jest.restoreAllMocks();
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).toBe(false);

    mockHomeyInstance.flow.getTriggerCard = originalGetTrigger;
  });

  it('does not restore immediately after shedding (prevents flapping)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 500);
    await dev1.setCapabilityValue('onoff', false); // assumed off after a shed event

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Simulate recent shedding/overshoot.
    (app as any).lastSheddingMs = Date.now();
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.getHeadroom = () => 5; // plenty of headroom
      (app as any).capacityGuard.isSheddingActive = () => false;
    }

    const onSpy = jest.spyOn(dev1 as any, 'setCapabilityValue');

    const plan = {
      devices: [
        {
          id: 'dev-1',
          name: 'Heater A',
          plannedState: 'keep',
          currentState: 'off',
          plannedTarget: null,
          currentTarget: null,
          controllable: true,
          powerKw: 0.5,
        },
      ],
    };

    await (app as any).applyPlanActions(plan);

    expect(onSpy).not.toHaveBeenCalled();
  });

  it('does not restore devices while in shortfall state (prevents restore-then-reshed cycle)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 500);
    await dev1.setCapabilityValue('onoff', false); // off after being shed

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Simulate being in shortfall state with positive headroom (waiting for 60s sustain)
    // This happens when power drops but we haven't sustained positive headroom long enough
    (app as any).lastSheddingMs = Date.now() - 120000; // shedding was 2 minutes ago (past cooldown)
    (app as any).lastOvershootMs = Date.now() - 120000; // overshoot was 2 minutes ago
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.getHeadroom = () => 2; // plenty of headroom
      (app as any).capacityGuard.isSheddingActive = () => false;
      (app as any).capacityGuard.isInShortfall = () => true; // still in shortfall, waiting for sustained period
    }

    // Spy on log to verify the reason for not restoring
    const logSpy = jest.spyOn(app as any, 'log');

    const plan = {
      devices: [
        {
          id: 'dev-1',
          name: 'Heater A',
          plannedState: 'keep',
          currentState: 'off',
          plannedTarget: null,
          currentTarget: null,
          controllable: true,
          powerKw: 0.5,
        },
      ],
    };

    await (app as any).applyPlanActions(plan);

    // Should log that we're keeping the device off due to shortfall
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('in shortfall'),
    );
  });

  it('uses settings.load as fallback power when device is off', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    dev1.setSettings({ load: 1200 }); // watts
    await dev1.setCapabilityValue('onoff', false);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot');
    const device = snapshot.find((d: any) => d.id === 'dev-1');
    expect(device.powerKw).toBeCloseTo(1.2, 3);
  });

  it('includes Hoiax water heater in device snapshot with target_temperature', async () => {
    const hoiax = createHoiaxWaterHeater('hoiax-1', 'Connected 300');
    await hoiax.setCapabilityValue('measure_power', 3000); // 3kW when heating
    await hoiax.setCapabilityValue('target_temperature', 65);

    setMockDrivers({
      hoiaxDriver: new MockDriver('hoiaxDriver', [hoiax]),
    });

    const app = createApp();
    await app.onInit();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      id: 'hoiax-1',
      name: 'Connected 300',
      powerKw: 3, // 3000W = 3kW
    });
    expect(snapshot[0].targets[0]).toMatchObject({
      id: 'target_temperature',
      value: 65,
    });
  });

  it('can shed Hoiax water heater when over capacity', async () => {
    const hoiax = createHoiaxWaterHeater('hoiax-1');
    await hoiax.setCapabilityValue('measure_power', 3000);
    await hoiax.setCapabilityValue('onoff', true);

    setMockDrivers({
      hoiaxDriver: new MockDriver('hoiaxDriver', [hoiax]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'hoiax-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Inject mock homeyApi
    const setSpy = jest.fn().mockResolvedValue(undefined);
    (app as any).deviceManager.homeyApi = {
      devices: {
        setCapabilityValue: setSpy,
      },
    };

    // Force very low soft limit
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    // Report high power - should trigger shedding
    await (app as any).recordPowerSample(5000);
    await new Promise((r) => setTimeout(r, 100));

    // Verify the device was turned off
    expect(setSpy).toHaveBeenCalledWith({
      deviceId: 'hoiax-1',
      capabilityId: 'onoff',
      value: false,
    });
  });

  it('applies mode target temperature to Hoiax water heater', async () => {
    const hoiax = createHoiaxWaterHeater('hoiax-1');
    await hoiax.setCapabilityValue('target_temperature', 65);

    setMockDrivers({
      hoiaxDriver: new MockDriver('hoiaxDriver', [hoiax]),
    });

    // Configure Away mode with lower temp for water heater
    mockHomeyInstance.settings.set('mode_device_targets', {
      Away: { 'hoiax-1': 45 },
      Home: { 'hoiax-1': 65 },
    });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Inject mock homeyApi
    const setSpy = jest.fn().mockResolvedValue(undefined);
    (app as any).deviceManager.homeyApi = {
      devices: {
        getDevices: async () => ({
          'hoiax-1': {
            id: 'hoiax-1',
            name: 'Connected 300',
            capabilities: ['target_temperature', 'onoff', 'max_power_3000'],
            capabilitiesObj: {
              target_temperature: { value: 65, id: 'target_temperature' },
              onoff: { value: true, id: 'onoff' },
            },
            settings: {},
          },
        }),
        setCapabilityValue: setSpy,
      },
    };

    // Trigger mode change via flow card
    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    await setModeListener({ mode: 'Away' });

    // Verify target temperature was set to 45°C
    expect(setSpy).toHaveBeenCalledWith({
      deviceId: 'hoiax-1',
      capabilityId: 'target_temperature',
      value: 45,
    });
  });

  it('swaps low-priority ON device with high-priority OFF device when headroom is insufficient', async () => {
    // High priority device (OFF, needs restoration) - priority 1 = most important
    const highPri = new MockDevice('dev-high', 'High Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await highPri.setCapabilityValue('measure_power', 1500); // 1.5 kW
    await highPri.setCapabilityValue('onoff', false); // Currently OFF

    // Low priority device (ON, can be swapped out) - priority 10 = less important
    const lowPri = new MockDevice('dev-low', 'Low Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await lowPri.setCapabilityValue('measure_power', 1200); // 1.2 kW (increased for hysteresis margin)
    await lowPri.setCapabilityValue('onoff', true); // Currently ON

    setMockDrivers({
      driverA: new MockDriver('driverA', [highPri, lowPri]),
    });

    // Set priorities: dev-high has priority 1 (most important), dev-low has priority 10 (less important)
    // Lower number = higher priority = more important
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-high': 1, 'dev-low': 10 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-high': true, 'dev-low': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // With hysteresis: restoreHysteresis = max(0.2, marginKw * 2) = max(0.2, 0.4) = 0.4 kW
    // High-pri device needs 1.5 + 0.4 = 1.9 kW
    // Soft limit = 4 kW, total = 3 kW, headroom = 1 kW
    // Shedding low-pri (1.2 kW) gives us 1.0 + 1.2 = 2.2 kW >= 1.9 kW - enough!
    (app as any).computeDynamicSoftLimit = () => 4;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4);
    }

    // Clear any shedding/overshoot timestamps to avoid cooldown
    (app as any).lastSheddingMs = null;
    (app as any).lastOvershootMs = null;
    if ((app as any).capacityGuard) {
      // Ensure shedding is not active
      (app as any).capacityGuard.sheddingActive = false;
    }

    await (app as any).recordPowerSample(3000); // 3 kW total

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const highPriPlan = plan.devices.find((d: any) => d.id === 'dev-high');
    const lowPriPlan = plan.devices.find((d: any) => d.id === 'dev-low');

    // High priority device should be planned for restoration (keep)
    // Low priority device should be planned for shedding (swap)
    expect(lowPriPlan?.plannedState).toBe('shed');
    expect(lowPriPlan?.reason).toContain('swapped out');
    expect(highPriPlan?.plannedState).toBe('keep');
  });

  it('does not swap when there are no lower-priority devices to shed', async () => {
    // High priority device (OFF, needs restoration)
    const highPri = new MockDevice('dev-high', 'High Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await highPri.setCapabilityValue('measure_power', 1500);
    await highPri.setCapabilityValue('onoff', false);

    // Another high priority device (ON)
    const anotherHigh = new MockDevice('dev-high2', 'Another High Pri', ['target_temperature', 'onoff', 'measure_power']);
    await anotherHigh.setCapabilityValue('measure_power', 800);
    await anotherHigh.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [highPri, anotherHigh]),
    });

    // Both devices have equal or higher priority - no swap possible
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-high': 10, 'dev-high2': 10 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-high': true, 'dev-high2': true });

    const app = createApp();
    await app.onInit();

    // Headroom 0.5 kW, not enough for dev-high (1.5 kW + margin)
    (app as any).computeDynamicSoftLimit = () => 3;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3);
    }

    (app as any).lastSheddingMs = null;
    (app as any).lastOvershootMs = null;

    await (app as any).recordPowerSample(2500);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const highPriPlan = plan.devices.find((d: any) => d.id === 'dev-high');
    const high2Plan = plan.devices.find((d: any) => d.id === 'dev-high2');

    // dev-high should stay off (not enough headroom, no lower-pri to swap)
    expect(highPriPlan?.plannedState).toBe('shed');
    // dev-high2 should stay on (same priority, not swapped)
    expect(high2Plan?.plannedState).toBe('keep');
  });

  it('does not swap when shedding lower-priority devices would still not provide enough headroom', async () => {
    // High priority device (OFF, needs 2kW to restore)
    const highPri = new MockDevice('dev-high', 'High Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await highPri.setCapabilityValue('measure_power', 2000); // 2 kW - large device
    await highPri.setCapabilityValue('onoff', false);

    // Low priority device (ON, but only 0.3kW - not enough to swap)
    const lowPri = new MockDevice('dev-low', 'Low Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await lowPri.setCapabilityValue('measure_power', 300); // 0.3 kW - small device
    await lowPri.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [highPri, lowPri]),
    });

    // High priority (10) > Low priority (5)
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-high': 10, 'dev-low': 5 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-high': true, 'dev-low': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Soft limit = 3.5 kW, total = 3 kW, headroom = 0.5 kW
    // High-pri needs 2 + 0.2 margin = 2.2 kW
    // Even with shedding low-pri (0.3 kW), we'd only get 0.5 + 0.3 = 0.8 kW
    // 0.8 < 2.2, so swap should NOT happen
    (app as any).computeDynamicSoftLimit = () => 3.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3.5);
    }

    (app as any).lastSheddingMs = null;
    (app as any).lastOvershootMs = null;

    await (app as any).recordPowerSample(3000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const highPriPlan = plan.devices.find((d: any) => d.id === 'dev-high');
    const lowPriPlan = plan.devices.find((d: any) => d.id === 'dev-low');

    // High priority should stay off - not enough headroom even with swap
    expect(highPriPlan?.plannedState).toBe('shed');
    expect(highPriPlan?.reason).toContain('no lower-priority devices to swap');

    // Low priority should stay ON - it wasn't swapped out because swap wouldn't help
    expect(lowPriPlan?.plannedState).toBe('keep');
  });

  it('swaps multiple low-priority devices when needed to restore a high-priority device', async () => {
    // High priority device (OFF, needs 1.5kW) - priority 1 = most important
    const highPri = new MockDevice('dev-high', 'High Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await highPri.setCapabilityValue('measure_power', 1500);
    await highPri.setCapabilityValue('onoff', false);

    // Two low priority devices (ON, 0.5kW each = 1kW total)
    const lowPri1 = new MockDevice('dev-low1', 'Low Pri 1', ['target_temperature', 'onoff', 'measure_power']);
    await lowPri1.setCapabilityValue('measure_power', 500);
    await lowPri1.setCapabilityValue('onoff', true);

    const lowPri2 = new MockDevice('dev-low2', 'Low Pri 2', ['target_temperature', 'onoff', 'measure_power']);
    await lowPri2.setCapabilityValue('measure_power', 500);
    await lowPri2.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [highPri, lowPri1, lowPri2]),
    });

    // Lower number = higher priority: High (1) is most important, Low1 (8) and Low2 (9) are less important
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-high': 1, 'dev-low1': 8, 'dev-low2': 9 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-high': true, 'dev-low1': true, 'dev-low2': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Soft limit = 4 kW, total = 3 kW, headroom = 1 kW
    // High-pri needs 1.5 + 0.2 = 1.7 kW
    // Shedding low1 (0.5) + low2 (0.5) = 1kW, total headroom = 1 + 1 = 2 kW >= 1.7kW
    (app as any).computeDynamicSoftLimit = () => 4;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4);
    }

    (app as any).lastSheddingMs = null;
    (app as any).lastOvershootMs = null;

    await (app as any).recordPowerSample(3000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const highPriPlan = plan.devices.find((d: any) => d.id === 'dev-high');
    const low1Plan = plan.devices.find((d: any) => d.id === 'dev-low1');
    const low2Plan = plan.devices.find((d: any) => d.id === 'dev-low2');

    // High priority should be restored (swap successful)
    expect(highPriPlan?.plannedState).toBe('keep');

    // Both low priority devices should be shed for the swap
    expect(low1Plan?.plannedState).toBe('shed');
    expect(low1Plan?.reason).toContain('swapped out');
    expect(low2Plan?.plannedState).toBe('shed');
    expect(low2Plan?.reason).toContain('swapped out');
  });

  it('blocks lower-priority devices from restoring before pending swap targets', async () => {
    // Scenario: A swap was initiated but the swap target hasn't restored yet
    // A lower-priority OFF device should NOT restore before the swap target

    // High priority swap target (OFF, pending restore via swap)
    const swapTarget = new MockDevice('dev-swap-target', 'Swap Target', ['target_temperature', 'onoff', 'measure_power']);
    await swapTarget.setCapabilityValue('measure_power', 1000); // 1 kW
    await swapTarget.setCapabilityValue('onoff', false);

    // Lower priority device (OFF, wants to restore but should be blocked)
    const lowerPriDev = new MockDevice('dev-lower', 'Lower Priority', ['target_temperature', 'onoff', 'measure_power']);
    await lowerPriDev.setCapabilityValue('measure_power', 300); // 0.3 kW
    await lowerPriDev.setCapabilityValue('onoff', false);

    setMockDrivers({
      driverA: new MockDriver('driverA', [swapTarget, lowerPriDev]),
    });

    // Swap target (10) > Lower priority (8)
    mockHomeyInstance.settings.set('capacity_priorities', {
      Home: { 'dev-swap-target': 10, 'dev-lower': 8 },
    });
    mockHomeyInstance.settings.set('controllable_devices', {
      'dev-swap-target': true, 'dev-lower': true,
    });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Setup: enough headroom to restore the lower priority device (0.3 + 0.4 = 0.7 kW)
    // but not enough for the swap target (1.0 + 0.4 = 1.4 kW)
    // Soft limit = 2 kW, total power = 0 (both devices OFF), headroom = 2.0 kW
    // But with NO on devices, swap target can restore normally with 1.4 kW needed
    // To test the blocking, we need to manually set up the pendingSwapTargets

    (app as any).computeDynamicSoftLimit = () => 2;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 2);
    }

    (app as any).lastSheddingMs = null;
    (app as any).lastOvershootMs = null;
    (app as any).lastRestoreMs = null;

    // Simulate that a swap was initiated: swap target is in pendingSwapTargets
    // This mimics the state after a swap where the target hasn't been restored yet
    (app as any).pendingSwapTargets = new Set(['dev-swap-target']);

    // Record power - only 0.8 kW headroom (not enough for swap target with 1.4 kW needed)
    // But enough for lower priority (0.7 kW needed)
    await (app as any).recordPowerSample(1200); // 1.2 kW total

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const swapTargetPlan = plan.devices.find((d: any) => d.id === 'dev-swap-target');
    const lowerPriPlan = plan.devices.find((d: any) => d.id === 'dev-lower');

    // Swap target doesn't have enough headroom, should stay shed
    expect(swapTargetPlan?.plannedState).toBe('shed');

    // Lower priority device COULD restore (has enough headroom)
    // But should be blocked because swap target is pending
    expect(lowerPriPlan?.plannedState).toBe('shed');
    expect(lowerPriPlan?.reason).toContain('swap target');
  });

  it('clears stale swap tracking after timeout (60 seconds)', async () => {
    // Scenario: A swap was initiated but the high-priority device couldn't restore
    // (e.g., headroom dropped). After 60 seconds, the swap tracking should be cleared
    // so the swapped-out device can restore.

    // Device that was swapped out (lower priority)
    const swappedOut = new MockDevice('dev-swapped', 'Swapped Out Heater', ['target_temperature', 'onoff', 'measure_power']);
    await swappedOut.setCapabilityValue('measure_power', 500);
    await swappedOut.setCapabilityValue('onoff', false); // OFF - was shed for swap

    // Device that was supposed to restore (higher priority) but couldn't
    const swapTarget = new MockDevice('dev-target', 'Swap Target', ['target_temperature', 'onoff', 'measure_power']);
    await swapTarget.setCapabilityValue('measure_power', 2000); // Needs 2kW
    await swapTarget.setCapabilityValue('onoff', false); // Still OFF

    setMockDrivers({
      driverA: new MockDriver('driverA', [swappedOut, swapTarget]),
    });

    // Lower number = higher priority
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-target': 1, 'dev-swapped': 5 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-target': true, 'dev-swapped': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Setup: not enough headroom for swap target (needs 2kW + 0.4 = 2.4kW)
    // but enough for swapped-out device (needs 0.5kW + 0.4 = 0.9kW)
    (app as any).computeDynamicSoftLimit = () => 3;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3);
    }

    (app as any).lastSheddingMs = null;
    (app as any).lastOvershootMs = null;
    (app as any).lastRestoreMs = null;

    // Simulate swap state: dev-swapped was shed for dev-target, but dev-target can't restore
    // Set timestamp to 61 seconds ago (stale)
    const staleTime = Date.now() - 61000;
    (app as any).swappedOutFor = { 'dev-swapped': 'dev-target' };
    (app as any).pendingSwapTargets = new Set(['dev-target']);
    (app as any).pendingSwapTimestamps = { 'dev-target': staleTime };

    // Record power - only 1.5kW headroom (not enough for swap target 2.4kW, but enough for swapped 0.9kW)
    await (app as any).recordPowerSample(1500);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const swappedPlan = plan.devices.find((d: any) => d.id === 'dev-swapped');
    const targetPlan = plan.devices.find((d: any) => d.id === 'dev-target');

    // Swap target still can't restore (not enough headroom)
    expect(targetPlan?.plannedState).toBe('shed');

    // Swapped-out device should now be able to restore (swap timed out after 60s)
    // It has enough headroom and is no longer blocked by stale swap
    expect(swappedPlan?.plannedState).toBe('keep');

    // Verify swap tracking was cleared
    expect((app as any).pendingSwapTargets.has('dev-target')).toBe(false);
    expect((app as any).swappedOutFor['dev-swapped']).toBeUndefined();
  });

  // Removed: 'syncs Guard controllables when updateLocalSnapshot changes on/off state'
  // Guard no longer maintains controllables map - Plan calls Guard state methods directly

  it('sorts plan devices by priority ascending (priority 1 = most important, first)', async () => {
    // Create devices with different priorities (lower number = higher importance)
    const dev1 = new MockDevice('dev-1', 'Most Important Heater', ['target_temperature']);
    const dev2 = new MockDevice('dev-2', 'Least Important Heater', ['target_temperature']);
    const dev3 = new MockDevice('dev-3', 'Medium Priority Heater', ['target_temperature']);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2, dev3]),
    });

    // Set priorities: dev-1 is #1 (most important), dev-3 is #5, dev-2 is #10 (least important)
    mockHomeyInstance.settings.set('capacity_priorities', {
      Home: { 'dev-1': 1, 'dev-2': 10, 'dev-3': 5 },
    });

    const app = createApp();
    await app.onInit();

    // Trigger a power sample to generate a plan
    await (app as any).recordPowerSample(1000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan).toBeTruthy();
    expect(plan.devices.length).toBe(3);

    // Devices should be sorted by priority ascending (1 = most important, shown first)
    const deviceOrder = plan.devices.map((d: any) => ({ name: d.name, priority: d.priority }));

    expect(deviceOrder[0].name).toBe('Most Important Heater');
    expect(deviceOrder[0].priority).toBe(1);

    expect(deviceOrder[1].name).toBe('Medium Priority Heater');
    expect(deviceOrder[1].priority).toBe(5);

    expect(deviceOrder[2].name).toBe('Least Important Heater');
    expect(deviceOrder[2].priority).toBe(10);
  });

  it('does not log swap messages twice when refreshTargetDevicesSnapshot and recordPowerSample run close together', async () => {
    // High priority device (OFF, needs restoration) - priority 1 = most important
    const highPri = new MockDevice('dev-high', 'High Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await highPri.setCapabilityValue('measure_power', 1500);
    await highPri.setCapabilityValue('onoff', false);

    // Low priority device (ON, can be swapped) - priority 10 = less important
    const lowPri = new MockDevice('dev-low', 'Low Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await lowPri.setCapabilityValue('measure_power', 1200);
    await lowPri.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [highPri, lowPri]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.2);
    // Lower number = higher priority: dev-high (1) is more important than dev-low (10)
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-high': 1, 'dev-low': 10 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-high': true, 'dev-low': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Set up conditions for swap
    (app as any).computeDynamicSoftLimit = () => 4;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4);
    }
    (app as any).lastSheddingMs = null;
    (app as any).lastOvershootMs = null;
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.sheddingActive = false;
    }

    // Capture log calls
    const logCalls: string[] = [];
    const originalLog = (app as any).log.bind(app);
    (app as any).log = (...args: unknown[]) => {
      const msg = args.map((a) => String(a)).join(' ');
      logCalls.push(msg);
      originalLog(...args);
    };

    // Simulate what happens when periodic refresh and power sample happen close together
    // This replicates production behavior at 08:22:36 where:
    // - Periodic refresh calls refreshTargetDevicesSnapshot() -> buildDevicePlanSnapshot()
    // - Power sample calls recordPowerSample() -> rebuildPlanFromCache() -> buildDevicePlanSnapshot()
    await Promise.all([
      (app as any).refreshTargetDevicesSnapshot(),
      (app as any).recordPowerSample(3000),
    ]);

    // Count swap-related log messages
    const swapApprovedLogs = logCalls.filter((msg) => msg.includes('swap approved'));
    const swappingOutLogs = logCalls.filter((msg) => msg.includes('swapping out'));

    // Should only have ONE of each, not duplicates
    expect(swapApprovedLogs.length).toBe(1);
    expect(swappingOutLogs.length).toBe(1);
  });

  it('does not re-plan swap when swap is already pending (e.g. after API timeout)', async () => {
    // This test reproduces the bug where API timeouts caused repeated swap planning.
    // When applySheddingToDevice times out, the swap target stays in pendingSwapTargets
    // but the device wasn't actually shed, so next power sample re-plans the same swap.

    // High priority device (OFF, needs restoration) - priority 1 = most important
    const highPri = new MockDevice('dev-high', 'High Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await highPri.setCapabilityValue('measure_power', 1500);
    await highPri.setCapabilityValue('onoff', false);

    // Low priority device (ON, can be swapped) - priority 10 = less important
    const lowPri = new MockDevice('dev-low', 'Low Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await lowPri.setCapabilityValue('measure_power', 1200);
    await lowPri.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [highPri, lowPri]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.2);
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-high': 1, 'dev-low': 10 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-high': true, 'dev-low': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Set up conditions for swap
    (app as any).computeDynamicSoftLimit = () => 4;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4);
    }
    (app as any).lastSheddingMs = null;
    (app as any).lastOvershootMs = null;
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.sheddingActive = false;
    }

    // Mock HomeyAPI to simulate timeout (shedding fails)
    (app as any).deviceManager.homeyApi = {
      devices: {
        setCapabilityValue: jest.fn().mockRejectedValue(new Error('Timeout after 10000ms')),
      },
    };

    // Capture log calls
    const logCalls: string[] = [];
    const originalLog = (app as any).log.bind(app);
    (app as any).log = (...args: unknown[]) => {
      const msg = args.map((a) => String(a)).join(' ');
      logCalls.push(msg);
      originalLog(...args);
    };

    // First power sample - should plan the swap
    await (app as any).recordPowerSample(3000);
    await new Promise((r) => setTimeout(r, 50)); // Let async shedding attempt complete

    const swapApprovedAfterFirst = logCalls.filter((msg) => msg.includes('swap approved')).length;
    expect(swapApprovedAfterFirst).toBe(1);

    // Clear logs for second sample
    logCalls.length = 0;

    // Second power sample - should NOT re-plan the same swap
    // The swap is already pending (dev-high in pendingSwapTargets)
    await (app as any).recordPowerSample(3000);
    await new Promise((r) => setTimeout(r, 50));

    const swapApprovedAfterSecond = logCalls.filter((msg) => msg.includes('swap approved')).length;

    // BUG: Without the fix, this would be 1 (re-planning the same swap)
    // With the fix, this should be 0 (swap already pending)
    expect(swapApprovedAfterSecond).toBe(0);
  });
});

describe('Dry run mode', () => {
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

  it('defaults to dry run mode when capacity_dry_run setting is not configured', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    // Do NOT set capacity_dry_run - should default to true

    const app = createApp();
    await app.onInit();

    // Verify the app is in dry run mode
    expect((app as any).capacityDryRun).toBe(true);
  });

  it('defaults to dry run mode when capacity_dry_run setting is undefined', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', undefined);

    const app = createApp();
    await app.onInit();

    // Verify the app is in dry run mode (undefined should not override default true)
    expect((app as any).capacityDryRun).toBe(true);
  });

  // TODO: This test relies on deprecated Guard actuator mechanism
  // Dry run is now enforced by Plan - tested in 'does not apply plan actions in dry run mode'
  it.skip('does not call actuator when shedding in dry run mode', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    // Explicitly NOT setting capacity_dry_run - default is true

    const app = createApp();
    await app.onInit();

    // Track if actuator was called
    const actuatorCalls: string[] = [];
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.actuator = async (deviceId: string) => {
        actuatorCalls.push(deviceId);
      };
    }

    // Trigger overshoot
    await (app as any).recordPowerSample(6000); // Way over soft limit
    await (app as any).capacityGuard?.tick();

    // Actuator should NOT have been called in dry run mode
    expect(actuatorCalls).toHaveLength(0);
  });

  it('does not apply plan actions in dry run mode', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    // Default dry run mode

    const app = createApp();
    await app.onInit();

    // Spy on applyPlanActions
    const applyPlanSpy = jest.spyOn(app as any, 'applyPlanActions');

    // Rebuild plan with shedding needed
    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 2,
        currentOn: true,
        controllable: true,
      },
    ]);
    // Guard no longer needs explicit sync
    await (app as any).recordPowerSample(6000);

    // applyPlanActions should NOT be called in dry run mode
    expect(applyPlanSpy).not.toHaveBeenCalled();
  });

  // Removed: 'calls actuator when shedding with dry run disabled (CapacityGuard)'
  // Removed: 'does not call actuator when shedding with dry run enabled (CapacityGuard)'
  // Guard no longer has tick(), requestOn(), or actuator - Plan handles shedding directly

  it('logs dry run message when shedding would occur', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    // Default dry run mode

    const app = createApp();
    await app.onInit();

    // Capture log calls
    const logCalls: string[] = [];
    jest.spyOn(app as any, 'log').mockImplementation((...args: unknown[]) => {
      logCalls.push(String(args[0]));
    });

    // Setup snapshot with a device that will be shed
    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 2,
        currentOn: true,
        controllable: true,
      },
    ]);
    // Guard no longer needs explicit sync

    // Set a low soft limit to trigger shedding
    (app as any).computeDynamicSoftLimit = () => 2;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 2);
    }

    // Record power sample that triggers overshoot and plan rebuild
    await (app as any).recordPowerSample(4000); // Will cause overshoot with soft limit of 2

    // Should log dry run message
    expect(logCalls.some((msg) => msg.includes('Dry run'))).toBe(true);
  });

  it('can toggle dry run mode at runtime via settings change', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    // Start in dry run mode (default)

    const app = createApp();
    await app.onInit();

    expect((app as any).capacityDryRun).toBe(true);

    // Change setting to disable dry run
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    // Verify the app picked up the change
    expect((app as any).capacityDryRun).toBe(false);

    // Change back to dry run
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    expect((app as any).capacityDryRun).toBe(true);
  });

  it('does not shed devices via applySheddingToDevice in dry run mode', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    // Default dry run mode

    const app = createApp();
    await app.onInit();

    // Directly call applySheddingToDevice
    await (app as any).applySheddingToDevice('dev-1', 'Heater A', 'test');

    // Device should still be on (no actual shedding)
    expect(await dev1.getCapabilityValue('onoff')).toBe(true);
  });

  it('does not apply device targets for mode in dry run mode at startup', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 20);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    // Configure a mode with a target temperature
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'dev-1': 22 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    // Do NOT set capacity_dry_run - default is true

    const app = createApp();
    await app.onInit();

    // Temperature should NOT have been changed in dry run mode
    expect(await dev1.getCapabilityValue('target_temperature')).toBe(20);
  });

  it('logs preview message for mode targets in dry run mode', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 20);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    // Configure a mode with a target temperature
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'dev-1': 22 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    // Capture logs
    const logCalls: string[] = [];

    const app = createApp();
    jest.spyOn(app as any, 'log').mockImplementation((...args: unknown[]) => {
      logCalls.push(String(args[0]));
    });

    await app.onInit();

    // Should have logged a dry-run preview message
    expect(logCalls.some((msg) => msg.includes('Dry-run'))).toBe(true);
  });

  it('does not actuate price optimization in dry run mode', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 55);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    // Configure price optimization
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'dev-1': 55 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'dev-1': {
        enabled: true,
        cheapDelta: 10,
        expensiveDelta: -5,
      },
    });
    // Make current hour cheap
    const now = new Date();
    now.setHours(3, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const spotPrices: Array<{ startsAt: string; total: number }> = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const total = hour === 3 ? 20 : 50; // Hour 3 is cheap
      spotPrices.push({ startsAt: date.toISOString(), total });
    }
    mockHomeyInstance.settings.set('combined_prices', {
      prices: spotPrices.map((p) => ({
        startsAt: p.startsAt,
        spotPrice: p.total,
        gridTariff: 0,
        totalPrice: p.total,
      })),
    });
    // Do NOT set capacity_dry_run - default is true

    const app = createApp();
    await app.onInit();

    // Temperature should NOT have been changed in dry run mode
    // (would be 65 if price optimization was applied: 55 + 10)
    expect(await dev1.getCapabilityValue('target_temperature')).toBe(55);
  });

  it('price optimization respects dry run mode', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 55);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    // Configure price optimization
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'dev-1': 55 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'dev-1': {
        enabled: true,
        cheapDelta: 10,
        expensiveDelta: -5,
      },
    });

    const app = createApp();
    await app.onInit();

    // Verify dry run is enabled by default
    expect((app as any).capacityDryRun).toBe(true);

    // Mock the cheap/expensive detection to return cheap
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;

    // Ensure the device is in snapshot with correct structure
    app.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [{ id: 'target_temperature', value: 55, unit: '°C' }],
        powerKw: 1,
        currentOn: true,
        controllable: true,
      },
    ]);

    // Manually trigger price optimization
    await (app as any).applyPriceOptimization();

    // Temperature should NOT have been changed in dry run mode
    // (would be 65 if price optimization was applied: 55 + 10)
    expect(await dev1.getCapabilityValue('target_temperature')).toBe(55);
  });

  it('plan reason should reflect actual restore status when blocked by shortfall', async () => {
    // Bug: Device shows "restore (need X, headroom Y)" even though restore is blocked
    // by shortfall state. The reason should accurately reflect that the device will stay off.

    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 1500); // 1.5 kW
    await dev1.setCapabilityValue('onoff', false); // Currently OFF

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 10);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.3);
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    // Set a generous soft limit with plenty of headroom
    (app as any).computeDynamicSoftLimit = () => 8;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 8);
    }

    // Simulate being in shortfall state (Guard detected overshoot previously)
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.inShortfall = true;
    }
    (app as any).inShortfall = true;

    // Report low power - plenty of headroom mathematically, but we're in shortfall
    await (app as any).recordPowerSample(2000); // 2 kW, headroom = 6 kW

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan).toBeTruthy();
    expect(dev1Plan.currentState).toBe('off');

    // The bug: plan shows "restore" reason but device won't actually restore due to shortfall
    // If the reason says "restore", the applyPlanActions should actually restore it
    // OR the reason should accurately reflect that it will stay off
    if (dev1Plan.reason.includes('restore') && dev1Plan.plannedState !== 'shed') {
      // This is the bug - reason says restore, plannedState says keep, but applyPlanActions won't restore
      // because we're in shortfall. The plan is misleading.

      // Let's verify applyPlanActions will NOT restore due to shortfall
      const mockSetCapability = jest.fn().mockResolvedValue(undefined);
      (app as any).deviceManager.homeyApi = {
        devices: {
          setCapabilityValue: mockSetCapability,
        },
      };

      await (app as any).applyPlanActions(plan);

      // Due to shortfall, the restore should NOT happen even though reason says "restore"
      // This assertion will PASS (proving the bug exists), because the device won't be restored
      const restoreCall = mockSetCapability.mock.calls.find(
        (call: any) => call[0].deviceId === 'dev-1' && call[0].capabilityId === 'onoff' && call[0].value === true,
      );

      // The REAL assertion: if plan says "restore" in reason, the device SHOULD be restored
      // This should FAIL, demonstrating the bug
      if (dev1Plan.reason.includes('restore')) {
        expect(restoreCall).toBeDefined(); // This will FAIL because shortfall blocks restore
      }
    }
  });

  it('should restore device when headroom is sufficient even if device power exceeds 50% of headroom', async () => {
    // Bug: The 50% restore budget limit prevents restoring a device even when
    // there's more than enough headroom. For example:
    // - Headroom: 2.22 kW
    // - Device power: 1.30 kW
    // - 50% budget: 1.11 kW
    // - Result: Can't restore because 1.30 > 1.11, even though 2.22 > 1.30!

    const dev1 = new MockDevice('dev-1', 'Termostat kontor', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 1300); // 1.3 kW - more than 50% of 2.22 kW headroom
    await dev1.setCapabilityValue('onoff', false); // Currently OFF

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 10);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.3);
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    // Set a soft limit of 6.5 kW
    (app as any).computeDynamicSoftLimit = () => 6.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 6.5);
    }

    // Ensure not in shortfall or shedding
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.inShortfall = false;
      (app as any).capacityGuard.sheddingActive = false;
    }
    (app as any).inShortfall = false;
    (app as any).lastSheddingMs = null;
    (app as any).lastOvershootMs = null;
    (app as any).lastRestoreMs = null;

    // Report 4.3 kW power - gives 2.2 kW headroom (6.5 - 4.3 = 2.2)
    await (app as any).recordPowerSample(4300);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan).toBeTruthy();
    expect(dev1Plan.currentState).toBe('off');
    expect(dev1Plan.reason).toContain('restore'); // Plan says "restore"

    // Now try to apply the plan
    const mockSetCapability = jest.fn().mockResolvedValue(undefined);
    (app as any).deviceManager.homeyApi = {
      devices: {
        setCapabilityValue: mockSetCapability,
      },
    };

    await (app as any).applyPlanActions(plan);

    // The device should be restored because:
    // - Headroom: 2.2 kW
    // - Device needs: 1.3 kW (+ buffers ~1.6 kW)
    // - 2.2 > 1.6, so there's enough headroom
    // But the 50% budget (1.1 kW) blocks it because 1.3 > 1.1
    const restoreCall = mockSetCapability.mock.calls.find(
      (call: any) => call[0].deviceId === 'dev-1' && call[0].capabilityId === 'onoff' && call[0].value === true,
    );

    // This SHOULD pass but will FAIL due to the 50% budget bug
    expect(restoreCall).toBeDefined();
  });


  it('should not consider devices already at shed temperature as candidates', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater 1', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 20); // Normal temp
    await dev1.setCapabilityValue('measure_power', 1000); // 1 kW
    await dev1.setCapabilityValue('onoff', true);

    const dev2 = new MockDevice('dev-2', 'Heater 2', ['target_temperature', 'measure_power', 'onoff']);
    await dev2.setCapabilityValue('target_temperature', 20); // Normal temp
    await dev2.setCapabilityValue('measure_power', 1000); // 1 kW
    await dev2.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2]),
    });

    // Configure shed behavior to lower temperature
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'dev-1': { action: 'set_temperature', temperature: 15 },
      'dev-2': { action: 'set_temperature', temperature: 15 },
    });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 20, 'dev-2': 20 } });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // 1. Initial State: Both devices ON at 20C. Total power 2kW. Limit 3kW. No shed.

    // 2. Trigger Overshoot to shed dev-1
    // Set Limit to 1.5kW. Total 2kW. Need to shed 0.5kW.
    (app as any).computeDynamicSoftLimit = () => 1.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1.5);
    }
    await (app as any).recordPowerSample(2000);

    // Verify dev-1 or dev-2 is shed to 15C.
    const plan1 = mockHomeyInstance.settings.get('device_plan_snapshot');
    const shedCount1 = plan1.devices.filter((d: any) => d.plannedState === 'shed').length;
    expect(shedCount1).toBeGreaterThanOrEqual(1);

    // We assume dev-1 was shed (or dev-2). Let's say dev-1.
    // Manually update dev-1 to reflect it reached 15C.
    await dev1.setCapabilityValue('target_temperature', 15);

    // 3. Trigger another overshoot.
    // Total power still 2kW (heater might still run at lower temp).
    // Limit drops to 0.5kW. Need to shed another 1.5kW.
    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }

    // Spy on log to catch "Plan: ..."
    const logSpy = jest.spyOn((app as any), 'log');

    await (app as any).recordPowerSample(2000);

    // Check logs for candidate count
    const planLogs = logSpy.mock.calls.filter(args => typeof args[0] === 'string' && args[0].startsWith('Plan:'));
    const lastPlanLog = planLogs[planLogs.length - 1][0] as string;

    // Extract candidate count from log "Plan: overshoot=..., candidates=X, ..."
    const match = lastPlanLog.match(/candidates=(\d+)/);
    const candidateCount = match ? parseInt(match[1], 10) : -1;

    // Expectations:
    // dev-1 is already at shed temp (15C). It should NOT be a candidate.
    // dev-2 is at normal temp (20C). It SHOULD be a candidate.
    // So candidates should be 1.

    expect(candidateCount).toBe(1);
  });


  it('should not plan shedding when headroom is positive but less than restore margin (hysteresis zone)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater 1', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 20);
    await dev1.setCapabilityValue('measure_power', 1000); // 1 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 10);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.5); // Large margin for testing
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    // We want behavior: set_temperature to check if it tries to shed
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 20 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'dev-1': { action: 'set_temperature', temperature: 15 },
    });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // 1. Set Soft Limit to 1.1 kW.
    (app as any).computeDynamicSoftLimit = () => 1.1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1.1);
    }

    // 2. Report Power 1.0 kW.
    // Headroom = 1.1 - 1.0 = 0.1 kW.
    // Restore Margin = 0.5 kW.
    // 0 < Headroom (0.1) < Margin (0.5).
    // Expected: No shed (positive headroom), but NO restore either (below margin).
    // Current Bug: App subtracts margin: 0.1 - 0.5 = -0.4 -> OVERSHOOT! -> Sheds dev-1.

    const logSpy = jest.spyOn((app as any), 'log');

    await (app as any).recordPowerSample(1000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const sheds = plan.devices.filter((d: any) => d.plannedState === 'shed');

    // Expectation: No shedding because we are under the limit (0.1 kW free).
    expect(sheds.length).toBe(0);

    // Verify no "Plan: overshoot" log
    const overshootLogs = logSpy.mock.calls.filter(args => typeof args[0] === 'string' && args[0].includes('Plan: overshoot'));
    expect(overshootLogs.length).toBe(0);
  });


  it('should throttle restoration of set_temperature devices to one per cycle', async () => {
    // Detects bug where multiple devices shed via set_temperature restore simultaneously
    const dev1 = new MockDevice('dev-1', 'Heater 1', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 20);
    await dev1.setCapabilityValue('measure_power', 1000); // 1 kW
    await dev1.setCapabilityValue('onoff', true);

    const dev2 = new MockDevice('dev-2', 'Heater 2', ['target_temperature', 'measure_power', 'onoff']);
    await dev2.setCapabilityValue('target_temperature', 20);
    await dev2.setCapabilityValue('measure_power', 1000); // 1 kW
    await dev2.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 10);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.2);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true, 'dev-2': true });

    // Configure shed behavior to set_temperature
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 20, 'dev-2': 20 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'dev-1': { action: 'set_temperature', temperature: 10 },
      'dev-2': { action: 'set_temperature', temperature: 10 },
    });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    jest.setSystemTime(new Date('2023-01-01T12:00:00Z'));

    const app = createApp();
    await app.onInit();

    // 1. Trigger Overshoot to shed both devices
    // Limit = 0.5 kW. Usage = 2.0 kW. Overshoot.
    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }
    await (app as any).recordPowerSample(2000);

    // Verify both are shed to 10C
    const plan1 = mockHomeyInstance.settings.get('device_plan_snapshot');
    const shedCount = plan1.devices.filter((d: any) => d.plannedState === 'shed').length;
    expect(shedCount).toBe(2);

    // Update devices to reflect shed state
    await dev1.setCapabilityValue('target_temperature', 10);
    await dev2.setCapabilityValue('target_temperature', 10);

    // 2. Restore Capacity
    // Limit = 5.0 kW. Usage = 2.0 kW (still pulling power at lower temp? or less. say 2.0 for simplicity).
    // Headroom = 3.0 kW. Enough to restore both.
    (app as any).computeDynamicSoftLimit = () => 5.0;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 5.0);
    }

    // Advance time to bypass cooldowns if any
    jest.advanceTimersByTime(10 * 60 * 1000);
    jest.setSystemTime(new Date('2023-01-01T12:10:00Z'));

    // Explicitly clear cooldowns to avoid test flakiness with Date mocking
    (app as any).lastSheddingMs = 0;
    (app as any).lastOvershootMs = 0;
    (app as any).lastDeviceShedMs = {};

    await (app as any).recordPowerSample(2000);

    const plan2 = mockHomeyInstance.settings.get('device_plan_snapshot');

    // Check how many devices are still planned as 'shed'
    // Ideally, only one should be restored, so one should still be 'shed'.
    // If the bug exists, both will be restored (0 shed).
    const shedDevicesAfterRestore = plan2.devices.filter((d: any) => d.plannedState === 'shed');

    // We expect throttling: only 1 device restored per cycle.
    // So 1 device should still be shed.
    expect(shedDevicesAfterRestore.length).toBeGreaterThanOrEqual(1);

    // Also verify that at least one IS restored (not both shed)
    expect(shedDevicesAfterRestore.length).toBeLessThan(2);
  });
});
