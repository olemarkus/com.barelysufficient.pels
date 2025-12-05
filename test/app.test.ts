import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate', 'Date'] });

describe('MyApp initialization', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
  });

  it('initializes and creates device snapshot', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);

    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await app.onInit();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot');
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot[0]).toMatchObject({
      name: 'Heater',
    });
  });

  it('set_capacity_mode flow card changes mode and persists to settings', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await app.onInit();

    // Get the registered listener for set_capacity_mode
    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    expect(setModeListener).toBeDefined();

    // Call the flow card with a new mode
    const result = await setModeListener({ mode: 'Away' });
    expect(result).toBe(true);

    // Verify mode was persisted to settings
    expect(mockHomeyInstance.settings.get('capacity_mode')).toBe('Away');

    // Verify internal state was updated
    expect((app as any).capacityMode).toBe('Away');
  });

  it('set_capacity_mode flow card throws if mode is empty', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await app.onInit();

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];

    await expect(setModeListener({ mode: '' })).rejects.toThrow('Mode must be provided');
    await expect(setModeListener({ mode: '   ' })).rejects.toThrow('Mode must be provided');
  });

  it('set_capacity_mode flow card handles autocomplete object format', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await app.onInit();

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];

    // Autocomplete returns an object with id and name, not a plain string
    const result = await setModeListener({ mode: { id: 'Away', name: 'Away' } });
    expect(result).toBe(true);

    expect(mockHomeyInstance.settings.get('capacity_mode')).toBe('Away');
    expect((app as any).capacityMode).toBe('Away');
  });

  it('set_capacity_mode applies device targets when not in dry run', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set up mode targets before init
    mockHomeyInstance.settings.set('mode_device_targets', { Away: { 'dev-1': 16 } });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = createApp();
    await app.onInit();

    // Inject mock homeyApi
    const setCapSpy = jest.fn().mockResolvedValue(undefined);
    (app as any).homeyApi = {
      devices: {
        getDevices: async () => ({
          'dev-1': {
            id: 'dev-1',
            name: 'Heater',
            capabilities: ['target_temperature', 'onoff'],
            capabilitiesObj: { target_temperature: { value: 20 }, onoff: { value: true } },
            settings: {},
          },
        }),
        setCapabilityValue: setCapSpy,
      },
    };

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    await setModeListener({ mode: 'Away' });

    // Verify setCapabilityValue was called to apply the target
    expect(setCapSpy).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      value: 16,
    });
  });
});

