import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { drainPending } from '../utils/asyncDrain';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN, CAPACITY_ENABLED, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES, GRID_IMPORT_ENABLED, GRID_IMPORT_LIMIT_KW,
  CONTROLLABLE_DEVICES, MANAGED_DEVICES, OPERATING_MODE_SETTING, OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';

const poll = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(10_000);
  await drainPending();
};

// Only Homey reads, writes and the clock are mocked. The actual measurement,
// planner, executor and command-confirmation path run together.
const boot = async (capacityEnabled = false, gridEnabled = true) => {
  const ev = new MockDevice('flex', 'Flexible load', ['onoff', 'measure_power', 'meter_power'], 'socket');
  const heater = new MockDevice('heater', 'Water heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
  for (const [device, powerW] of [[ev, 1400], [heater, 800]] as const) {
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', powerW);
    await device.setCapabilityValue('meter_power', 100);
  }
  setMockDrivers({ driverA: new MockDriver('driverA', [ev, heater]) });
  const settings = mockHomeyInstance.settings;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-main');
  settings.set(CAPACITY_ENABLED, capacityEnabled);
  settings.set(CAPACITY_PERIOD_MINUTES, 15);
  settings.set(CAPACITY_LIMIT_KW, 5);
  settings.set(CAPACITY_MARGIN_KW, 0.2);
  settings.set(GRID_IMPORT_ENABLED, gridEnabled);
  settings.set(GRID_IMPORT_LIMIT_KW, 3.3);
  settings.set(CAPACITY_DRY_RUN, false);
  settings.set(OPERATING_MODE_SETTING, 'Home');
  settings.set(CONTROLLABLE_DEVICES, { flex: true, heater: true });
  settings.set(MANAGED_DEVICES, { flex: true, heater: true });
  settings.set('capacity_priorities', { Home: { flex: 2, heater: 1 } });
  settings.set(OVERSHOOT_BEHAVIORS, { flex: { action: 'turn_off' }, heater: { action: 'turn_off' } });
  let meterAvailable = true;
  let backgroundW = 400;
  let fixedMeterW: number | null = null;
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      if (!meterAvailable) return { items: [] };
      const flexibleW = (await ev.getCapabilityValue('onoff')) === true ? 1400 : 0;
      const heatingW = (await heater.getCapabilityValue('onoff')) === true ? 800 : 0;
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: fixedMeterW ?? backgroundW + flexibleW + heatingW } }] };
    }
    return originalGet(path);
  });
  const transitions: Array<{ path: string; value: boolean; atMs: number }> = [];
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    const result = await originalPut(path, body);
    const device = path.includes('/flex/') ? ev : heater;
    if (device && path.endsWith('/onoff')) {
      transitions.push({ path, value: (body as { value: boolean }).value, atMs: Date.now() });
      const onPowerW = device === ev ? 1400 : 800;
      await device.setCapabilityValue('measure_power', (body as { value: boolean }).value ? onPowerW : 0);
    }
    return result;
  });
  const app = createApp();
  const records: unknown[] = [];
  const originalLog = app.log.bind(app);
  app.log = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try { records.push(JSON.parse(arg)); } catch { /* ordinary SDK output */ }
    }
    originalLog(...args);
  };
  await app.onInit();
  await poll();
  return {
    app, ev, heater, put, records, transitions,
    stopMeter: () => { meterAvailable = false; },
    setBackground: (value: number) => { backgroundW = value; },
    fixMeter: (value: number | null) => { fixedMeterW = value; },
    shedCalls: () => put.mock.calls.filter(([path, body]) => path.endsWith('/onoff') && (body as { value: boolean }).value === false),
  };
};

