import {
  clearMockHomeyApiDeviceListeners,
  emitMockHomeyApiDeviceUpdate,
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DEVICE_CONTROL_PROFILES,
  OPERATING_MODE_SETTING,
} from '../lib/utils/settingsKeys';
import {
  SHED_COOLDOWN_MS,
  TARGET_COMMAND_RETRY_DELAYS_MS,
  TARGET_CONFIRMATION_STUCK_POLL_MS,
} from '../lib/plan/planConstants';
import { MAX_DAILY_BUDGET_KWH, MIN_DAILY_BUDGET_KWH } from '../lib/dailyBudget/dailyBudgetConstants';
import { getHourBucketKey } from '../lib/utils/dateUtils';

const flushPromises = () => new Promise<void>((resolve) => {
  if (typeof setImmediate === 'function') {
    setImmediate(() => resolve());
    return;
  }
  setTimeout(() => resolve(), 0);
});
const REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS = 350;

const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await flushPromises();
  }
};

const waitForSnapshot = async (timeoutMs = 1000) => {
  await waitFor(() => Array.isArray(mockHomeyInstance.settings.get('target_devices_snapshot')), timeoutMs);
};

const buildSteppedLoadProfiles = (deviceId: string) => ({
  [deviceId]: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'max', planningPowerW: 3000 },
    ],
  },
});

const getPlanDeviceState = (plan: any, deviceId: string): string | undefined => {
  if (!plan || !Array.isArray(plan.devices)) return undefined;
  for (const device of plan.devices) {
    if (device?.id === deviceId) return device.plannedState;
  }
  return undefined;
};

const initApp = async (app: any) => {
  const appInstance = app as any;
  appInstance.updateDebugLoggingEnabled();
  appInstance.initPriceCoordinator();
  appInstance.migrateManagedDevices();
  appInstance.loadCapacitySettings();
  appInstance.initDailyBudgetService();
  appInstance.loadPowerTracker();
  appInstance.loadPriceOptimizationSettings();
  await appInstance.initDeviceManager();
  appInstance.initCapacityGuard();
  appInstance.initPlanEngine();
  appInstance.initPlanService();
  appInstance.initCapacityGuardProviders();
  appInstance.initSettingsHandler();
  appInstance.registerFlowCards();
  await appInstance.refreshTargetDevicesSnapshot();
  await appInstance.planService?.rebuildPlanFromCache?.();
  appInstance.lastNotifiedOperatingMode = appInstance.operatingMode;
};