describe('computeDynamicSoftLimit', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    jest.clearAllTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  it('caps soft limit to sustainable rate in last 10 minutes even when burst rate is higher', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set capacity limit to 5 kW with 0 margin -> sustainable rate = 5 kW
    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const app = createApp();
    await app.onInit();

    // Simulate end of hour scenario (last 10 minutes) where burst rate would be very high:
    // If 5 minutes left in hour and only 0.5 kWh used, remaining = 4.5 kWh
    // burstRate = 4.5 / (5/60) = 54 kW (way over sustainable!)
    // But with capping in last 10 minutes, it should never exceed 5 kW (sustainable rate)

    // Mock Date.now to be at :55 (5 minutes left - within last 10 minutes)
    const now = new Date();
    now.setMinutes(55, 0, 0);
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());

    // Mock the power tracker to simulate some usage
    (app as any).powerTracker = {
      buckets: { [hourStart.toISOString()]: 0.5 },
    };

    // Call computeDynamicSoftLimit
    const softLimit = (app as any).computeDynamicSoftLimit();

    // With 5 kWh budget, 0.5 used, 4.5 remaining, 5 minutes left:
    // - burstRate = 54 kW (very high)
    // - but in last 10 minutes, it should be capped to sustainableRate = 5 kW
    expect(softLimit).toBeLessThanOrEqual(5);
    expect(softLimit).toBeGreaterThan(0);

    jest.restoreAllMocks();
  });

  it('allows lower soft limit when budget is exhausted', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set capacity limit to 5 kW with 0 margin -> sustainable rate = 5 kW
    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const app = createApp();
    await app.onInit();

    // Mock the power tracker
    (app as any).powerTracker = {
      buckets: {},
    };

    // Set the bucket to have 4.9 kWh used (almost exhausted budget)
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const bucketKey = now.toISOString();
    (app as any).powerTracker.buckets[bucketKey] = 4.9;

    const softLimit = (app as any).computeDynamicSoftLimit();

    // With 5 kWh budget, 4.9 used, only 0.1 kWh remaining
    // The burst rate will be low (0.1 / remaining hours)
    // The cap (5 kW) doesn't apply because burst rate is already lower
    expect(softLimit).toBeLessThan(5);
    expect(softLimit).toBeGreaterThanOrEqual(0);
  });

  it('returns sustainable rate at start of hour with full budget', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set capacity limit to 5 kW with 0 margin -> sustainable rate = 5 kW
    mockHomeyInstance.settings.set('capacity_limit_kw', 5);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0);

    const app = createApp();
    await app.onInit();

    // Mock Date.now to be at :00 (start of hour)
    const now = new Date();
    now.setMinutes(0, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());

    // Mock the power tracker with empty bucket (start of hour)
    (app as any).powerTracker = {
      buckets: {},
    };

    const softLimit = (app as any).computeDynamicSoftLimit();

    // At start of hour with full budget:
    // burstRate = 5 kWh / 1 hour = 5 kW
    // sustainableRate = 5 kW
    // Not in last 10 minutes, so no cap - but burst = sustainable = 5 kW
    expect(softLimit).toBe(5);

    jest.restoreAllMocks();
  });

  it('allows burst rate above sustainable rate mid-hour when under budget', async () => {
    // Test: Halfway through the hour, if we've used less than expected,
    // the burst rate should be allowed to exceed sustainable rate.
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set capacity limit to 7 kW with 0.3 margin -> sustainable rate = 6.7 kW
    mockHomeyInstance.settings.set('capacity_limit_kw', 7);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.3);

    const app = createApp();
    await app.onInit();

    // Mock Date.now to be at :30 (halfway through the hour)
    const now = new Date();
    now.setMinutes(30, 0, 0);
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());

    // Mock the power tracker - only used 1.5 kWh (should have used ~3.35 kWh by now)
    (app as any).powerTracker = {
      buckets: { [hourStart.toISOString()]: 1.5 },
    };

    const softLimit = (app as any).computeDynamicSoftLimit();

    // With 6.7 kWh budget, 1.5 used, 5.2 remaining, 0.5 hours left:
    // burstRate = 5.2 / 0.5 = 10.4 kW
    // sustainableRate = 6.7 kW
    // Mid-hour should allow burst rate (10.4 kW), not cap to sustainable (6.7 kW)
    expect(softLimit).toBeGreaterThan(6.7);

    jest.restoreAllMocks();
  });

  it('caps to sustainable rate in the last 10 minutes of the hour', async () => {
    // Test: At :52 (8 minutes left), the rate cap should kick in
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set capacity limit to 7 kW with 0.3 margin -> sustainable rate = 6.7 kW
    mockHomeyInstance.settings.set('capacity_limit_kw', 7);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.3);

    const app = createApp();
    await app.onInit();

    // Mock Date.now to be at :52 (8 minutes left)
    const now = new Date();
    now.setMinutes(52, 0, 0);
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());

    // Mock the power tracker - only used 3 kWh (under budget)
    (app as any).powerTracker = {
      buckets: { [hourStart.toISOString()]: 3 },
    };

    const softLimit = (app as any).computeDynamicSoftLimit();

    // With 6.7 kWh budget, 3 used, 3.7 remaining, ~0.133 hours (8 min) left:
    // burstRate = 3.7 / 0.133 = ~27.8 kW (way over sustainable!)
    // In last 10 minutes, should cap to sustainable rate = 6.7 kW
    expect(softLimit).toBeLessThanOrEqual(6.7);

    jest.restoreAllMocks();
  });

  it('caps to sustainable rate at :59 to prevent next-hour overshoot', async () => {
    // Test: At :59 (1 minute left), should definitely cap to sustainable rate
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set capacity limit to 7 kW with 0.3 margin -> sustainable rate = 6.7 kW
    mockHomeyInstance.settings.set('capacity_limit_kw', 7);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.3);

    const app = createApp();
    await app.onInit();

    // Mock Date.now to be at :59 (1 minute left)
    const now = new Date();
    now.setMinutes(59, 0, 0);
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());

    // Mock the power tracker - only used 2 kWh (lots of remaining budget)
    (app as any).powerTracker = {
      buckets: { [hourStart.toISOString()]: 2 },
    };

    const softLimit = (app as any).computeDynamicSoftLimit();

    // With 6.7 kWh budget, 2 used, 4.7 remaining, ~0.017 hours (1 min) left:
    // burstRate = 4.7 / 0.017 = ~280 kW (extreme!)
    // At :59, must cap to sustainable rate = 6.7 kW to avoid next-hour overshoot
    expect(softLimit).toBeLessThanOrEqual(6.7);

    jest.restoreAllMocks();
  });

  it('sets pels_status even with no devices so stale data banner shows', async () => {
    // No devices configured
    setMockDrivers({});

    const app = createApp();
    await app.onInit();

    // pels_status should be set even with no devices
    const status = mockHomeyInstance.settings.get('pels_status');
    expect(status).toBeDefined();
    expect(status).toHaveProperty('lastPowerUpdate');
    // No power data received yet, so lastPowerUpdate should be null
    expect(status.lastPowerUpdate).toBeNull();
  });

  it('builds device plan in dry-run mode without actuating', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('target_temperature', 20);

    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Enable dry-run mode
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    // Set up priorities so the device is in the plan
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1 } });

    const app = createApp();
    await app.onInit();

    // Plan should be built
    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan).toBeDefined();
    expect(plan.devices).toBeDefined();
    expect(plan.devices.length).toBeGreaterThan(0);

    // pels_status should be set
    const status = mockHomeyInstance.settings.get('pels_status');
    expect(status).toBeDefined();
    expect(status).toHaveProperty('headroomKw');
  });
});