describe('grid import control through Homey', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'] });
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    resetMockHomey();
    setMockDrivers({});
  });
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reduces an oven spike at the next poll and restores gradually when the oven stops', async () => {
    const home = await boot();
    expect(home.shedCalls()).toHaveLength(0);
    home.setBackground(2400); // 4.6 kW including the flexible loads.
    await poll();
    expect(home.shedCalls().length).toBeGreaterThan(0);
    expect(await home.ev.getCapabilityValue('onoff')).toBe(false);
    await poll();
    expect(await home.heater.getCapabilityValue('onoff')).toBe(false);
    home.setBackground(400);
    for (let i = 0; i < 48; i += 1) await poll();
    expect(await home.ev.getCapabilityValue('onoff')).toBe(true);
    expect(await home.heater.getCapabilityValue('onoff')).toBe(true);
    const restored = home.put.mock.calls.filter(([path, body]) => path.endsWith('/onoff') && (body as { value: boolean }).value === true);
    expect(restored).toHaveLength(2);
    const restoreTimes = home.transitions.filter((entry) => entry.value).map((entry) => entry.atMs);
    expect(restoreTimes[1] - restoreTimes[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('continues reducing when a delivered reduction is masked by new unmanaged demand', async () => {
    const home = await boot();
    home.fixMeter(4100);
    await poll();
    expect(await home.ev.getCapabilityValue('onoff')).toBe(false);
    expect(await home.heater.getCapabilityValue('onoff')).toBe(true);
    // The breach holds steady, so the reading 10 s later waits out the 15 s
    // post-reduction holdoff; the next one, still high, reduces further.
    await poll();
    expect(await home.heater.getCapabilityValue('onoff')).toBe(true);
    await poll();
    expect(await home.heater.getCapabilityValue('onoff')).toBe(false);
  });

  // At boot the store has accepted nothing, and the app's built-in capacity
  // settings are a posture the owner never set. A grid switch that reads back on
  // without its threshold must keep the safe boot posture (simulation) until the
  // read heals, rather than control devices on invented limits with the
  // persisted `dry_run=false`.
  it('controls nothing at boot until a grid threshold that reads back missing heals', async () => {
    let missLimit = true;
    const readSetting = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation(
      (key: string) => (key === GRID_IMPORT_LIMIT_KW && missLimit ? undefined : readSetting(key)),
    );
    const home = await boot(true);
    // Over the 3.135 kW grid target, and over a quarter that has no history yet.
    home.setBackground(2400);
    for (let i = 0; i < 3; i += 1) await poll();
    expect(home.put.mock.calls.filter(([path]) => path.endsWith('/onoff'))).toHaveLength(0);

    missLimit = false;
    for (let i = 0; i < 2; i += 1) await poll();
    expect(home.shedCalls().length).toBeGreaterThan(0);
    expect(home.app.getLatestPlanSnapshotForUi()?.meta?.gridImportLimitKw).toBe(3.3);
  });

  // After a well-formed read, a malformed external write keeps the accepted
  // grid posture; the bounded re-reads end without claiming a recovery.
  it('keeps the accepted grid limit through a malformed write, without a recovery rebuild when the retries end', async () => {
    const home = await boot();
    mockHomeyInstance.settings.set(GRID_IMPORT_LIMIT_KW, 'junk');
    await drainPending();
    for (let i = 0; i < 5; i += 1) await poll();
    expect(home.app.getLatestPlanSnapshotForUi()?.meta?.gridImportLimitKw).toBe(3.3);
    const recovered = home.records.filter((record) => (
      (record as { reasonCode?: string }).reasonCode === 'settings:capacity_settings_read_recovered'
    ));
    expect(recovered).toHaveLength(0);

    mockHomeyInstance.settings.set(GRID_IMPORT_LIMIT_KW, 4);
    await drainPending();
    await poll();
    expect(home.app.getLatestPlanSnapshotForUi()?.meta?.gridImportLimitKw).toBe(4);
  });

  it('keeps grid pressure independent of an under-used 15-minute capacity budget', async () => {
    const home = await boot(true);
    home.setBackground(2400);
    await poll();
    expect(home.shedCalls().length).toBeGreaterThan(0);
    expect(home.app.getLatestPlanSnapshotForUi()?.meta?.softLimitSource).toBe('grid');
  });

  it('uses the existing meter-outage fail-closed pass for grid-only control', async () => {
    const home = await boot();
    home.stopMeter();
    for (let i = 0; i < 66; i += 1) await poll();
    expect(home.shedCalls()).toHaveLength(2);
    expect(home.app.getLatestPlanSnapshotForUi()?.meta?.powerIsMeasured).toBe(false);
  });

  it('preserves net export as headroom while grid control is enabled', async () => {
    const home = await boot();
    home.fixMeter(-1200);
    for (let i = 0; i < 4; i += 1) await poll();
    expect(home.shedCalls()).toHaveLength(0);
    expect(home.app.getLatestPlanSnapshotForUi()?.meta?.totalKw).toBeCloseTo(-1.2);
  });

  it('releases a grid hold after disabling the constraint without changing period history', async () => {
    const home = await boot();
    home.setBackground(2400);
    await poll();
    expect(await home.ev.getCapabilityValue('onoff')).toBe(false);
    mockHomeyInstance.settings.set(GRID_IMPORT_ENABLED, false);
    await drainPending();
    for (let i = 0; i < 20; i += 1) await poll();
    expect(await home.ev.getCapabilityValue('onoff')).toBe(true);
    const meta = home.app.getLatestPlanSnapshotForUi()?.meta;
    expect(meta?.gridImportLimitKw).toBeNull();
    expect(meta?.softLimitKw).toBeNull();
    expect(meta?.capacityPeriodMinutes).toBe(15);
  });

  it('does not treat disabled limits as capacity pressure', async () => {
    const home = await boot(false, false);
    home.fixMeter(8000);
    await poll();
    expect(home.shedCalls()).toHaveLength(0);
    home.fixMeter(-1200);
    await poll();
    expect(home.shedCalls()).toHaveLength(0);
  });
});
