// SDK-boundary e2e for following this month's peak (`capacity_follow_month_peak`).
//
// THE RULE THIS TEST ENFORCES: in quarter mode with the switch on, once a
// completed quarter this month is above the hard cap, live control holds that
// peak instead, so a device limited under the configured hard cap is resumed up
// to it. At the month rollover the peak no longer counts and the configured hard
// cap holds again. With the switch off, the configured hard cap holds throughout.
//
// Nothing internal is mocked. Power enters through the real Homey Energy poll
// (`manager/energy/live`), the clock is the faked `Date`, and the only thing
// asserted is what PELS writes back through the SDK (`api.put`). Time is stepped
// one 10 s poll at a time, as in `capacityQuarterPace.e2e.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_FOLLOW_MONTH_PEAK,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';

const MIN_MS = 60 * 1000;
const POLL_MS = 10_000;
const HEATER_W = 6000;
// 23:30 local on the last day of January (Europe/Oslo, the mock hub's zone):
// the quarter that sets the peak, the quarter after it, and the month rollover
// at local midnight.
const PEAK_QUARTER_START_MS = Date.UTC(2026, 0, 31, 22, 30, 0);
const MONTH_ROLLOVER_MS = Date.UTC(2026, 0, 31, 23, 0, 0);

const flushDetached = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

type OnoffWrite = { atMs: number; value: boolean };

const runScenario = async (followMonthPeak: boolean) => {
  let nowMs = PEAK_QUARTER_START_MS - 2 * MIN_MS;
  vi.setSystemTime(nowMs);

  const device = new MockDevice('heater', 'Water heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', HEATER_W);
  await device.setCapabilityValue('meter_power', 100);
  setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_PERIOD_MINUTES, 15);
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 5);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.2);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(CAPACITY_FOLLOW_MONTH_PEAK, followMonthPeak);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { heater: true });
  mockHomeyInstance.settings.set('managed_devices', { heater: true });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { heater: 1 } });
  mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { heater: { action: 'turn_off' } });

  // Load PELS does not manage: 8 kW until the peak quarter ends, then 0.5 kW.
  let backgroundW = 8000;
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      const on = (await device.getCapabilityValue('onoff')) === true;
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: backgroundW + (on ? HEATER_W : 0) } }] };
    }
    return originalGet(path);
  });
  const writes: OnoffWrite[] = [];
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path: string, body: unknown) => {
    if (path === 'manager/devices/device/heater/capability/onoff') {
      writes.push({ atMs: Date.now(), value: (body as { value?: unknown } | undefined)?.value === true });
    }
    return originalPut(path, body);
  });

  const app = createApp();
  await app.onInit();

  const stepTo = async (targetMs: number): Promise<void> => {
    while (nowMs < targetMs) {
      const delta = Math.min(POLL_MS, targetMs - nowMs);
      await vi.advanceTimersByTimeAsync(delta);
      nowMs += delta;
      await flushDetached();
    }
  };
  const lastWriteBefore = (atMs: number): boolean | undefined => (
    writes.filter((write) => write.atMs < atMs).at(-1)?.value
  );

  // A partial quarter, then a full quarter at about 8 kW: the heater is limited
  // under the 5 kW hard cap, and the full quarter sets this month's peak.
  await stepTo(PEAK_QUARTER_START_MS + 15 * MIN_MS);
  const limitedDuringPeakQuarter = lastWriteBefore(nowMs);
  backgroundW = 500;
  // The next quarter: the heater with the background is 6.5 kW.
  await stepTo(MONTH_ROLLOVER_MS - 10_000);
  await flushDetached(20);
  const beforeRollover = lastWriteBefore(nowMs);
  // The settings page's running scalars keep the configured hard cap; the plan
  // says which cap live control holds.
  const host = app as unknown as {
    getCapacityScalars: () => { limitKw: number };
    getLatestPlanSnapshotForUi: () => { meta?: { hardCapLimitKw: number; hardCapSource: string } } | null;
  };
  const scalarLimitKw = host.getCapacityScalars().limitKw;
  const planMeta = host.getLatestPlanSnapshotForUi()?.meta;
  // The first minutes of February.
  await stepTo(MONTH_ROLLOVER_MS + 3 * MIN_MS);
  await flushDetached(20);
  const afterRollover = lastWriteBefore(nowMs + 1);
  return {
    limitedDuringPeakQuarter, beforeRollover, afterRollover, scalarLimitKw,
    planHardCap: { kw: planMeta?.hardCapLimitKw, source: planMeta?.hardCapSource },
  };
};

describe('Follow this month\'s peak (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resumes a limited device up to this month\'s peak, and holds the hard cap again from the next month', async () => {
    const result = await runScenario(true);

    expect(result.limitedDuringPeakQuarter).toBe(false);
    expect(result.beforeRollover).toBe(true);
    expect(result.afterRollover).toBe(false);
    expect(result.scalarLimitKw).toBe(5);
    expect(result.planHardCap).toEqual({ kw: 8, source: 'month_peak' });
  });

  it('holds the configured hard cap with the switch off', async () => {
    const result = await runScenario(false);

    expect(result.limitedDuringPeakQuarter).toBe(false);
    expect(result.beforeRollover).toBe(false);
    expect(result.afterRollover).toBe(false);
    expect(result.planHardCap).toEqual({ kw: 5, source: 'configured' });
  });
});
