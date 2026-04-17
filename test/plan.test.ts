/**
 * @vitest-environment node
 */
import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
  setAutoEnableMockDevices,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

const flushPromises = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
const setManagedControllableDevices = (devices: Record<string, boolean>) => {
  mockHomeyInstance.settings.set('controllable_devices', devices);
  const managed = { ...devices };
  mockHomeyInstance.settings.set('managed_devices', managed);
};

const setManagedAndControllableDevices = (params: {
  managed: Record<string, boolean>;
  controllable: Record<string, boolean>;
}) => {
  mockHomeyInstance.settings.set('managed_devices', params.managed);
  mockHomeyInstance.settings.set('controllable_devices', params.controllable);
};

async function advanceTimeAndRecordPower(app: any, advanceMs: number, powerW: number): Promise<void> {
  vi.advanceTimersByTime(advanceMs);
  await app.recordPowerSample(powerW);
}

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
  device.setCapabilityMetadata('target_temperature', {
    units: '°C',
    min: 35,
    max: 75,
    step: 5,
  });
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
    setAutoEnableMockDevices(true);
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    setAutoEnableMockDevices(false);
    vi.clearAllTimers();
  });

  it('emits plan_updated realtime event when plan changes', async () => {
    const device = new MockDevice('dev-1', 'Test Heater', ['target_temperature', 'measure_power']);
    await device.setCapabilityValue('measure_power', 1000);

    setMockDrivers({
      driverA: new MockDriver('driverA', [device]),
    });

    const app = createApp();
    await app.onInit();
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;

    // Clear events from initialization
    mockHomeyInstance.api.clearRealtimeEvents();

    // Trigger a plan rebuild by recording power
    await (app as any).recordPowerSample(1000);
    await flushPromises();

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
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;

    // Deterministic soft limit for the test.
    (app as any).computeDynamicSoftLimit = () => 9;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 9);
    }

    // Report 12 kW total; over the 9 kW soft limit
    await (app as any).recordPowerSample(12000);
    await flushPromises();

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
    await flushPromises();

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

  it('tracks plan overshoot state transitions', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('measure_power', 5000); // 5 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 10 } });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 2;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 2);
    }

    // First cycle: overshoot enters
    await (app as any).recordPowerSample(5000);
    expect((app as any).planEngine.state.wasOvershoot).toBe(true);
    expect((app as any).planEngine.state.overshootLogged).toBe(true);

    // Second cycle: still in overshoot, state remains stable (no double-log)
    await (app as any).recordPowerSample(5000);
    expect((app as any).planEngine.state.wasOvershoot).toBe(true);

    // Third cycle: power drops — overshoot clears
    await (app as any).recordPowerSample(0);
    expect((app as any).planEngine.state.wasOvershoot).toBe(false);
    expect((app as any).planEngine.state.overshootLogged).toBe(false);
  });

  it('logs bounded overshoot-entry contributors with controlled and uncontrolled deltas', async () => {
    setMockDrivers({});
    setManagedAndControllableDevices({
      managed: {
        'dev-ctrl': true,
        'dev-pending': true,
        'dev-cooldown': true,
        'dev-uncontrolled': true,
      },
      controllable: {
        'dev-ctrl': true,
        'dev-pending': true,
        'dev-cooldown': true,
        'dev-uncontrolled': false,
      },
    });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 4;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4);
    }

    const structuredEvents: Record<string, unknown>[] = [];
    (app as any).planEngine.builder.deps.structuredLog = {
      info: (obj: Record<string, unknown>) => { structuredEvents.push(obj); },
      warn: vi.fn(),
      error: vi.fn(),
      child: () => (app as any).planEngine.builder.deps.structuredLog,
    };

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-ctrl',
        name: 'Controlled Heater',
        targets: [],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 1.0,
        expectedPowerKw: 0.8,
        controllable: true,
      },
      {
        id: 'dev-pending',
        name: 'Pending Heater',
        targets: [],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 0.2,
        expectedPowerKw: 0.2,
        controllable: true,
      },
      {
        id: 'dev-cooldown',
        name: 'Cooldown Heater',
        targets: [],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 0.4,
        expectedPowerKw: 0.4,
        controllable: true,
      },
      {
        id: 'dev-uncontrolled',
        name: 'Sauna',
        targets: [],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 0.5,
        controllable: false,
      },
    ]);

    (app as any).planEngine.state.pendingBinaryCommands['dev-pending'] = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: Date.now(),
    };
    (app as any).planEngine.state.lastDeviceShedMs['dev-cooldown'] = Date.now();
    (app as any).planEngine.state.lastInstabilityMs = Date.now();

    await (app as any).recordPowerSample(3000);
    structuredEvents.length = 0;

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-ctrl',
        name: 'Controlled Heater',
        targets: [],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 2.6,
        expectedPowerKw: 1.1,
        controllable: true,
      },
      {
        id: 'dev-pending',
        name: 'Pending Heater',
        targets: [],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 0.7,
        expectedPowerKw: 0.2,
        controllable: true,
      },
      {
        id: 'dev-cooldown',
        name: 'Cooldown Heater',
        targets: [],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 0.8,
        expectedPowerKw: 0.4,
        controllable: true,
      },
      {
        id: 'dev-uncontrolled',
        name: 'Sauna',
        targets: [],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 1.8,
        controllable: false,
      },
    ]);

    await (app as any).recordPowerSample(5300);

    const overshootEvent = structuredEvents.find((event) => event.event === 'overshoot_entered') as any;
    expect(overshootEvent).toBeTruthy();
    expect(overshootEvent.reasonCode).toBe('active_overshoot');
    expect(overshootEvent.lastPlanBuildAgeMs).toEqual(expect.any(Number));
    expect(overshootEvent.lastPowerUpdateAgeMs).toEqual(expect.any(Number));
    expect(overshootEvent.overshootPlanAgeMs).toEqual(expect.any(Number));
    expect(overshootEvent.overshootPowerSampleAgeMs).toEqual(expect.any(Number));
    expect(overshootEvent.overshootTotalDeltaKw).toBeCloseTo(2.3, 5);
    expect(overshootEvent.overshootAttributionDeltaKw).toBeCloseTo(3.8, 5);
    expect(overshootEvent.overshootUnattributedDeltaKw).toBeCloseTo(-1.5, 5);
    expect(overshootEvent.overshootTopControlledContributors).toEqual([
      expect.objectContaining({
        deviceId: 'dev-ctrl',
        deltaKw: 1.6,
        controllable: true,
        expectedByPreviousPlan: true,
        newPowerSource: 'measured',
      }),
      expect.objectContaining({
        deviceId: 'dev-pending',
        deltaKw: 0.5,
        changedDuringPendingWindow: false,
      }),
      expect.objectContaining({
        deviceId: 'dev-cooldown',
        deltaKw: 0.4,
      }),
    ]);
    expect(overshootEvent.overshootTopUncontrolledContributors).toEqual([
      expect.objectContaining({
        deviceId: 'dev-uncontrolled',
        deltaKw: 1.3,
        controllable: false,
        expectedByPreviousPlan: null,
      }),
    ]);
  });

  it('limits overshoot-entry contributors to the largest positive deltas', async () => {
    setMockDrivers({});
    setManagedAndControllableDevices({
      managed: {
        'dev-1': true,
        'dev-2': true,
        'dev-3': true,
        'dev-4': true,
      },
      controllable: {
        'dev-1': true,
        'dev-2': true,
        'dev-3': true,
        'dev-4': true,
      },
    });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 4;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4);
    }

    const structuredEvents: Record<string, unknown>[] = [];
    (app as any).planEngine.builder.deps.structuredLog = {
      info: (obj: Record<string, unknown>) => { structuredEvents.push(obj); },
      warn: vi.fn(),
      error: vi.fn(),
      child: () => (app as any).planEngine.builder.deps.structuredLog,
    };

    (app as any).deviceManager.setSnapshotForTests([
      { id: 'dev-1', name: 'One', targets: [], currentOn: true, currentState: 'on', measuredPowerKw: 0.5, controllable: true },
      { id: 'dev-2', name: 'Two', targets: [], currentOn: true, currentState: 'on', measuredPowerKw: 0.5, controllable: true },
      { id: 'dev-3', name: 'Three', targets: [], currentOn: true, currentState: 'on', measuredPowerKw: 0.5, controllable: true },
      { id: 'dev-4', name: 'Four', targets: [], currentOn: true, currentState: 'on', measuredPowerKw: 0.5, controllable: true },
    ]);

    await (app as any).recordPowerSample(2000);
    structuredEvents.length = 0;

    (app as any).deviceManager.setSnapshotForTests([
      { id: 'dev-1', name: 'One', targets: [], currentOn: true, currentState: 'on', measuredPowerKw: 1.5, controllable: true },
      { id: 'dev-2', name: 'Two', targets: [], currentOn: true, currentState: 'on', measuredPowerKw: 1.2, controllable: true },
      { id: 'dev-3', name: 'Three', targets: [], currentOn: true, currentState: 'on', measuredPowerKw: 1.0, controllable: true },
      { id: 'dev-4', name: 'Four', targets: [], currentOn: true, currentState: 'on', measuredPowerKw: 0.8, controllable: true },
    ]);

    await (app as any).recordPowerSample(4500);

    const overshootEvent = structuredEvents.find((event) => event.event === 'overshoot_entered') as any;
    expect(overshootEvent).toBeTruthy();
    expect(overshootEvent.overshootTopControlledContributors).toHaveLength(3);
    expect(overshootEvent.overshootTopControlledContributors.map((entry: any) => entry.deviceId)).toEqual([
      'dev-1',
      'dev-2',
      'dev-3',
    ]);
  });

  it('marks overshoot contributors inside a pending binary off window', async () => {
    setMockDrivers({});
    setManagedAndControllableDevices({
      managed: { 'dev-off-pending': true },
      controllable: { 'dev-off-pending': true },
    });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    const structuredEvents: Record<string, unknown>[] = [];
    (app as any).planEngine.builder.deps.structuredLog = {
      info: (obj: Record<string, unknown>) => { structuredEvents.push(obj); },
      warn: vi.fn(),
      error: vi.fn(),
      child: () => (app as any).planEngine.builder.deps.structuredLog,
    };

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-off-pending',
        name: 'Heater Awaiting Off',
        targets: [],
        currentOn: true,
        currentState: 'on',
        communicationModel: 'local',
        measuredPowerKw: 0.7,
        controllable: true,
      },
    ]);

    await (app as any).recordPowerSample(700);
    structuredEvents.length = 0;

    (app as any).planEngine.state.pendingBinaryCommands['dev-off-pending'] = {
      capabilityId: 'onoff',
      desired: false,
      startedMs: Date.now(),
    };
    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-off-pending',
        name: 'Heater Awaiting Off',
        targets: [],
        currentOn: true,
        currentState: 'on',
        communicationModel: 'local',
        measuredPowerKw: 1.3,
        controllable: true,
      },
    ]);

    await (app as any).recordPowerSample(1300);

    const overshootEvent = structuredEvents.find((event) => event.event === 'overshoot_entered') as any;
    expect(overshootEvent).toBeTruthy();
    expect(overshootEvent.overshootTopControlledContributors).toEqual([
      expect.objectContaining({
        deviceId: 'dev-off-pending',
        changedDuringPendingWindow: true,
      }),
    ]);
  });

  it('marks overshoot contributors inside a pending binary on window', async () => {
    setMockDrivers({});
    setManagedAndControllableDevices({
      managed: { 'dev-on-pending': true },
      controllable: { 'dev-on-pending': true },
    });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 4;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4);
    }

    const structuredEvents: Record<string, unknown>[] = [];
    (app as any).planEngine.builder.deps.structuredLog = {
      info: (obj: Record<string, unknown>) => { structuredEvents.push(obj); },
      warn: vi.fn(),
      error: vi.fn(),
      child: () => (app as any).planEngine.builder.deps.structuredLog,
    };

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-on-pending',
        name: 'Pending Restore Heater',
        targets: [],
        currentOn: false,
        currentState: 'off',
        measuredPowerKw: 0,
        expectedPowerKw: 1.4,
        controllable: true,
      },
    ]);

    await (app as any).recordPowerSample(2500);
    structuredEvents.length = 0;

    (app as any).planEngine.state.pendingBinaryCommands['dev-on-pending'] = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: Date.now(),
    };

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-on-pending',
        name: 'Pending Restore Heater',
        targets: [],
        currentOn: false,
        currentState: 'off',
        measuredPowerKw: 1.6,
        expectedPowerKw: 1.4,
        controllable: true,
      },
    ]);

    await (app as any).recordPowerSample(4500);

    const overshootEvent = structuredEvents.find((event) => event.event === 'overshoot_entered') as any;
    expect(overshootEvent).toBeTruthy();
    expect(overshootEvent.overshootTopControlledContributors).toEqual([
      expect.objectContaining({
        deviceId: 'dev-on-pending',
        changedDuringPendingWindow: true,
      }),
    ]);
  });

  it('marks overshoot contributors inside a pending target command window', async () => {
    setMockDrivers({});
    setManagedAndControllableDevices({
      managed: { 'dev-target-pending': true },
      controllable: { 'dev-target-pending': true },
    });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-target-pending': 23 } });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    const structuredEvents: Record<string, unknown>[] = [];
    (app as any).planEngine.builder.deps.structuredLog = {
      info: (obj: Record<string, unknown>) => { structuredEvents.push(obj); },
      warn: vi.fn(),
      error: vi.fn(),
      child: () => (app as any).planEngine.builder.deps.structuredLog,
    };

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-target-pending',
        name: 'Target Heater',
        deviceType: 'temperature',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 0.7,
        controllable: true,
      },
    ]);

    await (app as any).recordPowerSample(700);
    structuredEvents.length = 0;

    (app as any).planEngine.state.pendingTargetCommands['dev-target-pending'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now(),
      lastAttemptMs: Date.now(),
      retryCount: 0,
      nextRetryAtMs: Date.now() + 60_000,
      status: 'waiting_confirmation',
    };
    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-target-pending',
        name: 'Target Heater',
        deviceType: 'temperature',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        currentOn: true,
        currentState: 'on',
        measuredPowerKw: 1.2,
        controllable: true,
      },
    ]);

    await (app as any).recordPowerSample(1200);

    const overshootEvent = structuredEvents.find((event) => event.event === 'overshoot_entered') as any;
    expect(overshootEvent).toBeTruthy();
    expect(overshootEvent.overshootTopControlledContributors).toEqual([
      expect.objectContaining({
        deviceId: 'dev-target-pending',
        changedDuringPendingWindow: true,
      }),
    ]);
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
    (app as any).planEngine.state.inShortfall = true;
    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }
    await (app as any).recordPowerSample(1200);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.shedAction).toBe('set_temperature');
    expect(devPlan?.reason).toContain('shortfall (need');
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
    (app as any).planEngine.state.lastDeviceShedMs['dev-1'] = Date.now();
    (app as any).planEngine.state.lastInstabilityMs = Date.now();

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

    await (app as any).refreshTargetDevicesSnapshot();
    await (app as any).planService.rebuildPlanFromCache();

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
    (app as any).planEngine.state.lastInstabilityMs = Date.now();
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
    expect(devPlan?.reason).toContain('cooldown (shedding');
  });

  it('does not hold minimum-temperature shedding when capacity control is disabled', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 16);
    await dev1.setCapabilityValue('measure_power', 1200); // 1.2 kW
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 20 } });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'set_temperature', temperature: 16 } });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': false });
    mockHomeyInstance.settings.set('price_optimization_enabled', false);

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 16, unit: '°C' }],
        powerKw: 1.2,
        currentOn: true,
      },
    ]);

    (app as any).planEngine.state.lastInstabilityMs = Date.now();
    (app as any).planEngine.state.lastPlannedShedIds = new Set(['dev-1']);

    await (app as any).planService.rebuildPlanFromCache();

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('keep');
    expect(devPlan?.plannedTarget).toBe(20);
    expect(devPlan?.reason).toBe('capacity control off');
  });

  it('restores on/off devices when capacity control is disabled', async () => {
    const dev1 = new MockDevice('dev-1', 'Lamp', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('onoff', false);
    await dev1.setCapabilityValue('measure_power', 0);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': false });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();
    (app as any).planEngine.state.lastDeviceShedMs['dev-1'] = Date.now();

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Lamp',
        targets: [],
        currentOn: false,
        capabilities: ['onoff'],
      },
    ]);

    await (app as any).planService.rebuildPlanFromCache();

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('keep');
    expect(await dev1.getCapabilityValue('onoff')).toBe(true);
  });

  it('does not restore on/off devices when capacity control is disabled if not shed', async () => {
    const dev1 = new MockDevice('dev-1', 'Lamp', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('onoff', false);
    await dev1.setCapabilityValue('measure_power', 0);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': false });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Lamp',
        targets: [],
        currentOn: false,
        capabilities: ['onoff'],
      },
    ]);

    await (app as any).planService.rebuildPlanFromCache();

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('keep');
    expect(await dev1.getCapabilityValue('onoff')).toBe(false);
  });

  it('clears shed marker after restoring uncontrolled devices', async () => {
    const dev1 = new MockDevice('dev-1', 'Lamp', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('onoff', false);
    await dev1.setCapabilityValue('measure_power', 0);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': false });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();
    (app as any).planEngine.state.lastDeviceShedMs['dev-1'] = Date.now();

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Lamp',
        targets: [],
        currentOn: false,
        capabilities: ['onoff'],
      },
    ]);

    await (app as any).planService.rebuildPlanFromCache();
    expect(await dev1.getCapabilityValue('onoff')).toBe(true);

    await dev1.setCapabilityValue('onoff', false);
    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Lamp',
        targets: [],
        currentOn: false,
        capabilities: ['onoff'],
      },
    ]);

    await (app as any).planService.rebuildPlanFromCache();
    expect(await dev1.getCapabilityValue('onoff')).toBe(false);
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
    (app as any).planEngine.state.lastInstabilityMs = Date.now() - 180000; // cooldown expired
    (app as any).planEngine.state.lastRecoveryMs = Date.now() - 180000;
    (app as any).computeDynamicSoftLimit = () => 5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 5);
    }
    // Deactivate the guard after restoring headroom so shedding hysteresis allows it.
    await (app as any).capacityGuard?.setSheddingActive(false);

    await (app as any).recordPowerSample(500);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('keep');
    expect(devPlan?.plannedTarget).toBe(21);
    expect(devPlan?.reason).toContain('keep');
    expect(devPlan?.reason).not.toContain('cooldown');
  });

  it('shows headroom cooldown on active devices after a meaningful step-down', async () => {
    const dev1 = new MockDevice('dev-1', 'EV Charger', ['measure_power', 'onoff']);
    await dev1.setCapabilityValue('measure_power', 1190);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    setManagedControllableDevices({ 'dev-1': true });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 10;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 10);
    }

    await (app as any).recordPowerSample(2000);
    await flushPromises();

    const runSetExpected = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    expect(runSetExpected).toBeDefined();

    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 6000 })).resolves.toBe(true);
    await flushPromises();
    await expect(runSetExpected({ device: { id: 'dev-1' }, power_w: 3500 })).resolves.toBe(true);
    await flushPromises();

    await (app as any).planService.rebuildPlanFromCache('headroom_step_down_test');
    await flushPromises();

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('keep');
    expect(devPlan?.reason).toMatch(/^headroom cooldown \(\d+s remaining; usage 3\.50 -> 1\.19kW\)$/);
    expect(devPlan?.headroomCardBlocked).toBe(true);
    expect(devPlan?.headroomCardCooldownSec).toBeGreaterThanOrEqual(55);
    expect(devPlan?.headroomCardCooldownSec).toBeLessThanOrEqual(60);
    expect(devPlan?.headroomCardCooldownSource).toBe('step_down');
    expect(devPlan?.headroomCardCooldownFromKw).toBe(3.5);
    expect(devPlan?.headroomCardCooldownToKw).toBeCloseTo(1.19, 2);
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
    (app as any).planEngine.state.lastInstabilityMs = Date.now(); // force cooldown window
    (app as any).planEngine.state.lastDeviceShedMs['dev-1'] = Date.now();

    await (app as any).recordPowerSample(1000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.reason).toContain('cooldown (shedding');
    expect(devPlan?.headroomCardBlocked).toBe(true);
    expect(devPlan?.headroomCardCooldownSource).toBe('pels_shed');
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
    setManagedControllableDevices({ 'dev-1': false });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }

    await (app as any).recordPowerSample(600); // 0.6 kW total, overshoot of 0.1 kW

    expect((app as any).planEngine.state.lastInstabilityMs).toBeNull();
  });

  it('executes shedding action when plan says shed and dry run is off', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    const spy = vi
      .spyOn((app as any).planEngine.executor, 'applySheddingToDevice')
      .mockResolvedValue(undefined);

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
    await minTempDev.setCapabilityValue('target_temperature', 16); // already at configured shed minimum

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

    setManagedControllableDevices({ 'dev-ctl': true, 'dev-non': false });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-ctl': true, 'dev-non': true });

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

  it('excludes unmanaged devices from the plan snapshot', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': false });

    const app = createApp();
    await app.onInit();

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan).toBeUndefined();
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
    await flushPromises();

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
    await (app as any).refreshTargetDevicesSnapshot();

    // Clear shedding-related cooldowns but NOT restore margin consideration
    (app as any).planEngine.state.lastInstabilityMs = 0;
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
    (app as any).planEngine.state.lastInstabilityMs = 0;
    (app as any).planEngine.state.lastRestoreMs = 0;

    // Set soft limit high enough for restoration:
    // with recent-shed backoff (1.15×) → needed≈1.38kW, plus 0.25kW reserve + 0.25kW floor.
    // Power 500W, soft limit 2.5kW => headroomRaw 2.0kW. That clears the stricter restore gate.
    (app as any).computeDynamicSoftLimit = () => 2.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 2.5);
    }

    // Soft-limit changes alone no longer trigger an immediate rebuild.
    // Force the periodic max-interval rebuild path for this restore check.
    (app as any).powerSampleRebuildState.lastMs = (app as any).getPlanRebuildNowMs() - 200;
    await (app as any).recordPowerSample(500);
    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-1')?.plannedState).toBe('keep');
  });

  it('restores devices when plan says keep even if headroom is below its power need', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    await dev1.setCapabilityValue('onoff', false);
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
          controlCapabilityId: 'onoff',
          currentOn: false,
          plannedState: 'keep',
          currentState: 'off',
          plannedTarget: null,
          currentTarget: null,
          powerKw: 2, // needs at least 2 + margin headroom
          controllable: true,
        },
      ],
    };

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    await (app as any).applyPlanActions(plan);
    expect(putSpy).toHaveBeenCalledWith(
      'manager/devices/device/dev-1/capability/onoff',
      { value: true },
    );
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
    plan = await (app as any).planService.buildDevicePlanSnapshot([
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

  it('marks off devices as shed when headroom is unknown', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 0);
    await dev1.setCapabilityValue('onoff', false);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    setManagedControllableDevices({ 'dev-1': true });

    const app = createApp();
    await app.onInit();

    const plan = await (app as any).planService.buildDevicePlanSnapshot([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 1,
        priority: 1,
        currentOn: false,
        controllable: true,
      },
    ]);
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedState).toBe('shed');
    expect(devPlan?.reason).toContain('headroom unknown');
  });

  it('sheds a controllable device when overshooting with real power sample (non-dry-run)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000); // 2 kW
    await dev1.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);
    setManagedControllableDevices({ 'dev-1': true });

    const app = createApp();
    await app.onInit();

    // Force soft limit to 1 kW so 2 kW total is an overshoot.
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    const shedSpy = vi
      .spyOn((app as any).planEngine.executor, 'applySheddingToDevice')
      .mockResolvedValue(undefined);

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
    setManagedControllableDevices({ 'dev-1': true, 'dev-2': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Force soft limit to about 3.1 kW so total 5.63 kW is an overshoot of ~2.53 kW.
    (app as any).computeDynamicSoftLimit = () => 3.1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3.1);
    }

    const shedSpy = vi
      .spyOn((app as any).planEngine.executor, 'applySheddingToDevice')
      .mockResolvedValue(undefined);

    await (app as any).recordPowerSample(5630); // 5.63 kW total

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const shedIds = plan.devices.filter((d: any) => d.plannedState === 'shed').map((d: any) => d.id);
    expect(shedIds).toEqual(expect.arrayContaining(['dev-1', 'dev-2']));
    expect(shedSpy).toHaveBeenCalledWith('dev-1', 'Heater A', undefined);
    expect(shedSpy).toHaveBeenCalledWith('dev-2', 'Heater B', undefined);
  });

  it('does not shed additional devices without a new power sample after an initial shed', async () => {
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    setManagedControllableDevices({ 'dev-1': true, 'dev-2': true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1, 'dev-2': 10 } });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    (app as any).deviceManager.setSnapshotForTests([
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
    (app as any).deviceManager.setSnapshotForTests([
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

    (app as any).planEngine.state.lastRestoreMs = Date.now() - 60000;
    await (app as any).planService.rebuildPlanFromCache();
    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan?.plannedState).toBe('keep');
  });

  it('allows additional shedding after a new power sample arrives', async () => {
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    setManagedControllableDevices({ 'dev-1': true, 'dev-2': true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1, 'dev-2': 10 } });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    (app as any).deviceManager.setSnapshotForTests([
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
    (app as any).deviceManager.setSnapshotForTests([
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

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    // Keep an onoff-capable snapshot entry so turn_off is attempted, then force a second attempt.
    (app as any).deviceManager.setSnapshotForTests([{
      id: 'dev-1',
      name: 'Heater A',
      targets: [],
      capabilities: ['onoff'],
      currentOn: true,
      controllable: true,
    }]);

    await (app as any).applySheddingToDevice('dev-1', 'Heater A');
    // Simulate plan still thinks it is on to force a second attempt.
    (app as any).deviceManager.setSnapshotForTests([{
      id: 'dev-1',
      name: 'Heater A',
      targets: [],
      capabilities: ['onoff'],
      currentOn: true,
      controllable: true,
    }]);
    await (app as any).applySheddingToDevice('dev-1', 'Heater A');

    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it('records shed timestamp and skips turn_off for devices without onoff and temperature target', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    (app as any).deviceManager.setSnapshotForTests([{
      id: 'dev-1',
      name: 'No On/Off Device',
      targets: [],
      capabilities: ['measure_power'],
      currentOn: true,
      controllable: true,
    }]);

    const before = (app as any).planEngine.state.lastDeviceShedMs['dev-1'];
    await (app as any).applySheddingToDevice('dev-1', 'No On/Off Device');

    expect(putSpy).not.toHaveBeenCalled();
    const after = (app as any).planEngine.state.lastDeviceShedMs['dev-1'];
    expect(typeof after).toBe('number');
    if (typeof before === 'number') {
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });

  it('uses currentState on for controllable temperature devices without onoff', async () => {
    const dev1 = new MockDevice('dev-1', 'Temp-only device', ['target_temperature', 'measure_temperature', 'measure_power']);
    await dev1.setCapabilityValue('target_temperature', 21);
    await dev1.setCapabilityValue('measure_temperature', 20);
    await dev1.setCapabilityValue('measure_power', 250);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21 } });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 5);
    }

    await (app as any).recordPowerSample(250);
    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.currentState).toBe('not_applicable');
    expect(devPlan?.reason).not.toContain('restore');
  });

  it('does not repeatedly shed the same device across consecutive samples (flap guard)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power', 'target_temperature']);
    await dev1.setCapabilityValue('measure_power', 2000); // 2 kW
    await dev1.setCapabilityValue('onoff', true);
    await dev1.setCapabilityValue('target_temperature', 20);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    // Force a low soft limit so the device must be shed.
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    // First overshoot triggers shedding.
    await (app as any).recordPowerSample(5000);
    // Let async plan actions flush before second sample.
    await flushPromises();
    // Second overshoot arrives before cooldown; should not call setCapabilityValue again.
    await (app as any).recordPowerSample(5000);
    await flushPromises();

    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it('uses settings.load as power when measure_power is zero', async () => {
    const app = createApp();
    await app.onInit();

    const sampleDevice = {
      id: 'thermostat-1',
      name: 'Room Thermostat',
      class: 'thermostat',
      capabilities: ['onoff', 'target_temperature', 'measure_power', 'measure_temperature'],
      capabilitiesObj: {
        onoff: { value: false, id: 'onoff' },
        target_temperature: { value: 22, units: '°C', id: 'target_temperature' },
        measure_power: { value: 0, id: 'measure_power' },
        measure_temperature: { value: 21, id: 'measure_temperature' },
      },
      settings: { load: 450 },
    };

    const parsed = (app as any).deviceManager.parseDeviceListForTests([sampleDevice]);
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

    setManagedControllableDevices({ 'dev-on': true, 'dev-off': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Soft limit 3 kW, total 6.3 kW -> need ~3.3 kW. Off device should not be counted as shed.
    (app as any).computeDynamicSoftLimit = () => 3;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3);
    }

    const shedSpy = vi
      .spyOn((app as any).planEngine.executor, 'applySheddingToDevice')
      .mockResolvedValue(undefined);

    await (app as any).recordPowerSample(6300);

    expect(shedSpy).toHaveBeenCalledWith('dev-on', 'On Device', undefined);
    expect(shedSpy).not.toHaveBeenCalledWith('dev-off', 'Off Device');
  });

  it('triggers capacity_shortfall when deficit remains after shedding all controllables', async () => {
    // Shortfall triggers when power exceeds the shortfall threshold AND no devices left to shed.
    // The shortfall threshold is based on remaining hourly budget / remaining time.
    // At any point in the hour with no usage, threshold = hard_cap / remainingHours.
    // To ensure shortfall triggers regardless of when the test runs, use a low limit.
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_limit_kw', 5); // Low limit ensures threshold is exceeded
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const triggerSpy = vi.fn().mockReturnValue({ catch: vi.fn() });
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
    (app as any).deviceManager.setSnapshotForTests([
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

    // Use very high power to ensure it exceeds any threshold.
    // Threshold is clamped with a minimum remaining time of 0.01h, so max threshold is 500kW.
    await (app as any).recordPowerSample(600000); // 600kW definitely exceeds threshold
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
    setManagedControllableDevices({ 'dev-1': true, 'dev-2': true });

    const triggerSpy = vi.fn();
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

  it('does not trigger capacity_shortfall repeatedly while already in shortfall state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(Date.UTC(2025, 0, 15, 12, 0, 0)));
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const triggerSpy = vi.fn().mockReturnValue({ catch: vi.fn() });
    const originalGetTrigger = mockHomeyInstance.flow.getTriggerCard as any;
    mockHomeyInstance.flow.getTriggerCard = ((id: string) => {
      if (id === 'capacity_shortfall') {
        return { trigger: triggerSpy };
      }
      return originalGetTrigger();
    }) as any;

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
      },
    ]);

    await (app as any).recordPowerSample(500000);
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    await (app as any).recordPowerSample(550000);
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    await (app as any).recordPowerSample(520000);
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    mockHomeyInstance.flow.getTriggerCard = originalGetTrigger;
    vi.useRealTimers();
  });

  it('triggers capacity_shortfall again after shortfall is resolved and re-enters', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(Date.UTC(2025, 0, 15, 12, 0, 0)));
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 500);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const triggerSpy = vi.fn().mockReturnValue({ catch: vi.fn() });
    const originalGetTrigger = mockHomeyInstance.flow.getTriggerCard as any;
    mockHomeyInstance.flow.getTriggerCard = ((id: string) => {
      if (id === 'capacity_shortfall') {
        return { trigger: triggerSpy };
      }
      return originalGetTrigger();
    }) as any;

    const app = createApp();
    await app.onInit();
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 0.5,
        currentOn: true,
        controllable: true,
      },
    ]);

    await (app as any).recordPowerSample(500000);
    expect(triggerSpy).toHaveBeenCalledTimes(1);
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).toBe(true);

    await advanceTimeAndRecordPower(app, 1000, 1000);
    await advanceTimeAndRecordPower(app, 30000, 1000);
    await advanceTimeAndRecordPower(app, 31000, 1000);
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).toBe(false);

    await (app as any).recordPowerSample(500000);
    expect(triggerSpy).toHaveBeenCalledTimes(2);
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).toBe(true);

    mockHomeyInstance.flow.getTriggerCard = originalGetTrigger;
    vi.useRealTimers();
  });


  it('restores when plan says keep even immediately after shedding', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 500);
    await dev1.setCapabilityValue('onoff', false); // assumed off after a shed event

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Simulate recent shedding/overshoot.
    (app as any).planEngine.state.lastInstabilityMs = Date.now();
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.getHeadroom = () => 5; // plenty of headroom
      (app as any).capacityGuard.isSheddingActive = () => false;
    }

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

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

    expect(putSpy).toHaveBeenCalledWith(
      'manager/devices/device/dev-1/capability/onoff',
      { value: true },
    );
  });

  it('restores when plan says keep even while in shortfall state', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 500);
    await dev1.setCapabilityValue('onoff', false); // off after being shed

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Simulate being in shortfall state with positive headroom (waiting for 60s sustain)
    // This happens when power drops but we haven't sustained positive headroom long enough
    (app as any).planEngine.state.lastInstabilityMs = Date.now() - 120000; // shedding was 2 minutes ago (past cooldown)
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.getHeadroom = () => 2; // plenty of headroom
      (app as any).capacityGuard.isSheddingActive = () => false;
      (app as any).capacityGuard.isInShortfall = () => true; // still in shortfall, waiting for sustained period
    }

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

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

    expect(putSpy).toHaveBeenCalledWith(
      'manager/devices/device/dev-1/capability/onoff',
      { value: true },
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
    setManagedControllableDevices({ 'dev-1': true });

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
      step: 5,
    });
  });

  it('can shed Hoiax water heater when over capacity', async () => {
    const hoiax = createHoiaxWaterHeater('hoiax-1');
    await hoiax.setCapabilityValue('measure_power', 3000);
    await hoiax.setCapabilityValue('onoff', true);

    setMockDrivers({
      hoiaxDriver: new MockDriver('hoiaxDriver', [hoiax]),
    });

    setManagedControllableDevices({ 'hoiax-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    // Force very low soft limit
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    // Report high power - should trigger shedding
    await (app as any).recordPowerSample(5000);
    await flushPromises();

    // Verify the device was turned off
    expect(putSpy).toHaveBeenCalledWith(
      'manager/devices/device/hoiax-1/capability/onoff',
      { value: false },
    );
  });

  it('applies mode target temperature to Hoiax water heater', async () => {
    const hoiax = createHoiaxWaterHeater('hoiax-1');
    await hoiax.setCapabilityValue('target_temperature', 65);

    setMockDrivers({
      hoiaxDriver: new MockDriver('hoiaxDriver', [hoiax]),
    });

    // Configure Away mode with lower temp for water heater
    mockHomeyInstance.settings.set('mode_device_targets', {
      Away: { 'hoiax-1': 46 },
      Home: { 'hoiax-1': 65 },
    });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    // Trigger mode change via flow card
    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    await setModeListener({ mode: 'Away' });
    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'hoiax-1',
        name: 'Connected 300',
        targets: [{ id: 'target_temperature', value: 65, unit: '°C', min: 35, max: 75, step: 5 }],
        powerKw: 3,
        currentOn: true,
        controllable: true,
      },
    ]);
    await (app as any).planService.rebuildPlanFromCache();

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'hoiax-1');
    expect(devPlan?.plannedTarget).toBe(45);

    expect(putSpy).toHaveBeenCalledWith(
      'manager/devices/device/hoiax-1/capability/target_temperature',
      { value: 45 },
    );
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
    setManagedControllableDevices({ 'dev-high': true, 'dev-low': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // With hysteresis: restoreBuffer = clamp(0.2..0.6, 1.5 * 0.1 + 0.1) = 0.25 kW
    // High-pri device needs 1.5 + 0.25 = 1.75 kW
    // Soft limit = 4.5 kW, total = 3 kW, headroom = 1.5 kW
    // Shedding low-pri (1.2 kW) gives 2.7 kW potential headroom.
    // After the swap reserve (0.3) that leaves 2.4 kW, enough even with
    // recent-shed backoff plus the final admission reserve.
    (app as any).computeDynamicSoftLimit = () => 4.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4.5);
    }

    // Clear any shedding/overshoot timestamps to avoid cooldown
    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;
    (app as any).planEngine.state.lastDeviceShedMs = {};
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
    setManagedControllableDevices({ 'dev-high': true, 'dev-high2': true });

    const app = createApp();
    await app.onInit();

    // Headroom 0.5 kW, not enough for dev-high (1.5 kW + margin)
    (app as any).computeDynamicSoftLimit = () => 3;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3);
    }

    (app as any).planEngine.state.lastInstabilityMs = null;

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
    setManagedControllableDevices({ 'dev-high': true, 'dev-low': true });
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

    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;

    await (app as any).recordPowerSample(3000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const highPriPlan = plan.devices.find((d: any) => d.id === 'dev-high');
    const lowPriPlan = plan.devices.find((d: any) => d.id === 'dev-low');

    // High priority should stay off - not enough headroom even with swap
    expect(highPriPlan?.plannedState).toBe('shed');
    expect(highPriPlan?.reason).toContain('insufficient headroom');

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
    setManagedControllableDevices({ 'dev-high': true, 'dev-low1': true, 'dev-low2': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Soft limit = 4.8 kW, total = 3 kW, headroom = 1.8 kW
    // Shedding both low-priority devices yields 2.8 kW potential headroom.
    // After the swap reserve (0.3) that leaves 2.5 kW, enough for the stricter gate,
    // while one low-priority device alone is still insufficient.
    (app as any).computeDynamicSoftLimit = () => 4.8;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4.8);
    }

    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;
    (app as any).planEngine.state.lastDeviceShedMs = {};

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

    // Lower number = higher priority. The pending swap target should restore first.
    mockHomeyInstance.settings.set('capacity_priorities', {
      Home: { 'dev-swap-target': 1, 'dev-lower': 8 },
    });
    setManagedControllableDevices({
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

    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;

    // Simulate that a swap was initiated: swap target is in pendingSwapTargets
    // This mimics the state after a swap where the target hasn't been restored yet
    (app as any).planEngine.state.swapByDevice['dev-swap-target'] = { pendingTarget: true };

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
    expect(lowerPriPlan?.reason).toContain('swap pending');
  });

  it('does not block a higher-priority device behind a lower-priority pending swap target', async () => {
    const pendingLowPriorityTarget = new MockDevice('dev-pending-low', 'Pending Low Priority', ['target_temperature', 'onoff', 'measure_power']);
    await pendingLowPriorityTarget.setCapabilityValue('measure_power', 300);
    await pendingLowPriorityTarget.setCapabilityValue('onoff', false);

    const higherPriorityCandidate = new MockDevice('dev-high', 'Higher Priority', ['target_temperature', 'onoff', 'measure_power']);
    await higherPriorityCandidate.setCapabilityValue('measure_power', 300);
    await higherPriorityCandidate.setCapabilityValue('onoff', false);

    setMockDrivers({
      driverA: new MockDriver('driverA', [pendingLowPriorityTarget, higherPriorityCandidate]),
    });

    mockHomeyInstance.settings.set('capacity_priorities', {
      Home: { 'dev-pending-low': 8, 'dev-high': 1 },
    });
    setManagedControllableDevices({
      'dev-pending-low': true, 'dev-high': true,
    });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 1.4;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1.4);
    }

    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;
    (app as any).planEngine.state.swapByDevice['dev-pending-low'] = { pendingTarget: true };

    await (app as any).recordPowerSample(300);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const pendingLowPlan = plan.devices.find((d: any) => d.id === 'dev-pending-low');
    const higherPriorityPlan = plan.devices.find((d: any) => d.id === 'dev-high');

    expect(pendingLowPlan?.plannedState).toBe('keep');
    expect(pendingLowPlan?.reason).toMatch(/^meter settling \(\d+s remaining\)$/);
    expect(higherPriorityPlan?.plannedState).not.toBe('shed');
    expect(higherPriorityPlan?.reason).not.toContain('swap pending');
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
    setManagedControllableDevices({ 'dev-target': true, 'dev-swapped': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Setup: not enough headroom for swap target (needs 2kW + 0.4 = 2.4kW)
    // but enough for swapped-out device (needs 0.5kW + 0.4 = 0.9kW)
    (app as any).computeDynamicSoftLimit = () => 3;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3);
    }

    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;

    // Simulate swap state: dev-swapped was shed for dev-target, but dev-target can't restore
    // Set timestamp to 61 seconds ago (stale)
    const staleTime = Date.now() - 61000;
    (app as any).planEngine.state.swapByDevice = {
      'dev-swapped': { swappedOutFor: 'dev-target' },
      'dev-target': { pendingTarget: true, timestamp: staleTime },
    };

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
    expect((app as any).planEngine.state.swapByDevice['dev-target']?.pendingTarget).toBeFalsy();
    expect((app as any).planEngine.state.swapByDevice['dev-swapped']?.swappedOutFor).toBeUndefined();
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
    setManagedControllableDevices({ 'dev-high': true, 'dev-low': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Set up conditions for swap
    (app as any).computeDynamicSoftLimit = () => 4.8;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4.8);
    }
    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;
    (app as any).planEngine.state.lastDeviceShedMs = {};
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.sheddingActive = false;
    }

    // Capture structured log events from the plan engine
    const structuredEvents: Record<string, unknown>[] = [];
    (app as any).planEngine.builder.deps.debugStructured = (obj: Record<string, unknown>) => structuredEvents.push(obj);
    (app as any).planEngine.builder.deps.structuredLog = {
      info: (obj: Record<string, unknown>) => structuredEvents.push(obj),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => (app as any).planEngine.builder.deps.structuredLog,
    };

    // Simulate what happens when periodic refresh and power sample happen close together
    // This replicates production behavior at 08:22:36 where:
    // - Periodic refresh calls refreshTargetDevicesSnapshot() -> buildDevicePlanSnapshot()
    // - Power sample calls recordPowerSample() -> rebuildPlanFromCache() -> buildDevicePlanSnapshot()
    await Promise.all([
      (app as any).refreshTargetDevicesSnapshot(),
      (app as any).recordPowerSample(3000),
    ]);

    // Should only have ONE of each, not duplicates
    expect(structuredEvents.filter((e) => e['event'] === 'restore_swap_approved').length).toBe(1);
    expect(structuredEvents.filter((e) => e['event'] === 'restore_swap_shed').length).toBe(1);
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
    setManagedControllableDevices({ 'dev-high': true, 'dev-low': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Set up conditions for swap
    (app as any).computeDynamicSoftLimit = () => 4.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4.5);
    }
    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;
    (app as any).planEngine.state.lastDeviceShedMs = {};
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.sheddingActive = false;
    }

    const errorSpy = vi.spyOn(Object.getPrototypeOf(app), 'error').mockImplementation(() => { });

    // Mock api.put to simulate timeout (shedding fails)
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put').mockRejectedValue(new Error('Timeout after 10000ms'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Capture structured log events from the plan engine
    const structuredEvents: Record<string, unknown>[] = [];
    (app as any).planEngine.builder.deps.debugStructured = (obj: Record<string, unknown>) => structuredEvents.push(obj);
    (app as any).planEngine.builder.deps.structuredLog = {
      info: (obj: Record<string, unknown>) => structuredEvents.push(obj),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => (app as any).planEngine.builder.deps.structuredLog,
    };

    try {
      // First power sample - should plan the swap
      await (app as any).recordPowerSample(3000);
      await flushPromises(); // Let async shedding attempt complete

      expect(structuredEvents.filter((e) => e['event'] === 'restore_swap_approved').length).toBe(1);

      // Clear events for second sample
      structuredEvents.length = 0;

      // Second power sample - should NOT re-plan the same swap
      // The swap is already pending (dev-high in pendingSwapTargets)
      await (app as any).recordPowerSample(3000);
      await flushPromises();

      // BUG: Without the fix, this would be 1 (re-planning the same swap)
      // With the fix, this should be 0 (swap already pending)
      expect(structuredEvents.filter((e) => e['event'] === 'restore_swap_approved').length).toBe(0);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      putSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('does not attempt another swap for the same target without a new measurement', async () => {
    const highPri = new MockDevice('dev-high', 'High Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await highPri.setCapabilityValue('measure_power', 1500);
    await highPri.setCapabilityValue('onoff', false);

    const lowPri = new MockDevice('dev-low', 'Low Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await lowPri.setCapabilityValue('measure_power', 1200);
    await lowPri.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [highPri, lowPri]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.2);
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-high': 1, 'dev-low': 10 } });
    setManagedControllableDevices({ 'dev-high': true, 'dev-low': true });
    mockHomeyInstance.settings.set('capacity_dry_run', true);

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 4.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4.5);
    }
    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;
    (app as any).planEngine.state.lastDeviceShedMs = {};
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.sheddingActive = false;
    }

    await (app as any).recordPowerSample(3000, 1000);

    let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-low')?.plannedState).toBe('shed');

    // Simulate swap state being cleared without a new measurement.
    // Keep lastPlanMeasurementTs to block re-planning on the same measurement.
    const swapByDevice = (app as any).planEngine.state.swapByDevice;
    for (const key of Object.keys(swapByDevice)) {
      const entry = swapByDevice[key];
      delete entry.swappedOutFor;
      delete entry.pendingTarget;
      delete entry.timestamp;
      if (entry.lastPlanMeasurementTs === undefined) {
        delete swapByDevice[key];
      }
    }

    await (app as any).planService.rebuildPlanFromCache();
    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-low')?.plannedState).toBe('keep');
  });

  it('allows swaps again after a new measurement arrives', async () => {
    const highPri = new MockDevice('dev-high', 'High Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await highPri.setCapabilityValue('measure_power', 1500);
    await highPri.setCapabilityValue('onoff', false);

    const lowPri = new MockDevice('dev-low', 'Low Priority Heater', ['target_temperature', 'onoff', 'measure_power']);
    await lowPri.setCapabilityValue('measure_power', 1200);
    await lowPri.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [highPri, lowPri]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.2);
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-high': 1, 'dev-low': 10 } });
    setManagedControllableDevices({ 'dev-high': true, 'dev-low': true });
    mockHomeyInstance.settings.set('capacity_dry_run', true);

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 4.8;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 4.8);
    }
    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;
    (app as any).planEngine.state.lastDeviceShedMs = {};
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.sheddingActive = false;
    }

    await (app as any).recordPowerSample(3000, 1000);

    // Clear swap state without a new measurement.
    (app as any).planEngine.state.swapByDevice = {};

    (app as any).planEngine.state.lastRestoreMs = Date.now() - 120000;
    await (app as any).recordPowerSample(3000, 2000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-low')?.plannedState).toBe('shed');
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
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('defaults to dry run mode when capacity_dry_run setting is not configured', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    setManagedControllableDevices({ 'dev-1': true });
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
    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', undefined);

    const app = createApp();
    await app.onInit();

    // Verify the app is in dry run mode (undefined should not override default true)
    expect((app as any).capacityDryRun).toBe(true);
  });


  it('does not apply plan actions in dry run mode', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    setManagedControllableDevices({ 'dev-1': true });
    // Default dry run mode

    const app = createApp();
    await app.onInit();

    // Spy on applyPlanActions
    const applyPlanSpy = vi.spyOn(app as any, 'applyPlanActions');

    // Rebuild plan with shedding needed
    (app as any).deviceManager.setSnapshotForTests([
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
    setManagedControllableDevices({ 'dev-1': true });
    // Default dry run mode

    const app = createApp();
    await app.onInit();

    // Capture log calls
    const logCalls: string[] = [];
    vi.spyOn(app as any, 'log').mockImplementation((...args: unknown[]) => {
      logCalls.push(String(args[0]));
    });

    // Setup snapshot with a device that will be shed
    (app as any).deviceManager.setSnapshotForTests([
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
    setManagedControllableDevices({ 'dev-1': true });
    // Start in dry run mode (default)

    const app = createApp();
    await app.onInit();

    expect((app as any).capacityDryRun).toBe(true);

    // Change setting to disable dry run
    mockHomeyInstance.settings.set('capacity_dry_run', false);
    await flushPromises();

    // Verify the app picked up the change
    expect((app as any).capacityDryRun).toBe(false);

    // Change back to dry run
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    await flushPromises();
    expect((app as any).capacityDryRun).toBe(true);
  });

  it('does not shed devices via applySheddingToDevice in dry run mode', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    setManagedControllableDevices({ 'dev-1': true });
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

  it('builds plan targets for mode changes in dry run mode', async () => {
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
    setManagedControllableDevices({ 'dev-1': true });

    const app = createApp();
    await app.onInit();

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan?.plannedTarget).toBe(22);
    expect(await dev1.getCapabilityValue('target_temperature')).toBe(20);
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
    mockHomeyInstance.settings.set('price_optimization_enabled', true);
    // Make current hour cheap
    const now = new Date();
    now.setHours(3, 30, 0, 0);
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const hourlyTotals: Array<{ startsAt: string; total: number }> = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      const total = hour === 3 ? 20 : 50; // Hour 3 is cheap
      hourlyTotals.push({ startsAt: date.toISOString(), total });
    }
    mockHomeyInstance.settings.set('combined_prices', {
      prices: hourlyTotals.map((p) => ({
        startsAt: p.startsAt,
        total: p.total,
      })),
    });
    // Do NOT set capacity_dry_run - default is true

    const app = createApp();
    await app.onInit();
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;

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
    mockHomeyInstance.settings.set('price_optimization_enabled', true);

    const app = createApp();
    await app.onInit();
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;

    // Verify dry run is enabled by default
    expect((app as any).capacityDryRun).toBe(true);

    // Mock the cheap/expensive detection to return cheap
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;

    // Ensure the device is in snapshot with correct structure
    (app as any).deviceManager.setSnapshotForTests([
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
    await (app as any).priceCoordinator.applyPriceOptimization();

    // Temperature should NOT have been changed in dry run mode
    // (would be 65 if price optimization was applied: 55 + 10)
    expect(await dev1.getCapabilityValue('target_temperature')).toBe(55);
  });

  it('price optimization uses current operating mode targets in plan', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 40);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    setManagedControllableDevices({ 'dev-1': true });
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'dev-1': 55 },
      Away: { 'dev-1': 45 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Away');
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'dev-1': {
        enabled: true,
        cheapDelta: 5,
        expensiveDelta: -5,
      },
    });
    mockHomeyInstance.settings.set('price_optimization_enabled', true);

    const now = new Date();
    now.setMinutes(0, 0, 0);
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
    mockHomeyInstance.settings.set('electricity_prices', [
      { startsAt: now.toISOString(), total: 10, currency: 'NOK' },
      { startsAt: nextHour.toISOString(), total: 100, currency: 'NOK' },
    ]);
    mockHomeyInstance.settings.set('nettleie_data', []);

    const app = createApp();
    await app.onInit();
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;
    (app as any).computeDynamicSoftLimit = () => 3;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3);
    }
    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;
    (app as any).planEngine.state.lastDeviceShedMs = {};
    (app as any).planEngine.state.lastPlannedShedIds = new Set();

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [{ id: 'target_temperature', value: 40, unit: '°C' }],
        powerKw: 1,
        currentOn: true,
        controllable: true,
      },
    ]);
    await (app as any).planService.rebuildPlanFromCache();

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan.plannedTarget).toBe(50);
  });

  it('applies price optimization when capacity control is disabled', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 50);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': false });
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'dev-1': 50 },
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'dev-1': {
        enabled: true,
        cheapDelta: 5,
        expensiveDelta: -5,
      },
    });
    mockHomeyInstance.settings.set('price_optimization_enabled', true);
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [{ id: 'target_temperature', value: 50, unit: '°C' }],
        powerKw: 1,
        currentOn: true,
      },
    ]);

    await (app as any).planService.rebuildPlanFromCache();

    expect(await dev1.getCapabilityValue('target_temperature')).toBe(55);
  });

  it('price optimization is overridden by temperature-based shedding', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    await dev1.setCapabilityValue('target_temperature', 55);
    await dev1.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    setManagedControllableDevices({ 'dev-1': true });
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
    mockHomeyInstance.settings.set('price_optimization_enabled', true);
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'dev-1': { action: 'set_temperature', temperature: 12 },
    });
    mockHomeyInstance.settings.set('capacity_limit_kw', 2);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const now = new Date();
    now.setMinutes(0, 0, 0);
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
    mockHomeyInstance.settings.set('electricity_prices', [
      { startsAt: now.toISOString(), total: 10, currency: 'NOK' },
      { startsAt: nextHour.toISOString(), total: 100, currency: 'NOK' },
    ]);
    mockHomeyInstance.settings.set('nettleie_data', []);

    const app = createApp();
    await app.onInit();
    (app as any).isCurrentHourCheap = () => true;
    (app as any).isCurrentHourExpensive = () => false;

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [{ id: 'target_temperature', value: 55, unit: '°C' }],
        powerKw: 2,
        currentOn: true,
        controllable: true,
      },
    ]);

    await (app as any).planService.rebuildPlanFromCache();
    const preShedPlan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const preShedDevice = preShedPlan.devices.find((d: any) => d.id === 'dev-1');
    expect(preShedDevice.plannedTarget).toBe(65);

    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    await (app as any).recordPowerSample(4000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const devPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(devPlan.plannedState).toBe('shed');
    expect(devPlan.shedAction).toBe('set_temperature');
    expect(devPlan.plannedTarget).toBe(12);
  });

  it('marks off devices as shed during shortfall and avoids restore actions', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 1500); // 1.5 kW
    await dev1.setCapabilityValue('onoff', false); // Currently OFF

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 10);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.3);
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1 } });
    setManagedControllableDevices({ 'dev-1': true });

    const app = createApp();
    await app.onInit();

    // Set a generous soft limit with plenty of headroom.
    (app as any).computeDynamicSoftLimit = () => 8;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 8);
    }

    // Simulate being in shortfall state.
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.isInShortfall = () => true;
    }
    (app as any).planEngine.state.inShortfall = true;

    // Report low power - plenty of headroom mathematically, but we're in shortfall.
    await (app as any).recordPowerSample(2000); // 2 kW, headroom = 6 kW

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan).toBeTruthy();
    expect(dev1Plan.currentState).toBe('off');
    expect(dev1Plan.plannedState).toBe('shed');
    expect(dev1Plan.reason).toContain('shortfall');

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    await (app as any).applyPlanActions(plan);

    expect(putSpy).not.toHaveBeenCalled();
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
    setManagedControllableDevices({ 'dev-1': true });

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
    (app as any).planEngine.state.inShortfall = false;
    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;

    // Report 4.3 kW power - gives 2.2 kW headroom (6.5 - 4.3 = 2.2)
    await (app as any).recordPowerSample(4300);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan).toBeTruthy();
    expect(dev1Plan.currentState).toBe('off');
    expect(dev1Plan.reason).toBe('keep');

    // Now try to apply the plan
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    await (app as any).applyPlanActions(plan);

    // The device should be restored because:
    // - Headroom: 2.2 kW
    // - Device needs: 1.3 kW (+ buffers ~1.6 kW)
    // - 2.2 > 1.6, so there's enough headroom
    // But the 50% budget (1.1 kW) blocks it because 1.3 > 1.1
    const restoreCall = putSpy.mock.calls.find(
      (call: any) => call[0] === 'manager/devices/device/dev-1/capability/onoff' && call[1]?.value === true,
    );

    // This SHOULD pass but will FAIL due to the 50% budget bug
    expect(restoreCall).toBeDefined();
  });

  it('restores when headroom meets minimum hysteresis with small margin', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 1000); // 1.0 kW
    await dev1.setCapabilityValue('onoff', false); // Currently OFF

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_limit_kw', 3);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.05); // small margin -> restoreMargin = 0.1, hysteresis = 0.2
    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1 } });
    setManagedControllableDevices({ 'dev-1': true });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 2.8;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 2.8);
    }

    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    await (app as any).recordPowerSample(1000); // 1.0 kW total -> headroomRaw 1.8 kW (meets floor)

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan?.plannedState).toBe('keep');

    expect(putSpy).toHaveBeenCalledWith(
      'manager/devices/device/dev-1/capability/onoff',
      { value: true },
    );
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
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    setManagedControllableDevices({ 'dev-1': true, 'dev-2': true });
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

    // Identify the shed device (could be dev-1 or dev-2 depending on ordering).
    const plan1 = mockHomeyInstance.settings.get('device_plan_snapshot');
    const shedDevice = plan1.devices.find((d: any) => d.plannedState === 'shed');
    expect(shedDevice).toBeTruthy();
    // Manually update the shed device to reflect it reached 15C.
    if (shedDevice.id === 'dev-1') {
      await dev1.setCapabilityValue('target_temperature', 15);
    } else {
      await dev2.setCapabilityValue('target_temperature', 15);
    }
    // Refresh snapshot so the plan sees the new shed temperature.
    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [{ id: 'target_temperature', value: shedDevice.id === 'dev-1' ? 15 : 20, unit: '°C' }],
        powerKw: 1,
        currentOn: true,
        controllable: true,
      },
      {
        id: 'dev-2',
        name: 'Heater B',
        targets: [{ id: 'target_temperature', value: shedDevice.id === 'dev-2' ? 15 : 20, unit: '°C' }],
        powerKw: 1,
        currentOn: true,
        controllable: true,
      },
    ]);

    // 3. Trigger another overshoot.
    // Total power still 2kW (heater might still run at lower temp).
    // Limit drops to 0.5kW. Need to shed another 1.5kW.
    (app as any).computeDynamicSoftLimit = () => 0.5;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.5);
    }

    // Ensure we don't skip shedding due to same-measurement throttling.
    (app as any).planEngine.state.lastShedPlanMeasurementTs = null;

    await (app as any).recordPowerSample(2000);

    // Expectations:
    // dev-1 is already at shed temp (15C). It should NOT be shed again.
    // dev-2 is at normal temp (20C). It SHOULD be shed.
    const plan2 = mockHomeyInstance.settings.get('device_plan_snapshot');
    const dev1Plan = plan2.devices.find((d: any) => d.id === 'dev-1');
    const dev2Plan = plan2.devices.find((d: any) => d.id === 'dev-2');
    expect(dev1Plan.plannedState).toBe('shed');
    expect(dev2Plan.plannedState).toBe('shed');
    expect(dev1Plan.plannedTarget).toBe(15);
    expect(dev2Plan.plannedTarget).toBe(15);
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
    setManagedControllableDevices({ 'dev-1': true });

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

    const logSpy = vi.spyOn((app as any), 'log');

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
    vi.useFakeTimers();
    try {
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
      setManagedControllableDevices({ 'dev-1': true, 'dev-2': true });

      // Configure shed behavior to set_temperature
      mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 20, 'dev-2': 20 } });
      mockHomeyInstance.settings.set('overshoot_behaviors', {
        'dev-1': { action: 'set_temperature', temperature: 10 },
        'dev-2': { action: 'set_temperature', temperature: 10 },
      });
      mockHomeyInstance.settings.set('capacity_dry_run', false);

      vi.setSystemTime(new Date('2023-01-01T12:00:00Z'));

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
      vi.advanceTimersByTime(10 * 60 * 1000);
      vi.setSystemTime(new Date('2023-01-01T12:10:00Z'));

      // Explicitly clear cooldowns to avoid test flakiness with Date mocking
      (app as any).planEngine.state.lastInstabilityMs = 0;
      (app as any).planEngine.state.lastRecoveryMs = 0;
      (app as any).planEngine.state.lastDeviceShedMs = {};
      // Deactivate the guard so the next cycle doesn't trigger a fresh recovery transition.
      await (app as any).capacityGuard?.setSheddingActive(false);

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
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not attempt onoff restore when power state is unknown and onoff is not setable', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    (app as any).deviceManager.setSnapshotForTests([{
      id: 'dev-1',
      name: 'Read-only relay',
      targets: [],
      capabilities: ['onoff'],
      canSetOnOff: false,
      currentOn: true,
      controllable: true,
    }]);

    const plan = {
      devices: [
        {
          id: 'dev-1',
          name: 'Read-only relay',
          plannedState: 'keep',
          currentState: 'off',
          plannedTarget: null,
          currentTarget: null,
          controllable: true,
          powerKw: 0.2,
        },
      ],
    };

    await (app as any).applyPlanActions(plan);

    expect(putSpy).not.toHaveBeenCalled();
  });

  it('skips target updates for unavailable devices and continues with available devices', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    (app as any).deviceManager.setSnapshotForTests([{
      id: 'dev-unavailable',
      name: 'Unavailable Heater',
      targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
      capabilities: ['target_temperature', 'onoff'],
      currentOn: true,
      controllable: true,
      available: false,
    }, {
      id: 'dev-available',
      name: 'Available Heater',
      targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
      capabilities: ['target_temperature', 'onoff'],
      currentOn: true,
      controllable: true,
      available: true,
    }] as any);

    const plan = {
      devices: [
        {
          id: 'dev-unavailable',
          name: 'Unavailable Heater',
          plannedState: 'keep',
          currentState: 'keep',
          plannedTarget: 20,
          currentTarget: 18,
          controllable: true,
        },
        {
          id: 'dev-available',
          name: 'Available Heater',
          plannedState: 'keep',
          currentState: 'keep',
          plannedTarget: 20,
          currentTarget: 18,
          controllable: true,
        },
      ],
    };

    await (app as any).applyPlanActions(plan);

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith(
      'manager/devices/device/dev-available/capability/target_temperature',
      { value: 20 },
    );
  });

  it('skips shed-temperature actions for unavailable devices and continues with available devices', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    (app as any).deviceManager.setSnapshotForTests([{
      id: 'dev-unavailable',
      name: 'Unavailable Heater',
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      capabilities: ['target_temperature', 'onoff'],
      currentOn: true,
      controllable: true,
      available: false,
    }, {
      id: 'dev-available',
      name: 'Available Heater',
      targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      capabilities: ['target_temperature', 'onoff'],
      currentOn: true,
      controllable: true,
      available: true,
    }] as any);

    const plan = {
      devices: [
        {
          id: 'dev-unavailable',
          name: 'Unavailable Heater',
          plannedState: 'shed',
          currentState: 'keep',
          plannedTarget: 12,
          currentTarget: 20,
          shedAction: 'set_temperature',
          controllable: true,
        },
        {
          id: 'dev-available',
          name: 'Available Heater',
          plannedState: 'shed',
          currentState: 'keep',
          plannedTarget: 12,
          currentTarget: 20,
          shedAction: 'set_temperature',
          controllable: true,
        },
      ],
    };

    await (app as any).applyPlanActions(plan);

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith(
      'manager/devices/device/dev-available/capability/target_temperature',
      { value: 12 },
    );
  });

  it('continues applying actions after a shed callback throws a 500 error', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    (app as any).deviceManager.setSnapshotForTests([{
      id: 'dev-1',
      name: 'Failing device',
      targets: [],
      capabilities: ['onoff'],
      currentOn: true,
      controllable: true,
      available: true,
    }, {
      id: 'dev-2',
      name: 'Healthy device',
      targets: [],
      capabilities: ['onoff'],
      currentOn: true,
      controllable: true,
      available: true,
    }] as any);

    const callback = vi.fn().mockImplementation(async (deviceId: string) => {
      if (deviceId === 'dev-1') {
        const err = new Error('This device is currently unavailable.') as Error & { statusCode?: number };
        err.statusCode = 500;
        throw err;
      }
      return undefined;
    });

    vi.spyOn((app as any).planEngine.executor, 'applySheddingToDevice').mockImplementation(callback);

    const plan = {
      devices: [
        {
          id: 'dev-1',
          name: 'Failing device',
          plannedState: 'shed',
          currentState: 'keep',
          plannedTarget: null,
          currentTarget: null,
          shedAction: 'turn_off',
          controllable: true,
        },
        {
          id: 'dev-2',
          name: 'Healthy device',
          plannedState: 'shed',
          currentState: 'keep',
          plannedTarget: null,
          currentTarget: null,
          shedAction: 'turn_off',
          controllable: true,
        },
      ],
    };

    await expect((app as any).applyPlanActions(plan)).resolves.toEqual({ deviceWriteCount: 0 });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, 'dev-1', 'Failing device', undefined);
    expect(callback).toHaveBeenNthCalledWith(2, 'dev-2', 'Healthy device', undefined);
  });

  it('restores a higher-priority onoff device by swapping out a lower-priority set-temperature device', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('capacity_priorities', {
      Home: {
        spotter: 10,
        'low-temp': 50,
      },
    });
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: {
        'low-temp': 20,
      },
    });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      spotter: { action: 'turn_off' },
      'low-temp': { action: 'set_temperature', temperature: 16 },
    });
    setManagedControllableDevices({
      spotter: true,
      'low-temp': true,
    });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 0.7; // 0.7kW limit
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.7);
    }

    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'spotter',
        name: 'Spotter kjøkkenbenk',
        targets: [],
        capabilities: ['onoff'],
        currentOn: false, // currently shed/off
        controllable: true,
        powerKw: 0.05,
        expectedPowerKw: 0.05,
      },
      {
        id: 'low-temp',
        name: 'Lower-priority thermostat',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        capabilities: ['target_temperature', 'onoff'],
        currentOn: true,
        controllable: true,
        powerKw: 0.6,
        expectedPowerKw: 0.6,
      },
    ]);

    // Headroom = 0.7 - 0.2 = 0.5kW. Direct restore still requires swapping out the lower-priority
    // thermostat (spotter needs ~0.25kW but the combined reserve+floor of 0.50kW makes direct fail).
    await (app as any).recordPowerSample(200);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const spotterPlan = plan.devices.find((d: any) => d.id === 'spotter');
    const lowTempPlan = plan.devices.find((d: any) => d.id === 'low-temp');

    expect(spotterPlan?.plannedState).toBe('keep');
    expect(lowTempPlan?.plannedState).toBe('shed');
    expect(lowTempPlan?.reason).toContain('swapped out for');
  });

  it('restores a higher-priority onoff device by swapping out a lower-priority temperature-only active device', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('capacity_priorities', {
      Home: {
        spotter: 10,
        'low-temp-no-onoff': 50,
      },
    });
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: {
        'low-temp-no-onoff': 20,
      },
    });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      spotter: { action: 'turn_off' },
      'low-temp-no-onoff': { action: 'set_temperature', temperature: 16 },
    });
    setManagedControllableDevices({
      spotter: true,
      'low-temp-no-onoff': true,
    });

    const app = createApp();
    await app.onInit();

    (app as any).computeDynamicSoftLimit = () => 0.7;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 0.7);
    }

    (app as any).planEngine.state.lastInstabilityMs = null;
    (app as any).planEngine.state.lastRestoreMs = null;

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'spotter',
        name: 'Spotter kjøkkenbenk',
        targets: [],
        capabilities: ['onoff'],
        currentOn: false,
        controllable: true,
        powerKw: 0.05,
        expectedPowerKw: 0.05,
      },
      {
        id: 'low-temp-no-onoff',
        name: 'Lower-priority thermostat without onoff',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        capabilities: ['target_temperature'],
        currentOn: true,
        controllable: true,
        powerKw: 0.6,
        expectedPowerKw: 0.6,
      },
    ]);

    await (app as any).recordPowerSample(200);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const spotterPlan = plan.devices.find((d: any) => d.id === 'spotter');
    const lowTempPlan = plan.devices.find((d: any) => d.id === 'low-temp-no-onoff');

    expect(spotterPlan?.plannedState).toBe('keep');
    expect(lowTempPlan?.plannedState).toBe('shed');
    expect(lowTempPlan?.reason).toContain('swapped out for');
  });
});