describe('MyApp initialization', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate', 'Date'] });
    clearMockHomeyApiDeviceListeners();
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set('price_scheme', 'flow');
    mockHomeyInstance.api.clearRealtimeEvents();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
    jest.restoreAllMocks();
  });

  it('initializes and creates device snapshot', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);

    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot');
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot[0]).toMatchObject({
      name: 'Heater',
    });
  });

  it('does not rewrite target snapshot when refresh returns unchanged devices', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const setSpy = jest.spyOn(mockHomeyInstance.settings, 'set');
    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshotWrites = setSpy.mock.calls.filter(([key]) => key === 'target_devices_snapshot');
    expect(snapshotWrites).toHaveLength(1);
  });

  it('keeps devices disabled by default when no settings exist', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);

    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{
      id: string;
      managed?: boolean;
      controllable?: boolean;
    }>;
    const entry = snapshot.find((device) => device.id === 'dev-1');

    expect(entry?.managed).toBe(false);
    expect(entry?.controllable).toBe(false);
  });

  it('logs generic stepped-load feedback for the first reported step', async () => {
    const heater = new MockDevice('dev-1', 'Water heater', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(DEVICE_CONTROL_PROFILES, buildSteppedLoadProfiles('dev-1'));

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const logSpy = jest.spyOn(app, 'log');

    expect((app as any).reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    expect(logSpy).toHaveBeenCalledWith('Stepped load feedback: Water heater (dev-1) reported step low');
    expect(logSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('outside PELS'),
    )).toBe(false);
  });

  it('logs stepped-load confirmation when reported feedback matches a pending desired step', async () => {
    const heater = new MockDevice('dev-1', 'Water heater', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(DEVICE_CONTROL_PROFILES, buildSteppedLoadProfiles('dev-1'));

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const logSpy = jest.spyOn(app, 'log');

    (app as any).markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'low',
      previousStepId: 'max',
    });

    expect((app as any).reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    expect(logSpy).toHaveBeenCalledWith('Stepped load feedback: Water heater (dev-1) confirmed desired step low');
  });

  it('logs delayed stepped-load feedback as matching the desired step instead of outside PELS drift', async () => {
    const heater = new MockDevice('dev-1', 'Water heater', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(DEVICE_CONTROL_PROFILES, buildSteppedLoadProfiles('dev-1'));

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const logSpy = jest.spyOn(app, 'log');

    (app as any).markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
    });
    (app as any).deviceControlRuntimeState.steppedLoadDesiredByDeviceId['dev-1'] = {
      ...(app as any).deviceControlRuntimeState.steppedLoadDesiredByDeviceId['dev-1'],
      pending: false,
      status: 'stale',
    };
    (app as any).deviceControlRuntimeState.steppedLoadReportedByDeviceId['dev-1'] = {
      stepId: 'low',
      updatedAtMs: Date.now() - 1000,
    };

    expect((app as any).reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(logSpy).toHaveBeenCalledWith(
      'Stepped load feedback: Water heater (dev-1) reported desired step max after delayed feedback',
    );
    expect(logSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('outside PELS'),
    )).toBe(false);
  });

  it('logs stepped-load drift when the reported step changes outside PELS', async () => {
    const heater = new MockDevice('dev-1', 'Water heater', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(DEVICE_CONTROL_PROFILES, buildSteppedLoadProfiles('dev-1'));

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const logSpy = jest.spyOn(app, 'log');

    expect((app as any).reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    logSpy.mockClear();

    expect((app as any).reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(logSpy).toHaveBeenCalledWith('Stepped load feedback: Water heater (dev-1) changed step low -> max outside PELS');
  });

  it('set_capacity_mode flow card changes mode and persists to settings', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    // Get the registered listener for set_capacity_mode
    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    expect(setModeListener).toBeDefined();

    // Call the flow card with a new mode
    const result = await setModeListener({ mode: 'Away' });
    expect(result).toBe(true);

    // Verify mode was persisted to settings
    expect(mockHomeyInstance.settings.get(OPERATING_MODE_SETTING)).toBe('Away');

    // Verify internal state was updated
    expect((app as any).operatingMode).toBe('Away');
  });

  it('set_capacity_mode flow card throws if mode is empty', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];

    await expect(setModeListener({ mode: '' })).rejects.toThrow('Mode must be provided');
    await expect(setModeListener({ mode: '   ' })).rejects.toThrow('Mode must be provided');
  });

  it('set_capacity_limit flow card updates the guard limit', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);

    const capacityGuard = (app as any).capacityGuard;
    const setLimitSpy = jest.spyOn(capacityGuard, 'setLimit');

    const setLimitListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_limit'];
    expect(setLimitListener).toBeDefined();

    const result = await setLimitListener({ limit_kw: 5 });
    expect(result).toBe(true);
    expect(setLimitSpy).toHaveBeenCalledWith(5);
  });

  it('set_daily_budget_kwh flow card updates daily budget settings', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);

    const setBudgetListener = mockHomeyInstance.flow._actionCardListeners['set_daily_budget_kwh'];
    expect(setBudgetListener).toBeDefined();

    const result = await setBudgetListener({ budget_kwh: 40 });
    expect(result).toBe(true);
    expect(mockHomeyInstance.settings.get(DAILY_BUDGET_KWH)).toBe(40);
    expect(mockHomeyInstance.settings.get(DAILY_BUDGET_ENABLED)).toBe(true);
    expect((app as any).dailyBudgetService.getSnapshot()).not.toBeNull();
  });

  it('set_daily_budget_kwh flow card disables daily budget when set to 0', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(DAILY_BUDGET_KWH, 40);
    mockHomeyInstance.settings.set(DAILY_BUDGET_ENABLED, true);

    const app = createApp();
    await initApp(app);

    const setBudgetListener = mockHomeyInstance.flow._actionCardListeners['set_daily_budget_kwh'];
    const result = await setBudgetListener({ budget_kwh: 0 });
    expect(result).toBe(true);
    expect(mockHomeyInstance.settings.get(DAILY_BUDGET_KWH)).toBe(0);
    expect(mockHomeyInstance.settings.get(DAILY_BUDGET_ENABLED)).toBe(false);
  });

  it('set_daily_budget_kwh flow card skips rebuild when unchanged', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(DAILY_BUDGET_KWH, 40);
    mockHomeyInstance.settings.set(DAILY_BUDGET_ENABLED, true);

    const app = createApp();
    await initApp(app);

    const rebuildSpy = jest.spyOn((app as any).planService, 'rebuildPlanFromCache');
    const setBudgetListener = mockHomeyInstance.flow._actionCardListeners['set_daily_budget_kwh'];
    const result = await setBudgetListener({ budget_kwh: 40 });
    expect(result).toBe(true);
    expect(rebuildSpy).not.toHaveBeenCalled();
    rebuildSpy.mockRestore();
  });

  it('set_daily_budget_kwh flow card leaves reconciliation to the settings pipeline', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);

    const loadSettingsSpy = jest.spyOn((app as any).dailyBudgetService, 'loadSettings');
    const updateStateSpy = jest.spyOn((app as any).dailyBudgetService, 'updateState');
    const rebuildSpy = jest.spyOn((app as any).planService, 'rebuildPlanFromCache');
    loadSettingsSpy.mockClear();
    updateStateSpy.mockClear();
    rebuildSpy.mockClear();

    const setBudgetListener = mockHomeyInstance.flow._actionCardListeners['set_daily_budget_kwh'];
    const result = await setBudgetListener({ budget_kwh: 45 });

    expect(result).toBe(true);
    expect(loadSettingsSpy).not.toHaveBeenCalled();
    expect(updateStateSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();

    await app.onUninit?.();
    loadSettingsSpy.mockRestore();
    updateStateSpy.mockRestore();
    rebuildSpy.mockRestore();
  });

  it('set_daily_budget_kwh flow card rejects invalid values', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);

    const setBudgetListener = mockHomeyInstance.flow._actionCardListeners['set_daily_budget_kwh'];
    await expect(setBudgetListener({ budget_kwh: -1 })).rejects.toThrow('Daily budget must be non-negative (kWh).');
    await expect(setBudgetListener({ budget_kwh: 1 }))
      .rejects.toThrow(`Daily budget must be 0 (to disable) or between ${MIN_DAILY_BUDGET_KWH} and ${MAX_DAILY_BUDGET_KWH} kWh.`);
    await expect(setBudgetListener({ budget_kwh: MAX_DAILY_BUDGET_KWH + 1 }))
      .rejects.toThrow(`Daily budget must be 0 (to disable) or between ${MIN_DAILY_BUDGET_KWH} and ${MAX_DAILY_BUDGET_KWH} kWh.`);
  });

  it('enable_device_capacity_control flow card enables capacity control', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);

    const enableListener = mockHomeyInstance.flow._actionCardListeners['enable_device_capacity_control'];
    expect(enableListener).toBeDefined();

    const result = await enableListener({ device: 'dev-1' });
    expect(result).toBe(true);
    expect(mockHomeyInstance.settings.get('controllable_devices')).toEqual({ 'dev-1': true });
    expect(mockHomeyInstance.settings.get('managed_devices')).toBeUndefined();
  });

  it('disable_device_capacity_control flow card disables capacity control', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);

    const disableListener = mockHomeyInstance.flow._actionCardListeners['disable_device_capacity_control'];
    expect(disableListener).toBeDefined();

    const result = await disableListener({ device: { id: 'dev-1', name: 'Heater' } });
    expect(result).toBe(true);
    expect(mockHomeyInstance.settings.get('controllable_devices')).toEqual({ 'dev-1': false });
  });

  it('set_capacity_limit flow card rejects invalid values', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);

    const setLimitListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_limit'];
    await expect(setLimitListener({ limit_kw: -1 })).rejects.toThrow('Limit must be a positive number (kW).');
    await expect(setLimitListener({ limit_kw: 0 })).rejects.toThrow('Limit must be a positive number (kW).');
    await expect(setLimitListener({ limit_kw: NaN })).rejects.toThrow('Limit must be a positive number (kW).');
  });

  it('set_capacity_limit updates plan headroom immediately after a change', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff', 'measure_power']);
    await heater.setCapabilityValue('measure_power', 2000);
    await heater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.2);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, true);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);

    const now = Date.now();
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    const bucketKey = hourStart.toISOString();
    (app as any).powerTracker = {
      buckets: {
        [bucketKey]: 1.3,
      },
      lastTimestamp: now,
      lastPowerW: 2000,
    };

    void (app as any).recordPowerSample(2000, now);
    await waitFor(() => {
      const planSnapshot = mockHomeyInstance.settings.get('device_plan_snapshot');
      return Boolean(planSnapshot?.devices?.length);
    });
    let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    let devPlanState = getPlanDeviceState(plan, 'dev-1');
    expect(devPlanState).toBe('keep');

    const setLimitListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_limit'];
    void setLimitListener({ limit_kw: 1.5 });
    await waitFor(() => (
      getPlanDeviceState(mockHomeyInstance.settings.get('device_plan_snapshot'), 'dev-1') === 'shed'
    ));

    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    devPlanState = getPlanDeviceState(plan, 'dev-1');
    expect(devPlanState).toBe('shed');

    (app as any).planEngine.state.lastSheddingMs = null;
    (app as any).planEngine.state.lastOvershootMs = null;
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.sheddingActive = false;
    }

    void setLimitListener({ limit_kw: 4 });
    await waitFor(() => (
      getPlanDeviceState(mockHomeyInstance.settings.get('device_plan_snapshot'), 'dev-1') === 'keep'
    ));

    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    devPlanState = getPlanDeviceState(plan, 'dev-1');
    expect(devPlanState).toBe('keep');
  });

  it('emits power_updated when power samples arrive', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();
    mockHomeyInstance.api.clearRealtimeEvents();

    const now = new Date('2026-03-03T10:20:00.000Z').getTime();
    await (app as any).recordPowerSample(2000, now);

    const powerEvents = mockHomeyInstance.api._realtimeEvents.filter((event) => event.event === 'power_updated');
    expect(powerEvents).toHaveLength(1);
    expect(powerEvents[0].data).toMatchObject({
      tracker: expect.objectContaining({
        lastPowerW: 2000,
        lastTimestamp: now,
      }),
    });
  });

  it('reconciles the current plan after an external onoff drift without rebuilding', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('target_temperature', 20);
    await heater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);
    const reconcileSpy = jest.spyOn((app as any).planService, 'reconcileLatestPlanState');
    const rebuildSpy = jest.spyOn((app as any).planService, 'rebuildPlanFromCache');

    emitMockHomeyApiDeviceUpdate({
      id: 'dev-1',
      name: 'Heater',
      class: 'heater',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff'],
      capabilitiesObj: {
        target_temperature: { id: 'target_temperature', value: 20, units: '°C' },
        measure_temperature: { id: 'measure_temperature', value: 21, units: '°C' },
        measure_power: { id: 'measure_power', value: 0 },
        onoff: { id: 'onoff', value: false },
      },
    });

    await waitFor(() => reconcileSpy.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

    expect(rebuildSpy).not.toHaveBeenCalled();
    expect((app as any).latestTargetSnapshot.find((device: { id: string }) => device.id === 'dev-1')).toMatchObject({
      currentOn: false,
    });
  });

  it('reconciles the current plan after an external target drift without rebuilding', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('target_temperature', 20);
    await heater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 20 } });
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    const app = createApp();
    await initApp(app);
    const reconcileSpy = jest.spyOn((app as any).planService, 'reconcileLatestPlanState');
    const rebuildSpy = jest.spyOn((app as any).planService, 'rebuildPlanFromCache');

    emitMockHomeyApiDeviceUpdate({
      id: 'dev-1',
      name: 'Heater',
      class: 'heater',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff'],
      capabilitiesObj: {
        target_temperature: { id: 'target_temperature', value: 18, units: '°C' },
        measure_temperature: { id: 'measure_temperature', value: 21, units: '°C' },
        measure_power: { id: 'measure_power', value: 0 },
        onoff: { id: 'onoff', value: true },
      },
    });

    await waitFor(() => reconcileSpy.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

    expect(rebuildSpy).not.toHaveBeenCalled();
    expect((app as any).latestTargetSnapshot.find((device: { id: string }) => device.id === 'dev-1')).toMatchObject({
      targets: [expect.objectContaining({ id: 'target_temperature', value: 18 })],
    });
  });

  it('coalesces multiple realtime device drifts into a single plan reconcile', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('target_temperature', 20);
    await heater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);
    const reconcileSpy = jest.spyOn((app as any).planService, 'reconcileLatestPlanState');

    emitMockHomeyApiDeviceUpdate({
      id: 'dev-1',
      name: 'Heater',
      class: 'heater',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff'],
      capabilitiesObj: {
        target_temperature: { id: 'target_temperature', value: 20, units: '°C' },
        measure_temperature: { id: 'measure_temperature', value: 21, units: '°C' },
        measure_power: { id: 'measure_power', value: 0 },
        onoff: { id: 'onoff', value: false },
      },
    });
    emitMockHomeyApiDeviceUpdate({
      id: 'dev-1',
      name: 'Heater',
      class: 'heater',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff'],
      capabilitiesObj: {
        target_temperature: { id: 'target_temperature', value: 20, units: '°C' },
        measure_temperature: { id: 'measure_temperature', value: 21, units: '°C' },
        measure_power: { id: 'measure_power', value: 0 },
        onoff: { id: 'onoff', value: true },
      },
    });

    await waitFor(() => reconcileSpy.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect((app as any).latestTargetSnapshot.find((device: { id: string }) => device.id === 'dev-1')).toMatchObject({
      currentOn: true,
    });
  });

  it('does not reconcile when a realtime change brings the device back in line with the current plan', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('target_temperature', 20);
    await heater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);
    const reconcileSpy = jest
      .spyOn((app as any).planService, 'reconcileLatestPlanState')
      .mockResolvedValue(false);

    emitMockHomeyApiDeviceUpdate({
      id: 'dev-1',
      name: 'Heater',
      class: 'heater',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff'],
      capabilitiesObj: {
        target_temperature: { id: 'target_temperature', value: 20, units: '°C' },
        measure_temperature: { id: 'measure_temperature', value: 21, units: '°C' },
        measure_power: { id: 'measure_power', value: 0 },
        onoff: { id: 'onoff', value: false },
      },
    });

    await waitFor(() => reconcileSpy.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

    emitMockHomeyApiDeviceUpdate({
      id: 'dev-1',
      name: 'Heater',
      class: 'heater',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff'],
      capabilitiesObj: {
        target_temperature: { id: 'target_temperature', value: 20, units: '°C' },
        measure_temperature: { id: 'measure_temperature', value: 21, units: '°C' },
        measure_power: { id: 'measure_power', value: 0 },
        onoff: { id: 'onoff', value: true },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect((app as any).latestTargetSnapshot.find((device: { id: string }) => device.id === 'dev-1')).toMatchObject({
      currentOn: true,
    });
  });

  it('opens the reconcile circuit breaker after repeated successful reapply attempts', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('target_temperature', 20);
    await heater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);
    const reconcileSpy = jest
      .spyOn((app as any).planService, 'reconcileLatestPlanState')
      .mockImplementation(async () => {
        (app as any).updateLocalSnapshot('dev-1', { on: true });
        return true;
      });
    const logSpy = jest.spyOn(app, 'log');

    const emitOnOffDrift = (value: boolean) => {
      emitMockHomeyApiDeviceUpdate({
        id: 'dev-1',
        name: 'Heater',
        class: 'heater',
        capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff'],
        capabilitiesObj: {
          target_temperature: { id: 'target_temperature', value: 20, units: '°C' },
          measure_temperature: { id: 'measure_temperature', value: 21, units: '°C' },
          measure_power: { id: 'measure_power', value: 0 },
          onoff: { id: 'onoff', value },
        },
      });
    };

    emitOnOffDrift(false);
    await waitFor(() => reconcileSpy.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

    emitOnOffDrift(false);
    await waitFor(() => reconcileSpy.mock.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

    emitOnOffDrift(false);
    await waitFor(() => reconcileSpy.mock.calls.length === 3);
    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

    expect(logSpy.mock.calls.some(
      (call) => typeof call[0] === 'string'
        && call[0].includes('Realtime reconcile circuit breaker opened for Heater (dev-1)'),
    )).toBe(true);

    const reconcileCountAfterBreaker = reconcileSpy.mock.calls.length;
    emitOnOffDrift(false);
    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));
    expect(reconcileSpy).toHaveBeenCalledTimes(reconcileCountAfterBreaker);
  });

  it('still sheds via binary control while the target reconcile breaker is open', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('measure_power', 360);
    await heater.setCapabilityValue('target_temperature', 23);
    await heater.setCapabilityValue('onoff', true);
    heater.configureCapabilityBehavior('target_temperature', {
      onApiWrite: {
        accept: true,
        updateActual: true,
        updateApi: true,
        emitCapabilityEvent: true,
        emitDeviceUpdate: false,
      },
    });
    heater.configureCapabilityBehavior('onoff', {
      onApiWrite: {
        accept: true,
        updateActual: true,
        updateApi: true,
        emitCapabilityEvent: true,
        emitDeviceUpdate: false,
      },
    });

    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Away');
    mockHomeyInstance.settings.set('mode_device_targets', { Away: { 'dev-1': 23 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'turn_off' } });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const setCapabilitySpy = jest.spyOn(mockHomeyInstance.api, 'put');
    const logSpy = jest.spyOn(app, 'log');

    let fightBackTimer: ReturnType<typeof setTimeout> | null = null;
    const onoffFlow = heater.makeCapabilityInstance('onoff', (value: unknown) => {
      if (value !== false) return;
      // Async fight-back: device resists being turned off, but the response
      // arrives after the DeviceManager's setCapability returns so the
      // device.update realtime event can overwrite the local snapshot.
      fightBackTimer = setTimeout(() => {
        heater.setActualCapabilityValue('onoff', true, {
          updateActual: true,
          updateApi: true,
          emitCapabilityEvent: true,
          emitDeviceUpdate: true,
        });
        fightBackTimer = null;
      }, 10);
    });

    try {
      (app as any).realtimeDeviceReconcileState.circuitState.set('dev-1', {
        windowStartedAt: Date.now(),
        reconcileCount: 0,
        suppressedUntil: Date.now() + 60_000,
      });

      heater.setActualCapabilityValue('target_temperature', 25, {
        updateActual: true,
        updateApi: true,
        emitCapabilityEvent: true,
        emitDeviceUpdate: false,
      });
      await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

      const targetWritesBeforeShedding = setCapabilitySpy.mock.calls.filter(([path, body]) => (
        path === 'manager/devices/device/dev-1/capability/target_temperature'
        && body?.value === 23
      )).length;
      expect(targetWritesBeforeShedding).toBe(0);
      expect(logSpy.mock.calls.some(
        (call) => typeof call[0] === 'string'
          && call[0].includes('Realtime device drift detected; reapplying current plan: Heater (dev-1) via target_temperature'),
      )).toBe(false);

      (app as any).computeDynamicSoftLimit = () => 0.1;
      if ((app as any).capacityGuard?.setSoftLimitProvider) {
        (app as any).capacityGuard.setSoftLimitProvider(() => 0.1);
      }

      await (app as any).recordPowerSample(1000);
      await waitFor(() => setCapabilitySpy.mock.calls.filter(([path, body]) => (
        path === 'manager/devices/device/dev-1/capability/onoff'
        && body?.value === false
      )).length >= 1, 5000);

      const targetWritesAfterShedding = setCapabilitySpy.mock.calls.filter(([path, body]) => (
        path === 'manager/devices/device/dev-1/capability/target_temperature'
        && body?.value === 23
      )).length;
      expect(targetWritesAfterShedding).toBe(targetWritesBeforeShedding);
      expect((app as any).planService.getLatestPlanSnapshot()?.devices[0]).toMatchObject({
        id: 'dev-1',
        plannedState: 'shed',
        plannedTarget: 23,
      });
    } finally {
      setCapabilitySpy.mockRestore();
      logSpy.mockRestore();
      if (fightBackTimer) clearTimeout(fightBackTimer);
      onoffFlow.destroy();
    }
  });

  it('does not reconcile the current plan for temperature-only realtime device updates', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('target_temperature', 20);
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', 1000);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);
    const reconcileSpy = jest.spyOn((app as any).planService, 'reconcileLatestPlanState');

    emitMockHomeyApiDeviceUpdate({
      id: 'dev-1',
      name: 'Heater',
      class: 'heater',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff'],
      capabilitiesObj: {
        target_temperature: { id: 'target_temperature', value: 20, units: '°C' },
        measure_temperature: { id: 'measure_temperature', value: 23, units: '°C' },
        measure_power: { id: 'measure_power', value: 1000 },
        onoff: { id: 'onoff', value: true },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, REALTIME_DEVICE_RECONCILE_SETTLE_WAIT_MS));

    expect(reconcileSpy).not.toHaveBeenCalled();
    expect((app as any).latestTargetSnapshot.find((device: { id: string }) => device.id === 'dev-1')).toMatchObject({
      currentTemperature: 23,
      currentOn: true,
    });
  });

  it('emits power_updated when the power tracker is replaced for the settings UI reset flow', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();
    mockHomeyInstance.api.clearRealtimeEvents();

    const now = new Date('2026-03-03T10:20:00.000Z').getTime();
    const nextState = {
      lastPowerW: 0,
      lastTimestamp: now,
      buckets: { [getHourBucketKey(now)]: 0 },
    };
    (app as any).replacePowerTrackerForUi(nextState);

    const powerEvents = mockHomeyInstance.api._realtimeEvents.filter((event) => event.event === 'power_updated');
    expect(powerEvents).toHaveLength(1);
    expect(powerEvents[0].data).toMatchObject({
      tracker: expect.objectContaining(nextState),
    });
    expect(mockHomeyInstance.settings.get('power_tracker_state')).toMatchObject(nextState);
  });

  it('set_capacity_mode flow card handles autocomplete object format', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];

    // Autocomplete returns an object with id and name, not a plain string
    const result = await setModeListener({ mode: { id: 'Away', name: 'Away' } });
    expect(result).toBe(true);

    expect(mockHomeyInstance.settings.get(OPERATING_MODE_SETTING)).toBe('Away');
    expect((app as any).operatingMode).toBe('Away');
  });

  it('triggers operating_mode_changed when mode changes', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    void setModeListener({ mode: 'Away' });

    const triggers = mockHomeyInstance.flow._triggerCardTriggers['operating_mode_changed'] || [];
    expect(triggers.length).toBe(1);
    expect(triggers[0].state).toEqual({ mode: 'Away' });
  });

  it('operating_mode_changed trigger filters by selected mode', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);

    const triggerListener = mockHomeyInstance.flow._triggerCardRunListeners['operating_mode_changed'];
    expect(typeof triggerListener).toBe('function');

    await expect(triggerListener({ mode: 'Away' }, { mode: 'Away' })).resolves.toBe(true);
    await expect(triggerListener({ mode: { id: 'Away', name: 'Away' } }, { mode: 'Away' })).resolves.toBe(true);
    await expect(triggerListener({ mode: 'Home' }, { mode: 'Away' })).resolves.toBe(false);

    expect(app).toBeDefined();
  });

  it('set_capacity_mode applies device targets when not in dry run', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set up mode targets before init
    mockHomeyInstance.settings.set('mode_device_targets', { Away: { 'dev-1': 16 } });
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);

    const putSpy = jest.spyOn(mockHomeyInstance.api, 'put');

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    await setModeListener({ mode: 'Away' });
    await waitFor(() => putSpy.mock.calls.length > 0);

    // Verify setCapabilityValue was called to apply the target
    expect(putSpy).toHaveBeenCalledWith(
      'manager/devices/device/dev-1/capability/target_temperature',
      { value: 16 },
    );
  });

  it('does not apply device targets when operating_mode changes in dry run', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Away: { 'dev-1': 16 } });
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, true);

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const putSpy = jest.spyOn(mockHomeyInstance.api, 'put');

    // Changing the operating_mode setting should not apply targets in dry run
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Away');
    await flushPromises();

    expect(putSpy).not.toHaveBeenCalled();
  });

  it('does not reapply mode target when device is already at target', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('target_temperature', 20);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 19 } });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const putSpy = jest.spyOn(mockHomeyInstance.api, 'put');

    (app as any).deviceManager.setSnapshotForTests([
      {
        id: 'dev-1',
        name: 'Heater',
        targets: [{ id: 'target_temperature', value: 19, unit: '°C' }],
        currentOn: true,
        controllable: true,
        powerKw: 1,
      },
    ]);

    (app as any).planService.rebuildPlanFromCache();
    await flushPromises();

    expect(putSpy).not.toHaveBeenCalled();
  });

  it('does not spam target writes when the device accepts the write but Homey snapshot data stays stale', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('measure_power', 1200);
    await heater.setCapabilityValue('target_temperature', 18);
    await heater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    // Configure target_temperature to accept API writes but keep API-visible value stale
    heater.configureCapabilityBehavior('target_temperature', {
      onApiWrite: { accept: true, updateActual: true, updateApi: false },
    });
    const putSpy = jest.spyOn(mockHomeyInstance.api, 'put');
    (app as any).modeDeviceTargets = { Home: { 'dev-1': 20 } };

    const nowSpy = jest.spyOn(Date, 'now');
    try {
      const baseNow = new Date('2026-03-12T11:00:00.000Z').getTime();
      nowSpy.mockReturnValue(baseNow);

      await (app as any).planService.rebuildPlanFromCache();
      expect(putSpy).toHaveBeenCalledTimes(1);
      expect(putSpy).toHaveBeenLastCalledWith(
        'manager/devices/device/dev-1/capability/target_temperature',
        { value: 20 },
      );
      expect(heater.getActualCapabilityValue('target_temperature')).toBe(20);

      nowSpy.mockReturnValue(baseNow + 1_000);
      await (app as any).refreshTargetDevicesSnapshot();
      await (app as any).planService.rebuildPlanFromCache();

      // The local snapshot is updated immediately after the write, so the
      // pending target command is confirmed right away — no stale-snapshot
      // retry timer is needed.
      expect(putSpy).toHaveBeenCalledTimes(1);
      expect((app as any).planService.getLatestPlanSnapshot()?.devices[0]).toMatchObject({
        id: 'dev-1',
        plannedTarget: 20,
      });
      expect((app as any).planService.getLatestPlanSnapshot()?.devices[0].pendingTargetCommand).toBeUndefined();

      // After API refresh returns the stale value, the confirmed local
      // snapshot update prevents retry because the executor sees no mismatch
      // in the live snapshot at dispatch time.
      nowSpy.mockReturnValue(baseNow + TARGET_COMMAND_RETRY_DELAYS_MS[0] + 5);
      await (app as any).refreshTargetDevicesSnapshot();
      await (app as any).planService.rebuildPlanFromCache();
      expect(putSpy).toHaveBeenCalledTimes(1);

      // Simulate the API snapshot catching up to the actual value
      heater.syncActualToApi('target_temperature');
      nowSpy.mockReturnValue(baseNow + TARGET_COMMAND_RETRY_DELAYS_MS[0] + 10);
      await (app as any).refreshTargetDevicesSnapshot();
      await (app as any).planService.rebuildPlanFromCache();

      expect(putSpy).toHaveBeenCalledTimes(1);
      expect((app as any).latestTargetSnapshot.find((device: { id: string }) => device.id === 'dev-1')).toMatchObject({
        targets: [expect.objectContaining({ id: 'target_temperature', value: 20 })],
      });
      expect((app as any).planService.getLatestPlanSnapshot()?.devices[0]).toMatchObject({
        id: 'dev-1',
        currentTarget: 20,
        plannedTarget: 20,
      });
      expect((app as any).planService.getLatestPlanSnapshot()?.devices[0].pendingTargetCommand).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not let stale snapshot refresh clear fresher realtime target drift', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('measure_power', 360);
    await heater.setCapabilityValue('target_temperature', 23);
    await heater.setCapabilityValue('onoff', true);
    heater.configureCapabilityBehavior('target_temperature', {
      onApiWrite: {
        accept: true,
        updateActual: false,
        updateApi: true,
        emitCapabilityEvent: false,
        emitDeviceUpdate: false,
      },
    });

    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 23 } });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    heater.setApiCapabilityValue('target_temperature', 26.5);
    heater.emitDeviceUpdate();
    await waitFor(() => (
      (app as any).latestTargetSnapshot.find((device: { id: string }) => device.id === 'dev-1')
        ?.targets?.[0]?.value === 26.5
    ));

    await (app as any).refreshTargetDevicesSnapshot();

    expect((app as any).latestTargetSnapshot.find((device: { id: string }) => device.id === 'dev-1')).toMatchObject({
      targets: [expect.objectContaining({ id: 'target_temperature', value: 26.5 })],
    });
    expect((app as any).deviceManager.getDebugObservedSources('dev-1')?.snapshotRefresh).toEqual(expect.objectContaining({
      snapshot: expect.objectContaining({
        targets: [expect.objectContaining({ id: 'target_temperature', value: 26.5 })],
      }),
    }));
  });

  it('polls device state when a target confirmation has been pending for more than one minute', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('measure_temperature', 21);
    await heater.setCapabilityValue('measure_power', 360);
    await heater.setCapabilityValue('target_temperature', 23);
    await heater.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const nowMs = new Date('2026-03-20T06:00:00.000Z').getTime();
    (app as any).planEngine.state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 16,
      startedMs: nowMs - TARGET_CONFIRMATION_STUCK_POLL_MS - 1,
      lastAttemptMs: nowMs - 5_000,
      retryCount: 0,
      nextRetryAtMs: nowMs + 30_000,
      lastObservedValue: 23,
      lastObservedSource: 'snapshot_refresh',
    };
    const refreshSpy = jest.spyOn(app as any, 'refreshTargetDevicesSnapshot').mockResolvedValue(undefined);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    try {
      await (app as any).pollStuckTargetConfirmations();
    } finally {
      nowSpy.mockRestore();
    }

    expect(refreshSpy).toHaveBeenCalledWith({ targeted: true });
  });

  it('does not reapply targets when set_capacity_mode is invoked with the current mode (not dry-run)', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('target_temperature', 19);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 19 } });
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    // Simulate drift away from the target
    await heater.setCapabilityValue('target_temperature', 21);

    const putSpy = jest.spyOn(mockHomeyInstance.api, 'put');

    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    await setModeListener({ mode: 'Home' });
    await flushPromises();
    jest.runOnlyPendingTimers();
    await flushPromises();

    expect(putSpy).not.toHaveBeenCalled();
  });

  it('handles mode rename without losing settings or leaving dangling entries', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 20 } });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 3 } });
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    // Simulate UI rename operation (data moved to new key, old removed)
    const renamedTargets = { Cozy: { 'dev-1': 20 } };
    const renamedPriorities = { Cozy: { 'dev-1': 3 } };
    mockHomeyInstance.settings.set('mode_device_targets', renamedTargets);
    mockHomeyInstance.settings.set('capacity_priorities', renamedPriorities);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Cozy');
    mockHomeyInstance.settings.set('mode_aliases', { home: 'Cozy' });
    await flushPromises();

    // Settings should only contain the renamed mode
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual(renamedTargets);
    expect(mockHomeyInstance.settings.get('capacity_priorities')).toEqual(renamedPriorities);
    expect(mockHomeyInstance.settings.get(OPERATING_MODE_SETTING)).toBe('Cozy');

    // Internal state should use the renamed mode and drop the old one
    expect((app as any).operatingMode).toBe('Cozy');
    expect((app as any).modeDeviceTargets.Cozy['dev-1']).toBe(20);
    expect((app as any).modeDeviceTargets.Home).toBeUndefined();
    expect((app as any).capacityPriorities.Home).toBeUndefined();

    const modes = Array.from((app as any).getAllModes());
    expect(modes).toContain('Cozy');
    expect(modes).not.toContain('Home');

    // Flow condition should resolve using the renamed mode
    const isModeListener = mockHomeyInstance.flow._conditionCardListeners['is_capacity_mode'];
    await expect(isModeListener({ mode: 'Cozy' })).resolves.toBe(true);
    await expect(isModeListener({ mode: 'Home' })).resolves.toBe(true);

    // Targets should still apply for the renamed mode
    expect(await heater.getCapabilityValue('target_temperature')).toBe(20);
  });

  it('keeps existing flow arguments working after a rename via mode aliases', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 20 } });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 3 } });
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    // Simulate renaming Home -> Cozy in settings (UI migration)
    mockHomeyInstance.settings.set('mode_device_targets', { Cozy: { 'dev-1': 20 } });
    mockHomeyInstance.settings.set('capacity_priorities', { Cozy: { 'dev-1': 3 } });
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Cozy');
    mockHomeyInstance.settings.set('mode_aliases', { home: 'Cozy' });
    await flushPromises();

    // Flow card still holds the old name; alias should resolve it to the new one.
    const isModeListener = mockHomeyInstance.flow._conditionCardListeners['is_capacity_mode'];
    await expect(isModeListener({ mode: 'Home' })).resolves.toBe(true);

    // Keep lint happy about unused app
    expect(app).toBeDefined();
  });

  it('keeps flow arguments working when two modes swap names via aliases', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 20 }, Away: { 'dev-1': 18 } });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 3 }, Away: { 'dev-1': 2 } });
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    // Simulate a swap: Home -> Work, Away -> Home (so "Work" takes the old Home data)
    mockHomeyInstance.settings.set('mode_device_targets', { Work: { 'dev-1': 20 }, Home: { 'dev-1': 18 } });
    mockHomeyInstance.settings.set('capacity_priorities', { Work: { 'dev-1': 3 }, Home: { 'dev-1': 2 } });
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Work'); // active mode is the renamed former Home
    mockHomeyInstance.settings.set('mode_aliases', { home: 'Work', away: 'Home' });
    await flushPromises();

    expect((app as any).operatingMode).toBe('Work');

    const isModeListener = mockHomeyInstance.flow._conditionCardListeners['is_capacity_mode'];

    // Flows still referring to old names should resolve via aliases
    await expect(isModeListener({ mode: 'Away' })).resolves.toBe(false); // Away -> Home (inactive)
    await expect(isModeListener({ mode: 'Home' })).resolves.toBe(true); // Home -> Work (active)

    expect(app).toBeDefined();
  });

  it('does not restore shed devices immediately after recovering from a prolonged overshoot', async () => {
    // Regression: when overshoot lasted longer than SHED_COOLDOWN_MS, the
    // cooldown (computed from overshoot-detection time) had already expired
    // at recovery, so devices were restored immediately — causing another
    // overshoot within seconds.  The fix records lastRecoveryMs so the
    // cooldown window starts from the moment of recovery.
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff', 'measure_power']);
    await heater.setCapabilityValue('measure_power', 3000);
    await heater.setCapabilityValue('target_temperature', 23);
    await heater.setCapabilityValue('onoff', true);
    heater.configureCapabilityBehavior('onoff', {
      onApiWrite: {
        accept: true,
        updateActual: true,
        updateApi: true,
        emitCapabilityEvent: true,
        emitDeviceUpdate: false,
      },
    });

    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 5);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 23 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', { 'dev-1': { action: 'turn_off' } });

    const app = createApp();
    await initApp(app);
    await waitForSnapshot();

    const nowSpy = jest.spyOn(Date, 'now');
    const putSpy = jest.spyOn(mockHomeyInstance.api, 'put');
    try {
      const baseNow = Date.now();

      // --- Phase 1: trigger overshoot and shed the device ---
      nowSpy.mockReturnValue(baseNow);
      (app as any).computeDynamicSoftLimit = () => 2;
      if ((app as any).capacityGuard?.setSoftLimitProvider) {
        (app as any).capacityGuard.setSoftLimitProvider(() => 2);
      }
      await (app as any).recordPowerSample(3000, baseNow);
      await waitFor(() => (
        getPlanDeviceState(mockHomeyInstance.settings.get('device_plan_snapshot'), 'dev-1') === 'shed'
      ));
      expect(heater.getActualCapabilityValue('onoff')).toBe(false);

      // --- Phase 2: overshoot persists for longer than SHED_COOLDOWN_MS ---
      // (simulates the prolonged shedding observed in production logs)
      const afterLongOvershoot = baseNow + SHED_COOLDOWN_MS + 30_000;
      nowSpy.mockReturnValue(afterLongOvershoot);

      // --- Phase 3: power drops, system recovers ---
      (app as any).computeDynamicSoftLimit = () => 5;
      if ((app as any).capacityGuard?.setSoftLimitProvider) {
        (app as any).capacityGuard.setSoftLimitProvider(() => 5);
      }
      await heater.setCapabilityValue('measure_power', 0);
      await (app as any).refreshTargetDevicesSnapshot();
      await (app as any).recordPowerSample(500, afterLongOvershoot);
      await (app as any).planService.rebuildPlanFromCache();

      // The device should still be planned as 'shed' because the recovery
      // cooldown (lastRecoveryMs) has just started.
      expect(
        getPlanDeviceState(mockHomeyInstance.settings.get('device_plan_snapshot'), 'dev-1'),
      ).toBe('shed');

      // --- Phase 4: after cooldown expires, the device is restored ---
      const afterCooldown = afterLongOvershoot + SHED_COOLDOWN_MS + 1000;
      nowSpy.mockReturnValue(afterCooldown);
      await (app as any).recordPowerSample(500, afterCooldown);
      await waitFor(() => (
        getPlanDeviceState(mockHomeyInstance.settings.get('device_plan_snapshot'), 'dev-1') !== 'shed'
      ), 3000);

      expect(
        getPlanDeviceState(mockHomeyInstance.settings.get('device_plan_snapshot'), 'dev-1'),
      ).toBe('keep');
    } finally {
      nowSpy.mockRestore();
      putSpy.mockRestore();
    }
  });
});

