import type { InitializedAppContext } from '../../lib/app/appContext';
import {
  mockHomeyInstance,
  resetMockHomey,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

vi.mock('../../setup/appLifecycleHelpers', () => ({
  runStartupStep: async (_label: string, work: () => unknown | Promise<unknown>) => work(),
  // Mirrors production's signature: `startAppServices` runs immediately after
  // `requireInitializedAppContext`, so both services are present by contract.
  // Typed loosely, the optional chaining below would let a future reorder skip
  // the startup rebuild silently and leave this spec green on a shorter start.
  startAppServices: async (ctx: InitializedAppContext) => {
    ctx.hydratePowerTracker();
    ctx.loadPriceOptimizationSettings();
    await ctx.updateOverheadToken();
    await ctx.refreshTargetDevicesSnapshot({ fast: true, recordHomeyEnergySample: false });
    await ctx.planService.rebuildPlanFromCache('startup_snapshot_bootstrap');
    ctx.registerFlowCards();
    ctx.snapshotHelpers.startPeriodicSnapshotRefresh();
    ctx.homeyEnergyHelpers.start();
    // Intentionally skip price refresh/optimization timers to keep tests fast and deterministic.
  },
}));

const flushPromises = () => new Promise<void>((resolve) => {
  const queueMicrotaskFn = (globalThis as { queueMicrotask?: (cb: () => void) => void }).queueMicrotask;
  if (typeof queueMicrotaskFn === 'function') {
    queueMicrotaskFn(() => resolve());
    return;
  }
  if (typeof setImmediate === 'function') {
    setImmediate(() => resolve());
    return;
  }
  setTimeout(() => resolve(), 0);
});

const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await flushPromises();
  }
};

describe('Mode device targets', () => {
  beforeEach(() => {
    resetMockHomey();
    mockHomeyInstance.settings.set('price_scheme', 'flow');
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('applies device targets when operating_mode or mode_device_targets changes', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power']);
    await heater.setCapabilityValue('measure_power', 1000);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });
    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();


    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 19 } });
    mockHomeyInstance.settings.set('operating_mode', 'Home');

    await waitFor(() => heater.getSetCapabilityValue('target_temperature') === 19);

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(19);
  });

  it('updates temperatures when targets change for the active mode', async () => {
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power']);
    await heater.setCapabilityValue('measure_power', 1000);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    // Preload active mode before app init.
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();


    // Update targets for the current mode; should immediately apply.
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 21.5 } });

    await waitFor(() => heater.getSetCapabilityValue('target_temperature') === 21.5);

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(21.5);
  });

  it('never sends an illegal target value when the device json includes a target step', async () => {
    const heater = new MockDevice('dev-1', 'Connected 300', ['target_temperature', 'measure_power']);
    await heater.setCapabilityValue('measure_power', 1000);
    heater.setCapabilityMetadata('target_temperature', {
      units: '°C',
      min: 35,
      max: 75,
      step: 5,
    });
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });

    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 64.5 } });

    await waitFor(() => heater.getSetCapabilityValue('target_temperature') === 65);

    expect(heater.getSetCapabilityValue('target_temperature')).toBe(65);
  });

  it('fills a missing target once per process, so a user-clear survives later refreshes', async () => {
    // The fill pass remembers what it filled on its instance, so the app must
    // hold ONE: an instance per refresh would forget the fill and put a cleared
    // entry straight back.
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_temperature', 'measure_power']);
    await heater.setCapabilityValue('measure_power', 1000);
    await heater.setCapabilityValue('measure_temperature', 20);
    await heater.setCapabilityValue('target_temperature', 21);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: {}, Away: {} });

    const app = createApp();
    await app.onInit();
    await app.refreshTargetDevicesSnapshot({ fast: true, recordHomeyEnergySample: false });

    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({
      Home: { 'dev-1': 21 },
      Away: { 'dev-1': 21 },
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: {}, Away: { 'dev-1': 21 } });
    await app.refreshTargetDevicesSnapshot({ fast: true, recordHomeyEnergySample: false });

    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({ Home: {}, Away: { 'dev-1': 21 } });
  });

  it('fills no target for a thermostat PELS does not manage, then its setpoint at opt-in', async () => {
    // With no `managed_devices` entry the device is in the snapshot but not
    // managed, so the planner does not plan it, and the fill must not seed a
    // target the owner never asked PELS to hold.
    const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_temperature', 'measure_power']);
    await heater.setCapabilityValue('measure_power', 1000);
    await heater.setCapabilityValue('measure_temperature', 20);
    await heater.setCapabilityValue('target_temperature', 21);
    setMockDrivers({
      driverA: new MockDriver('driverA', [heater]),
    });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: {}, Away: {} });

    const app = createApp();
    await app.onInit();
    await app.refreshTargetDevicesSnapshot({ fast: true, recordHomeyEnergySample: false });

    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({ Home: {}, Away: {} });

    // The owner changes the setpoint, then opts the device in: the seed is the
    // setpoint at opt-in, not the one it had when PELS first saw it.
    await heater.setCapabilityValue('target_temperature', 19);
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });
    await app.refreshTargetDevicesSnapshot({ fast: true, recordHomeyEnergySample: false });

    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({
      Home: { 'dev-1': 19 },
      Away: { 'dev-1': 19 },
    });
  });
});
