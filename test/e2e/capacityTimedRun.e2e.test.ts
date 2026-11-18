// SDK-boundary e2e for the capacity TIMED RUN (lib/plan/capacityTimedRun.ts).
//
// Nothing internal is mocked. Power enters through the Homey Energy poll
// (`manager/energy/live`), drives the capacity guard, planner and executor, and
// only what PELS writes back through the SDK is observed. The clock is faked, so
// the pace, the drain and the timed run's stop are real.
//
// THE HOUSE (the 2026-11-15 SHS lab, from a prod night hour): 3.0 kW of background
// load and five on/off heaters, 0.5 / 0.78 / 0.8 / 1.1 / 1.4 kW in that priority
// order, against a 5 kW limit with a 0.3 kW margin. With the two smallest heaters
// on the house draws 4.28 kW: a 0.42 kW gap that only the 0.8 kW heater can fill,
// for part of the hour. Without the timed run it runs from :35 to :51 and the hour
// ends at 4.49 kWh; with it, from about :26 to :51, for about 4.61 kWh, and on a
// noisy background from about :24, for about 4.63 kWh.
//
// FEEDBACK ENERGY MODEL: the meter reports the background plus every heater whose
// `onoff` is on, so a command PELS writes shows on the next poll. Time moves one
// poll at a time with the detached poll, plan and executor chain flushed after
// each, as in `capacityEndOfHourDrain.e2e.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';

const MIN_MS = 60_000;
const POLL_MS = 10_000;
const BACKGROUND_W = 3000;
const HEATERS = [
  { id: 'h050', watts: 500, priority: 1 },
  { id: 'h078', watts: 780, priority: 2 },
  { id: 'h080', watts: 800, priority: 3 },
  { id: 'h110', watts: 1100, priority: 4 },
  { id: 'h140', watts: 1400, priority: 5 },
];

const onoffPath = (id: string): string => `manager/devices/device/${id}/capability/onoff`;

const flushDetached = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

/**
 * One measured hour of the lab house, booted two minutes before it so the hour
 * is sampled from `:00`. `backgroundW` gives the background load at each poll.
 */
async function simulateLabHour(backgroundW: (poll: number) => number): Promise<{
  switches: { minute: number; on: boolean }[];
  hourKWh: number;
  putSpy: ReturnType<typeof vi.spyOn>;
}> {
  const hourStartMs = Date.UTC(2026, 0, 15, 12, 0, 0);
  // Boot in the previous hour so the measured hour is sampled from :00.
  let nowMs = hourStartMs - 2 * MIN_MS;
  vi.setSystemTime(nowMs);

  const devices = new Map<string, MockDevice>();
  for (const heater of HEATERS) {
    const device = new MockDevice(heater.id, `Heater ${heater.watts} W`, ['onoff', 'measure_power', 'meter_power'], 'heater');
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', heater.watts);
    await device.setCapabilityValue('meter_power', 100);
    devices.set(heater.id, device);
  }
  setMockDrivers({ driverA: new MockDriver('driverA', [...devices.values()]) });
  const flags = Object.fromEntries(HEATERS.map(({ id }) => [id, true]));
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 5);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.3);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', flags);
  mockHomeyInstance.settings.set('managed_devices', flags);
  mockHomeyInstance.settings.set('capacity_priorities', {
    Home: Object.fromEntries(HEATERS.map(({ id, priority }) => [id, priority])),
  });
  // The lab's heaters have their draw entered on the device page.
  mockHomeyInstance.settings.set('device_expected_power_overrides', Object.fromEntries(
    HEATERS.map(({ id, watts }) => [id, { kw: watts / 1000, ts: nowMs }]),
  ));
  mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, Object.fromEntries(HEATERS.map(({ id }) => [id, { action: 'turn_off' }])));

  // The heater mocks report their nameplate while on and nothing while off.
  const isOn = async (id: string): Promise<boolean> => (await devices.get(id)!.getCapabilityValue('onoff')) === true;
  const houseW = async (): Promise<number> => {
    let total = backgroundW(poll);
    for (const { id, watts } of HEATERS) if (await isOn(id)) total += watts;
    return total;
  };
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: await houseW() } }] };
    }
    return originalGet(path);
  });
  const syncDrawToState = async (): Promise<void> => {
    for (const { id, watts } of HEATERS) {
      const device = devices.get(id)!;
      await device.setCapabilityValue('measure_power', (await isOn(id)) ? watts : 0);
    }
  };
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

  const app = createApp();
  await app.onInit();

  // The 0.8 kW heater's switches inside the measured hour, by minute.
  const switches: { minute: number; on: boolean }[] = [];
  let hourKWh = 0;
  let previousOn = await isOn('h080');
  let poll = 0;
  while (nowMs < hourStartMs + 60 * MIN_MS) {
    if (nowMs >= hourStartMs) hourKWh += (await houseW()) / 1000 * (POLL_MS / 3_600_000);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    nowMs += POLL_MS;
    await flushDetached();
    await syncDrawToState();
    const on = await isOn('h080');
    if (on !== previousOn && nowMs >= hourStartMs) switches.push({ minute: (nowMs - hourStartMs) / MIN_MS, on });
    previousOn = on;
    poll += 1;
  }
  return { switches, hourKWh, putSpy };
}

describe('Capacity timed run of an on/off heater (SDK-boundary e2e)', () => {
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

  it('runs the marginal heater for part of the hour, stops it before the drain, and keeps the hard cap', async () => {
    const { switches, hourKWh, putSpy } = await simulateLabHour(() => BACKGROUND_W);

    // The heater runs once: it starts once the hour's unused energy lets its draw,
    // with its restore buffer, pass the hard-cap rule (about :26, against :35
    // without the timed run), and its run ends at :50, where the drain winds it
    // down, so the next hour starts at the house's base load.
    expect(switches.map(({ on }) => on)).toEqual([true, false]);
    const [started, stopped] = switches;
    expect(started.minute).toBeLessThan(30);
    expect(stopped.minute).toBeLessThanOrEqual(52);
    // More of the hour used than the 4.49 kWh without it, still under the 4.7 kWh
    // target and so under the 5 kWh hard cap.
    expect(hourKWh).toBeGreaterThan(4.6);
    expect(hourKWh).toBeLessThanOrEqual(4.7);
    // The big heaters never came on: the timed run never reached past the margin.
    expect(putSpy.mock.calls.some(([path, body]: unknown[]) => (
      (path === onoffPath('h110') || path === onoffPath('h140')) && (body as { value?: unknown }).value === true
    ))).toBe(false);
  });

  it('keeps a heater it started while the background moves by a few tens of watts', async () => {
    // A metered background is never flat: about ±0.1 kW of drift and poll-to-poll
    // noise, as on the lab's real trace. A start that only just passed the
    // hard-cap rule was cut again ten seconds later and restarted at :39, and
    // the hour fell to 4.44 kWh, below the 4.49 kWh without any timed run.
    const { switches, hourKWh } = await simulateLabHour((poll) => (
      BACKGROUND_W + Math.round(70 * Math.sin(poll * 1.9) + 45 * Math.sin(poll / 9))
    ));
    expect(switches.map(({ on }) => on)).toEqual([true, false]);
    expect(hourKWh).toBeGreaterThan(4.6);
    expect(hourKWh).toBeLessThanOrEqual(4.7);
  });
});