describe('computeDynamicSoftLimit', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
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
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 5);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);

    const app = createApp();
    await initApp(app);

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
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 5);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);

    const app = createApp();
    await initApp(app);

    // Mock the power tracker
    (app as any).powerTracker = {
      buckets: {},
    };

    const now = new Date();
    const nowMs = now.getTime();
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);

    // Set the bucket to have 4.9 kWh used (almost exhausted budget)
    const bucketKey = getHourBucketKey(nowMs);
    (app as any).powerTracker.buckets[bucketKey] = 4.9;

    const softLimit = (app as any).computeDynamicSoftLimit();

    // With 5 kWh budget, 4.9 used, only 0.1 kWh remaining
    // The burst rate will be low (0.1 / remaining hours)
    // The cap (5 kW) doesn't apply because burst rate is already lower
    expect(softLimit).toBeLessThan(5);
    expect(softLimit).toBeGreaterThanOrEqual(0);
    jest.restoreAllMocks();
  });

  it('returns sustainable rate at start of hour with full budget', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Set capacity limit to 5 kW with 0 margin -> sustainable rate = 5 kW
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 5);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);

    const app = createApp();
    await initApp(app);

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
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 7);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.3);

    const app = createApp();
    await initApp(app);

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
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 7);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.3);

    const app = createApp();
    await initApp(app);

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
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 7);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.3);

    const app = createApp();
    await initApp(app);

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
    await initApp(app);

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
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, true);
    // Set up priorities so the device is in the plan
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 1 } });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);

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

  it('backfills managed devices from price optimization settings on first run', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('price_optimization_settings', {
      'dev-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
    });

    const app = createApp();
    await initApp(app);

    expect(mockHomeyInstance.settings.get('managed_devices')).toEqual({ 'dev-1': true });
    expect(mockHomeyInstance.settings.get('controllable_devices')).toBeUndefined();
  });

  it('backfills capacity control when managed is true and no settings exist', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);

    expect(mockHomeyInstance.settings.get('managed_devices')).toEqual({ 'dev-1': true });
    expect(mockHomeyInstance.settings.get('controllable_devices')).toEqual({ 'dev-1': true });
  });

  it('does not enable capacity control when price optimization is enabled', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'dev-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
    });

    const app = createApp();
    await initApp(app);

    expect(mockHomeyInstance.settings.get('managed_devices')).toEqual({ 'dev-1': true });
    expect(mockHomeyInstance.settings.get('controllable_devices')).toBeUndefined();
  });

  it('does not override explicit unmanaged devices during migration', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': false });
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'dev-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
    });

    const app = createApp();
    await initApp(app);

    expect(mockHomeyInstance.settings.get('managed_devices')).toEqual({ 'dev-1': false });
    expect(mockHomeyInstance.settings.get('controllable_devices')).toBeUndefined();
  });

  it('migration is idempotent - running twice produces same result', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('price_optimization_settings', {
      'dev-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
    });

    const app = createApp();
    await initApp(app);

    const managedAfterFirst = mockHomeyInstance.settings.get('managed_devices');
    const controllableAfterFirst = mockHomeyInstance.settings.get('controllable_devices');

    await cleanupApps();

    const app2 = createApp();
    await initApp(app2);

    const managedAfterSecond = mockHomeyInstance.settings.get('managed_devices');
    const controllableAfterSecond = mockHomeyInstance.settings.get('controllable_devices');

    expect(managedAfterSecond).toEqual(managedAfterFirst);
    expect(controllableAfterSecond).toEqual(controllableAfterFirst);
  });

  it('backfills managed devices from capacity control settings', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = createApp();
    await initApp(app);

    expect(mockHomeyInstance.settings.get('managed_devices')).toEqual({ 'dev-1': true });
    expect(mockHomeyInstance.settings.get('controllable_devices')).toEqual({ 'dev-1': true });
  });
});

