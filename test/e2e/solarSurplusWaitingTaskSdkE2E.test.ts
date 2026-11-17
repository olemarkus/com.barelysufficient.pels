// SDK-boundary e2e (createApp): a device on "Run on solar surplus" with a smart
// task that waits for a cheaper hour. The task skips the current hour, and the
// home starts exporting solar. The device runs on that surplus, and what it
// draws counts toward the task.
//
// Nothing internal is mocked. Whole-home net power enters through the Homey
// Energy poll (`manager/energy/live`, negative = exporting), prices through the
// Flow price settings, and the task through its persisted setting. The pump's
// own meter follows its switch, as a real plug's does. What is asserted is what
// PELS writes back through the SDK (`api.put` of `onoff`) and what the task
// reports in its `deferred_objective_horizon_planned` log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedHourlyFlowPricesForTests } from '../helpers/smartTaskPriceSourceFixture';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps, seedStoredPowerTrackerForTests } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, DAILY_BUDGET_ENABLED, DEBUG_LOGGING_TOPICS,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { drainPending, drainUntilCalledWith } from '../utils/asyncDrain';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';

const HOUR_MS = 60 * 60 * 1000;
const DAY = Date.UTC(2026, 4, 10, 0, 0, 0);
const DEVICE = 'pool-pump';
const LOAD_W = 1000;
const TARGET_KWH = 1;
// Noon is expensive; 16:00 is the one cheap hour before the 18:00 ready-by time.
const CHEAP_HOUR = 16;
const prices = Array.from({ length: 24 }, (_, hour) => (hour === CHEAP_HOUR ? 5 : 50));

const cap = (capability: string) => `manager/devices/device/${DEVICE}/capability/${capability}`;

type TaskLog = { event?: string; deviceId?: string; currentValue?: number | null; currentHourClaim?: string | null };

// Whole-home net power, W: the house's own draw, plus the pump while it runs.
let houseNetW = 0;
let pump: MockDevice;
// The pump's switch as Homey last wrote it; its meter follows.
let pumpOn = false;
const pumpDrawW = (): number => (pumpOn ? LOAD_W : 0);

const wireHome = () => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: houseNetW + pumpDrawW() } }] };
    }
    return originalGet(path);
  });
};

// Homey Energy polls at the real 10 s cadence; the pump's meter follows its switch.
const advancePolls = async (count: number) => {
  for (let i = 0; i < count; i += 1) {
    pump.setActualCapabilityValue('measure_power', pumpDrawW());
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

const seedSettings = (surplusWilling: boolean) => {
  mockHomeyInstance.settings.set(DEBUG_LOGGING_TOPICS, ['deferred_objectives']);
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(DAILY_BUDGET_ENABLED, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('price_optimization_enabled', true);
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('price_optimization_settings', {
    [DEVICE]: { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling },
  });
  seedHourlyFlowPricesForTests(DAY, prices);
  // A home that has exported before, which makes the surplus setting available.
  seedStoredPowerTrackerForTests({ exportBuckets: { '2026-05-09T11:00:00.000Z': 2 } });
  mockHomeyInstance.settings.set(`deferred_objective.${DEVICE}`, {
    enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: TARGET_KWH,
    deadlineAtMs: DAY + 18 * HOUR_MS,
  });
};

const boot = async (surplusWilling: boolean) => {
  pump = new MockDevice(DEVICE, 'Pool pump', ['onoff', 'measure_power', 'meter_power'], 'socket');
  pump.setSettings({ load: LOAD_W });
  await pump.setCapabilityValue('onoff', false);
  await pump.setCapabilityValue('measure_power', 0);
  await pump.setCapabilityValue('meter_power', 100);
  setMockDrivers({ driverA: new MockDriver('driverA', [pump]) });
  seedSettings(surplusWilling);
  wireHome();
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === cap('onoff') && typeof value === 'boolean') pumpOn = value;
  });
  const app = createApp({ preserveStartupRestoreStabilization: true });
  const taskLogs: TaskLog[] = [];
  const log = app.log.bind(app);
  app.log = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try {
        const parsed = JSON.parse(arg) as TaskLog;
        if (parsed.event === 'deferred_objective_horizon_planned' && parsed.deviceId === DEVICE) taskLogs.push(parsed);
      } catch { /* not a structured line */ }
    }
    return log(...args);
  };
  await app.onInit();
  const onWrites = () => putSpy.mock.calls
    .filter(([path]) => path === cap('onoff'))
    .map(([, body]) => (body as { value?: boolean } | undefined)?.value);
  const reason = () => app.planService.getLatestPlanSnapshot()?.devices.find((device) => device.id === DEVICE)?.reason;
  return { putSpy, taskLogs, onWrites, reason };
};

describe('a waiting smart task and solar surplus (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(DAY + 12 * HOUR_MS);
    houseNetW = 0;
    pumpOn = false;
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs a surplus-setting device on export in an hour its task skips, and counts the energy', async () => {
    // Importing at noon: the task waits for 16:00 and the pump stays off.
    houseNetW = 1500;
    const { putSpy, taskLogs, onWrites, reason } = await boot(true);
    await advancePolls(12);
    await drainPending();
    expect(onWrites()).not.toContain(true);
    expect(taskLogs.at(-1)?.currentHourClaim).toBe('released');
    expect(taskLogs.at(-1)?.currentValue ?? 0).toBe(0);
    // Its card still says what the task waits for.
    expect(reason()).toEqual({ code: 'deferred_objective_avoid' });

    // The sun comes out: 3 kW exported. The pump starts on it.
    houseNetW = -3000;
    await advancePolls(40);
    await drainUntilCalledWith(putSpy, cap('onoff'), pelsCapabilityWrite(true));
    expect(onWrites()).toContain(true);

    // Twenty minutes at 1 kW: the task has counted what the pump drew.
    await advancePolls(120);
    await drainPending();
    const delivered = taskLogs.at(-1)?.currentValue ?? 0;
    expect(delivered).toBeGreaterThan(0.2);
    expect(delivered).toBeLessThan(TARGET_KWH);
  });

  it('keeps a device without a surplus setting off on export after its first plan', async () => {
    houseNetW = -3000;
    const { putSpy, taskLogs, onWrites } = await boot(false);
    // Before the first plan, the new task leaves the device under normal control.
    expect(taskLogs).toEqual([]);
    expect(onWrites()).toContain(true);
    await advancePolls(6);
    await drainPending();
    expect(taskLogs.at(-1)?.currentHourClaim).toBe('released');
    expect(await pump.getCapabilityValue('onoff')).toBe(false);

    putSpy.mockClear();
    await advancePolls(60);
    await drainPending();
    expect(onWrites()).not.toContain(true);
    expect(await pump.getCapabilityValue('onoff')).toBe(false);
  });
});
