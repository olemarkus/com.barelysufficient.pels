// App boot in PRODUCTION order.
//
// The suite boots the app synchronously: under `NODE_ENV=test` the snapshot/plan
// and price bootstraps run inside `onInit`, and the snapshot warmup gate opens at
// construction (`setup/appServiceWiring.ts`). Production does neither. It defers
// the snapshot/plan bootstrap ~1.2 s, runs the price bootstrap in the background,
// and holds every plan rebuild behind the warmup gate until the first device
// snapshot lands (`setup/appLifecycleHelpers.ts`, `lib/plan/snapshotWarmupGate.ts`).
//
// These specs boot the real app (`createApp` + `onInit`) with
// `PELS_ASYNC_STARTUP=1`, which selects that order, so a regression in it fails
// here instead of only on a Homey. Integration tier: they read the plan, the
// warmup gate and the observer's refresh feed, not only SDK output.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type MyApp from '../../app.ts';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainPending, drainUntil, drainUntilCalledWith } from '../utils/asyncDrain';
import { getDateKeyInTimeZone, getDateKeyStartMs } from '../../packages/shared-domain/src/utils/dateUtils';
import type { HomeyEnergyPriceInterval } from '../../lib/utils/homeyEnergy';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  PRICE_SCHEME,
} from '../../lib/utils/settingsKeys';

// `snapshotPlanBootstrapDelayMs` in `setup/appServiceWiring.ts`.
const DEFERRED_BOOTSTRAP_DELAY_MS = 1200;

const DEVICE_ID = 'device-a';
const ONOFF_CAPABILITY_PATH = `manager/devices/device/${DEVICE_ID}/capability/onoff`;
const DEVICE_LIST_PATH = 'manager/devices/device';
const HOME_POWER_W = 5000;
const TZ = 'Europe/Oslo';

const configureOverLimitHome = async (): Promise<void> => {
  const device = new MockDevice(
    DEVICE_ID,
    'On/Off Socket',
    ['onoff', 'measure_power', 'meter_power'],
    'socket',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 2000);
  await device.setCapabilityValue('meter_power', 100);
  setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
  // A home well over its limit, so a plan built from the real device sheds it
  // and the decision is visible as an SDK write.
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE_ID]: true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE_ID]: true });
};

type StructuredLine = { event?: string; reason?: string; reasonCode?: string; taskLabel?: string };

/**
 * One ordered record of what boot did, from the app's own structured log (the
 * JSON lines it hands `app.log` / `app.error`) and the observer's refresh feed.
 * Installed before `onInit`, so nothing boot does is missed.
 */
const recordBootTimeline = (app: MyApp): string[] => {
  const timeline: string[] = [];
  const record = (args: unknown[]): void => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      let line: StructuredLine;
      try {
        line = JSON.parse(arg) as StructuredLine;
      } catch {
        continue;
      }
      if (line.event === 'snapshot_warmup_gate_released') timeline.push(`warmup_gate_released:${line.reason}`);
      if (line.event === 'plan_rebuild_completed') timeline.push(`plan_built:${line.reasonCode}`);
      if (line.event === 'startup_background_task_failed') timeline.push(`background_task_failed:${line.taskLabel}`);
    }
  };
  const originalLog = app.log.bind(app);
  const originalError = app.error.bind(app);
  vi.spyOn(app, 'log').mockImplementation((...args: unknown[]) => { record(args); originalLog(...args); });
  vi.spyOn(app, 'error').mockImplementation((...args: unknown[]) => { record(args); originalError(...args); });
  app['observedStateEmitter'].onObservedStateRefresh((event) => {
    const ids = event.entries.map((entry) => entry.observed.id).sort();
    timeline.push(`observer_refreshed:${ids.join(',')}`);
  });
  return timeline;
};

const latestPlanDeviceIds = (app: MyApp): string[] | null => (
  app.planService.getLatestPlanSnapshot()?.devices.map((device) => device.id) ?? null
);

