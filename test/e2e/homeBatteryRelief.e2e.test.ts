// SDK-boundary e2e for home-battery relief: over the pace, PELS discharges the
// battery before it sheds the owner's devices, verifies the battery follows,
// and hands it back when it is not needed, not responding, or the meter goes
// silent. Nothing internal is mocked: the whole-home net enters through the
// real Homey Energy poll (`manager/energy/live`), the battery and the heater
// through the device API, and what is asserted is what PELS writes back
// through the SDK (`api.put`) and its structured logs.
//
// A battery that follows is simulated the way a real one behaves: once it is
// under Homey's claim, its own `measure_power` moves to the setpoint PELS
// wrote, and the house's net drops by that much.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
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

const seedSettings = (): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  // A 3 kW limit five minutes into the hour paces the house at ~3.3 kW.
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 3);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
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

const startHome = async (params: { houseW: number; following: boolean }): Promise<Home> => {
  const battery = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed', stepW: 5 });
  setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater(), battery]) });
  seedSettings();
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
    if (typeof target !== 'number' || target === batteryW()) return;
    battery.setActualCapabilityValue('measure_power', target);
    // The live feed is off in tests; publish the changed reading through the
    // same refresh seam the settings UI uses.
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

describe('home battery relief (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12, 5, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('claims the battery and discharges it over the pace instead of shedding the heater', async () => {
    const home = await startHome({ houseW: 4500, following: true });
    await home.advance(12);

    const batteryWrites = writesTo(home.put, BATTERY);
    expect(batteryWrites[0]).toEqual(['target_power_mode', 'homey']);
    const setpoints = batteryWrites.filter(([capability]) => capability === 'target_power').map(([, value]) => value);
    expect(setpoints.length).toBeGreaterThan(0);
    expect(setpoints.every((value) => typeof value === 'number' && value < 0)).toBe(true);
    expect(home.battery.getActualCapabilityValue('measure_power')).toBeLessThan(0);
    expect(heaterTurnedOff(home.put)).toBe(false);
    expect(home.events.some((event) => event.event === 'battery_storage_setpoint_confirmed')).toBe(true);
  });

  it('reports a battery that does not follow as not responding, sheds the heater and hands the battery back', async () => {
    const home = await startHome({ houseW: 4500, following: false });
    await home.advance(2);
    // The setpoint went out, and while it is credited nothing is shed.
    expect(writesTo(home.put, BATTERY).some(([capability]) => capability === 'target_power')).toBe(true);
    expect(heaterTurnedOff(home.put)).toBe(false);

    // Past the credit window the heater is shed; the battery, which has
    // reported nothing since the setpoint, gets the longest wait before it is judged.
    await home.advance(3);
    expect(heaterTurnedOff(home.put)).toBe(true);
    expect(home.events.some((event) => event.event === 'battery_control_not_responding')).toBe(false);

    await home.advance(28);

    expect(home.events.find((event) => event.event === 'battery_control_not_responding'))
      .toMatchObject({ deviceId: BATTERY });
    expect(writesTo(home.put, BATTERY).slice(-2)).toEqual([['target_power', 0], ['target_power_mode', 'anti_feed']]);
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
  });

  it('hands the battery back when the meter goes silent', async () => {
    const home = await startHome({ houseW: 4500, following: true });
    await home.advance(6);
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('homey');

    home.setMeterReporting(false);
    await home.advance(66);

    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
    expect(home.events.find((event) => event.event === 'battery_storage_released'))
      .toMatchObject({ deviceId: BATTERY, reason: 'meter_silent' });
  });

  it('hands the battery back after ten minutes with nothing to do', async () => {
    const home = await startHome({ houseW: 4500, following: true });
    await home.advance(6);
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('homey');

    // The heater's need passes: the house falls well under the pace, the
    // setpoint steps back to 0 W, and ten minutes later the battery goes back.
    home.setHouseW(1000);
    await home.advance(80);

    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
    expect(home.events.find((event) => event.event === 'battery_storage_released'))
      .toMatchObject({ deviceId: BATTERY, reason: 'idle' });
  });
});