describe('periodic snapshot refresh scheduling', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'clearImmediate', 'setInterval', 'clearInterval'] });
    clearMockHomeyApiDeviceListeners();
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set('price_scheme', 'flow');
    mockHomeyInstance.api.clearRealtimeEvents();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('fires refresh at minute :25 and :55', async () => {
    jest.setSystemTime(new Date('2026-03-21T10:00:00Z'));

    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });

    const app = createApp();
    await initApp(app);
    const refreshSpy = jest.spyOn(app as any, 'refreshTargetDevicesSnapshot').mockResolvedValue(undefined);
    const logSpy = jest.spyOn(app as any, 'logPeriodicStatus').mockImplementation(() => {});

    (app as any).startPeriodicSnapshotRefresh();

    // Advance to :25 — should fire
    jest.advanceTimersByTime(25 * 60 * 1000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);

    // Advance to :55 — should fire again
    jest.advanceTimersByTime(30 * 60 * 1000);
    expect(refreshSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it('does not fire at other minutes', async () => {
    jest.setSystemTime(new Date('2026-03-21T10:00:00Z'));

    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });

    const app = createApp();
    await initApp(app);
    const refreshSpy = jest.spyOn(app as any, 'refreshTargetDevicesSnapshot').mockResolvedValue(undefined);

    (app as any).startPeriodicSnapshotRefresh();

    // Advance 10 minutes — no scheduled refresh
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('wraps to next hour when past :55', async () => {
    jest.setSystemTime(new Date('2026-03-21T10:56:00Z'));

    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });

    const app = createApp();
    await initApp(app);
    const refreshSpy = jest.spyOn(app as any, 'refreshTargetDevicesSnapshot').mockResolvedValue(undefined);

    (app as any).startPeriodicSnapshotRefresh();

    // Should not fire during remaining 4 minutes of the hour
    jest.advanceTimersByTime(4 * 60 * 1000);
    expect(refreshSpy).not.toHaveBeenCalled();

    // Advance to next hour :25 (29 minutes from :56)
    jest.advanceTimersByTime(25 * 60 * 1000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});