describe('app boot in production order (PELS_ASYNC_STARTUP=1)', () => {
  let previousAsyncStartup: string | undefined;
  const spies: MockInstance[] = [];

  beforeEach(() => {
    previousAsyncStartup = process.env.PELS_ASYNC_STARTUP;
    process.env.PELS_ASYNC_STARTUP = '1';
    // 'Date' and 'performance' MUST be faked together: the plan-rebuild
    // scheduler reads the monotonic clock and the rest of the app reads Date.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    // Only this spec's spies: `vi.restoreAllMocks()` would also drop the global
    // console spies `test/setup.ts` installs once.
    for (const spy of spies.splice(0)) spy.mockRestore();
    vi.useRealTimers();
    if (previousAsyncStartup === undefined) {
      delete process.env.PELS_ASYNC_STARTUP;
    } else {
      process.env.PELS_ASYNC_STARTUP = previousAsyncStartup;
    }
  });

  // Serve the whole-home meter through the SDK route the Homey Energy poll reads.
  // The poll fires as soon as `startAppServices` starts it, so a reading is in
  // hand ~1.2 s before the deferred bootstrap fetches a single device.
  const reportHomePower = (): MockInstance => {
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    const getSpy = vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/energy/live') {
        return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: HOME_POWER_W } }] };
      }
      return originalGet(path);
    });
    spies.push(getSpy);
    return getSpy;
  };

  const spyOnDeviceWrites = (): MockInstance => {
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    spies.push(putSpy);
    return putSpy;
  };

  const deviceListReads = (getSpy: MockInstance): number => (
    getSpy.mock.calls.filter(([path]) => path === DEVICE_LIST_PATH).length
  );

  it('builds no plan and writes nothing before the deferred bootstrap, though a meter reading is in hand', async () => {
    await configureOverLimitHome();
    const getSpy = reportHomePower();
    const putSpy = spyOnDeviceWrites();
    const app = createApp();
    const timeline = recordBootTimeline(app);

    await app.onInit();
    await vi.advanceTimersByTimeAsync(DEFERRED_BOOTSTRAP_DELAY_MS - 1);
    await drainPending();

    // The meter reading is in, and with it a request for the `initial` rebuild...
    expect(app.powerTracker.lastPowerW).toBe(HOME_POWER_W);
    // ...which the warmup gate holds, because no device has been fetched yet.
    expect(app.planService.getLatestPlanSnapshot()).toBeNull();
    expect(timeline).toEqual([]);
    expect(putSpy).not.toHaveBeenCalledWith(ONOFF_CAPABILITY_PATH, expect.anything());
    expect(deviceListReads(getSpy)).toBe(0);
    expect(app.snapshotWarmupGate?.isReleased()).toBe(false);
  });

  it('commits the first snapshot to the observer before the warmup gate admits a plan, and plans the real device', async () => {
    await configureOverLimitHome();
    reportHomePower();
    const putSpy = spyOnDeviceWrites();
    const app = createApp();
    const timeline = recordBootTimeline(app);

    await app.onInit();
    await vi.advanceTimersByTimeAsync(DEFERRED_BOOTSTRAP_DELAY_MS);
    // The held meter rebuild and the bootstrap's own rebuild both decide from
    // the committed snapshot, so the over-limit device is shed.
    await drainUntilCalledWith(putSpy, ONOFF_CAPABILITY_PATH, { value: false });
    await drainPending();

    // Strict order: the observer has the snapshot, then the gate opens, then
    // plans are built.
    const firstPlan = timeline.findIndex((entry) => entry.startsWith('plan_built:'));
    expect(timeline.slice(0, Math.max(firstPlan, 0))).toEqual([
      `observer_refreshed:${DEVICE_ID}`,
      'warmup_gate_released:snapshot_ready',
    ]);
    // The meter's own rebuild was held, not dropped: it ran after the gate opened.
    expect(timeline).toEqual(expect.arrayContaining([
      'plan_built:initial',
      'plan_built:startup_snapshot_bootstrap',
    ]));
    expect(latestPlanDeviceIds(app)).toEqual([DEVICE_ID]);
    expect(putSpy).toHaveBeenCalledWith(ONOFF_CAPABILITY_PATH, { value: false });
  });

  it('fetches prices in the background: neither onInit nor the first plan waits for them', async () => {
    await configureOverLimitHome();
    const getSpy = reportHomePower();
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    // Homey Energy's day-ahead route, held open until the spec answers it.
    let answerPriceFetches: () => void = () => undefined;
    const pricesAnswered = new Promise<void>((resolve) => { answerPriceFetches = resolve; });
    const todayKey = getDateKeyInTimeZone(new Date(), TZ);
    const todayStartMs = getDateKeyStartMs(todayKey, TZ);
    const intervals: HomeyEnergyPriceInterval[] = [0.3, 0.2, 0.4].map((value, hour) => ({
      periodStart: new Date(todayStartMs + hour * 3600_000).toISOString(),
      periodEnd: new Date(todayStartMs + (hour + 1) * 3600_000).toISOString(),
      value,
    }));
    const priceFetch = vi.spyOn(mockHomeyInstance.api, '_dynamicElectricityPrices')
      .mockImplementation(async ({ date }) => {
        await pricesAnswered;
        return { interval: 60, pricesPerInterval: date === todayKey ? intervals : [], priceUnit: 'EUR' };
      });
    spies.push(priceFetch);
    const app = createApp();

    let initResolved = false;
    void app.onInit().then(() => { initResolved = true; });
    // No clock advance: boot completes at t=0 with the fetch still unanswered,
    // and the fetch was started by boot itself, not by the deferred bootstrap.
    await drainUntil(() => initResolved);
    expect(priceFetch).toHaveBeenCalled();
    expect(deviceListReads(getSpy)).toBe(0);

    // The deferred bootstrap plans the real device with prices still pending.
    await vi.advanceTimersByTimeAsync(DEFERRED_BOOTSTRAP_DELAY_MS);
    await drainUntil(() => latestPlanDeviceIds(app)?.includes(DEVICE_ID) === true);
    expect(app.priceCoordinator.getCombinedHourlyPrices()).toEqual([]);

    // The background fetch still lands and its prices are stored.
    answerPriceFetches();
    await drainUntil(() => app.priceCoordinator.getCombinedHourlyPrices().length > 0);
  });

  it('tears down inside the deferred window: the bootstrap never runs and no timer is left', async () => {
    await configureOverLimitHome();
    const getSpy = reportHomePower();
    const putSpy = spyOnDeviceWrites();
    const app = createApp();
    const timeline = recordBootTimeline(app);

    await app.onInit();
    await vi.advanceTimersByTimeAsync(DEFERRED_BOOTSTRAP_DELAY_MS / 2);
    expect(deviceListReads(getSpy)).toBe(0);
    expect(app.snapshotWarmupGate?.isReleased()).toBe(false);

    await expect(app.onUninit()).resolves.toBeUndefined();
    // Teardown cancelled the pending bootstrap and released the gate itself,
    // clearing the gate's own 5 s bound with it: not one timer is left.
    expect(vi.getTimerCount()).toBe(0);
    expect(timeline).toEqual(['warmup_gate_released:shutdown']);

    // Run well past the bootstrap delay and the gate's bound.
    await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();

    // The bootstrap never ran: no device fetch, no late failure against the
    // closed stores, and nothing written to a device. Nor did the meter
    // rebuild that was waiting on the gate: the shutdown release skips it
    // rather than letting it plan an empty device set.
    expect(deviceListReads(getSpy)).toBe(0);
    expect(timeline.filter((entry) => entry.startsWith('plan_built:'))).toEqual([]);
    // The plan itself, not only its log line: none was ever published.
    expect(app.planService.getLatestPlanSnapshot()).toBeNull();
    expect(timeline.filter((entry) => entry.startsWith('background_task_failed:'))).toEqual([]);
    expect(timeline.filter((entry) => entry.startsWith('warmup_gate_released:'))).toEqual([
      'warmup_gate_released:shutdown',
    ]);
    expect(putSpy).not.toHaveBeenCalledWith(ONOFF_CAPABILITY_PATH, expect.anything());
  });
});
