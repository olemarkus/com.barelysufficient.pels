// SDK-boundary e2e: a home whose battery holds the limit plans the same in
// Simulation mode as under live control. Harness as in
// `homeBatteryRelief.e2e.test.ts`: the whole-home net enters through Homey's
// live energy poll, and a battery under Homey's claim follows its setpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLatestPlanSnapshotForTests, mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver,
} from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { buildSetpointBatteryDevice } from '../helpers/homeBatteryMock';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';

const BATTERY = 'home-battery';
const HEATER = 'heater';
const POLL_MS = 10_000;

type LoggedEvent = { event?: string; deviceId?: string; reason?: string };

const writesTo = (put: { mock: { calls: unknown[][] } }, deviceId: string): Array<[string, unknown]> => put.mock.calls
  .filter(([path]) => typeof path === 'string' && path.startsWith(`manager/devices/device/${deviceId}/capability/`))
  .map(([path, body]) => [
    (path as string).slice(`manager/devices/device/${deviceId}/capability/`.length),
    (body as { value?: unknown } | undefined)?.value,
  ]);

const heaterTurnedOff = (put: { mock: { calls: unknown[][] } }): boolean => writesTo(put, HEATER)
  .some(([capability, value]) => capability === 'onoff' && value === false);

const buildHeater = async (): Promise<MockDevice> => {
  const heater = new MockDevice(HEATER, 'Heater', ['onoff', 'measure_power'], 'socket');
  await heater.setCapabilityValue('onoff', true);
  await heater.setCapabilityValue('measure_power', 2000);
  return heater;
};

const seedSettings = (simulating: boolean): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  // A 3 kW limit five minutes into the hour paces the house at ~3.3 kW.
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 3);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, simulating);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [HEATER]: true });
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [HEATER]: true });
  mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { [HEATER]: { action: 'turn_off' } });
};

type Home = {
  battery: MockDevice;
  put: ReturnType<typeof vi.spyOn>;
  events: LoggedEvent[];
  /** The house's net draw before the battery, W. */
  setHouseW: (watts: number) => void;
  setMeterReporting: (reporting: boolean) => void;
  /** Advance poll by poll, letting a following battery track its setpoint. */
  advance: (polls: number) => Promise<void>;
};

const startHome = async (params: { houseW: number; following: boolean; simulating: boolean }): Promise<Home> => {
  const battery = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed', stepW: 5 });
  setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater(), battery]) });
  seedSettings(params.simulating);
  let houseW = params.houseW;
  let meterReporting = true;
  const batteryW = (): number => {
    const value = battery.getActualCapabilityValue('measure_power');
    return typeof value === 'number' ? value : 0;
  };
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return {
        items: meterReporting
          ? [{ type: 'cumulative', id: 'meter-main', values: { W: houseW + batteryW() } }]
          : [],
      };
    }
    return originalGet(path);
  });
  const put = vi.spyOn(mockHomeyInstance.api, 'put');
  const app = createApp();
  const events: LoggedEvent[] = [];
  const log = app.log.bind(app);
  app.log = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try {
        const parsed = JSON.parse(arg) as LoggedEvent;
        if (parsed.event?.startsWith('battery_')) events.push(parsed);
      } catch { /* not a structured line */ }
    }
    return log(...args);
  };
  await app.onInit();
  const follow = (): void => {
    if (!params.following || battery.getActualCapabilityValue('target_power_mode') !== 'homey') return;
    const target = battery.getActualCapabilityValue('target_power');
    if (typeof target !== 'number') return;
    // A battery under claim reports its power every poll, as a real one does.
    battery.setActualCapabilityValue('measure_power', target);
    // This spec leaves the live feed unconnected; publish the changed reading
    // through the same refresh seam the settings UI uses.
    mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
  };
  return {
    battery,
    put,
    events,
    setHouseW: (watts) => { houseW = watts; },
    setMeterReporting: (reporting) => { meterReporting = reporting; },
    advance: async (polls) => {
      for (let poll = 0; poll < polls; poll += 1) {
        await vi.advanceTimersByTimeAsync(POLL_MS);
        await drainPending();
        follow();
      }
    },
  };
};

const planned = (): string => {
  const devices = (getLatestPlanSnapshotForTests()?.devices ?? []) as Array<{
    id: string; plannedState: string; storageHold?: { kind: string };
  }>;
  const heater = devices.find((device) => device.id === HEATER);
  const battery = devices.find((device) => device.id === BATTERY);
  return `heater:${heater?.plannedState ?? '?'} battery:${battery?.storageHold?.kind ?? '?'}`;
};

const run = async (simulating: boolean, polls: number): Promise<{ timeline: string[]; home: Home }> => {
  const home = await startHome({ houseW: 4500, following: true, simulating });
  const timeline: string[] = [];
  for (let poll = 0; poll < polls; poll += 1) {
    await home.advance(1);
    timeline.push(planned());
  }
  return { timeline, home };
};

describe('a battery home in Simulation mode', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12, 5, 0));
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Simulation used to leave the battery out (PELS may not claim it while
  // simulating) and shed the heater live control keeps on. It now plans the
  // battery as live control would, crediting the hold it cannot send.
  it('plans the battery holding the limit, reading by reading, as live control does', async () => {
    const polls = 330; // To the end of the hour.
    const live = await run(false, polls);
    await cleanupApps();
    vi.restoreAllMocks();
    resetMockHomey();
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12, 5, 0));
    const simulated = await run(true, polls);

    expect(live.timeline.every((state) => state === 'heater:keep battery:relief')).toBe(true);
    expect(simulated.timeline).toEqual(live.timeline);
    expect(writesTo(simulated.home.put, BATTERY)).toEqual([]);
    expect(writesTo(simulated.home.put, HEATER)).toEqual([]);
  });

  it('claims the battery and keeps the heater on once simulation is switched off', async () => {
    const { home } = await run(true, 12);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    await drainPending();
    await home.advance(6);

    const batteryWrites = writesTo(home.put, BATTERY);
    expect(batteryWrites[0]).toEqual(['target_power_mode', 'homey']);
    expect(batteryWrites.some(([capability, value]) => capability === 'target_power' && (value as number) < 0)).toBe(true);
    expect(heaterTurnedOff(home.put)).toBe(false);
  });
});
