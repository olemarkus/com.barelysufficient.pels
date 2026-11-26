// SDK-boundary e2e for a home battery and solar surplus: PELS allocates
// export in priority order, lets the battery store its share, and keeps it
// under PELS control at idle once the surplus ends.
// Nothing internal is mocked: the whole-home net enters through the real Homey
// Energy poll (`manager/energy/live`, negative = exporting), the battery and
// the pump through the device API, and what is asserted is what PELS writes
// back through the SDK (`api.put`) and its structured logs.
//
// The devices are simulated the way real ones behave. The battery ramps its own
// `measure_power` by up to 1 kW a reading: under Homey's claim toward the
// setpoint PELS wrote, and in its own (zero-feed) mode toward holding the
// meter at 0 W, so it stores the export and covers an import. The pump draws
// its 1 kW while on, the house has a 300 W base load, and the meter reads all
// of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps, seedStoredPowerTrackerForTests } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { buildSetpointBatteryDevice } from '../helpers/homeBatteryMock';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  BATTERY_CONTROL_DEVICES,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const BATTERY = 'home-battery';
const PUMP = 'pool-pump';
const PUMP_W = 1000;
const POLL_MS = 10_000;
const BASE_LOAD_W = 300;
/** How far the battery's own power moves in one reading, W. */
const RAMP_W = 1000;
const BATTERY_MAX_W = 2500;

type LoggedEvent = { event?: string };

const writesTo = (put: { mock: { calls: unknown[][] } }, deviceId: string): Array<[string, unknown]> => put.mock.calls
  .filter(([path]) => typeof path === 'string' && path.startsWith(`manager/devices/device/${deviceId}/capability/`))
  .map(([path, body]) => [
    (path as string).slice(`manager/devices/device/${deviceId}/capability/`.length),
    (body as { value?: unknown } | undefined)?.value,
  ]);

const setpointsSent = (put: { mock: { calls: unknown[][] } }): number[] => writesTo(put, BATTERY)
  .filter(([capability]) => capability === 'target_power')
  .map(([, value]) => value as number);

const buildPump = async (): Promise<MockDevice> => {
  const pump = new MockDevice(PUMP, 'Pool pump', ['onoff', 'measure_power', 'meter_power'], 'socket');
  pump.setSettings({ load: PUMP_W });
  await pump.setCapabilityValue('onoff', false);
  await pump.setCapabilityValue('measure_power', 0);
  await pump.setCapabilityValue('meter_power', 100);
  return pump;
};

const seedSettings = (surplusWilling: boolean): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  // Capacity never binds here: only the surplus moves anything.
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [PUMP]: true });
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [PUMP]: true });
  // "Run on solar surplus" on the pump, as the settings UI writes it.
  mockHomeyInstance.settings.set('price_optimization_settings', {
    [PUMP]: { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling, surplusDelta: 0 },
  });
  // A home that has exported before, which is what makes the pool reachable.
  seedStoredPowerTrackerForTests({ exportBuckets: { '2026-10-04T11:00:00.000Z': 4 } });
};

type Home = {
  battery: MockDevice;
  pump: MockDevice;
  put: ReturnType<typeof vi.spyOn>;
  events: LoggedEvent[];
  /** The solar production now, W. */
  setSolarW: (watts: number) => void;
  /** The whole-home net the meter reads now, W. */
  netW: () => number;
  /** Advance poll by poll, letting the battery and the pump follow what PELS wrote. */
  advance: (polls: number) => Promise<void>;
};

const readW = (device: MockDevice): number => {
  const value = device.getActualCapabilityValue('measure_power');
  return typeof value === 'number' ? value : 0;
};

/** Its own mode: self-consumption with room/full storage, or autonomous export. */
type BatteryCharge = 'room' | 'full' | 'exporting';

const startHome = async (solarW: number, surplusWilling = true, charge: BatteryCharge = 'room'): Promise<Home> => {
  const battery = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed', stepW: 5 });
  if (charge === 'exporting') {
    battery.setActualCapabilityValue('target_power_mode', 'trade_mode');
    battery.setActualCapabilityValue('measure_power', -BATTERY_MAX_W);
    mockHomeyInstance.settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
  }
  const pump = await buildPump();
  setMockDrivers({ driverA: new MockDriver('driverA', [pump, battery]) });
  seedSettings(surplusWilling);
  let solar = solarW;
  const netW = (): number => BASE_LOAD_W - solar + readW(battery) + readW(pump);
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: netW() } }] };
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
  /** Where the battery heads: PELS's setpoint under the claim, else holding the meter at 0 W. */
  const batteryTargetW = (): number => {
    if (battery.getActualCapabilityValue('target_power_mode') === 'homey') {
      const target = battery.getActualCapabilityValue('target_power');
      return typeof target === 'number' ? target : 0;
    }
    if (charge === 'exporting') return -BATTERY_MAX_W;
    const chargeLimitW = charge === 'full' ? 0 : BATTERY_MAX_W;
    return Math.max(-BATTERY_MAX_W, Math.min(chargeLimitW, readW(battery) - netW()));
  };
  const follow = (): void => {
    let changed = false;
    const fromW = readW(battery);
    const toW = fromW + Math.max(-RAMP_W, Math.min(RAMP_W, batteryTargetW() - fromW));
    if (toW !== fromW) {
      battery.setActualCapabilityValue('measure_power', toW);
      changed = true;
    }
    const pumpW = pump.getActualCapabilityValue('onoff') === true ? PUMP_W : 0;
    if (pumpW !== readW(pump)) {
      pump.setActualCapabilityValue('measure_power', pumpW);
      changed = true;
    }
    // This spec leaves the live feed unconnected; publish the changed readings
    // through the same refresh seam the settings UI uses.
    if (changed) mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
  };
  return {
    battery,
    pump,
    put,
    events,
    setSolarW: (watts) => { solar = watts; },
    netW,
    advance: async (polls) => {
      // The devices answer half a reading after the meter, as real ones lag.
      for (let poll = 0; poll < polls; poll += 1) {
        await vi.advanceTimersByTimeAsync(POLL_MS / 2);
        await drainPending();
        follow();
        await vi.advanceTimersByTimeAsync(POLL_MS / 2);
        await drainPending();
      }
    },
  };
};

describe('home battery charging from surplus (SDK-boundary e2e)', () => {
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

  it('keeps autonomous battery export out of solar surplus while Managed is off', async () => {
    const home = await startHome(0, true, 'exporting');
    await home.advance(12);
    expect(home.netW()).toBeLessThan(-PUMP_W);
    expect(home.pump.getActualCapabilityValue('onoff')).toBe(false);

    await home.advance(24);
    expect(writesTo(home.put, BATTERY)).toEqual([]);
    expect(writesTo(home.put, PUMP).filter(([capability, value]) => capability === 'onoff' && value === true)).toEqual([]);
    expect(home.pump.getActualCapabilityValue('onoff')).toBe(false);

    // Real solar remains usable alongside the same unmanaged battery export.
    home.setSolarW(4000);
    await home.advance(24);
    expect(home.pump.getActualCapabilityValue('onoff')).toBe(true);
    expect(writesTo(home.put, BATTERY)).toEqual([]);
  });

  it('keeps unavailable unmanaged battery export out of solar surplus', async () => {
    const home = await startHome(0, true, 'exporting');
    await home.advance(12);
    home.battery.setAvailable(false);
    mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
    await home.advance(24);

    expect(home.netW()).toBeLessThan(-PUMP_W);
    expect(writesTo(home.put, PUMP)).not.toContainEqual(['onoff', true]);
    expect(writesTo(home.put, BATTERY)).toEqual([]);
  });

  it('gives the pump its share before charging the battery and keeps control when solar fades', async () => {
    // 2.6 kW of solar on a 300 W base load leaves 2.3 kW to share.
    const home = await startHome(2600);
    await home.advance(44);
    // The pump runs on its 1 kW; the battery, under Homey's claim, stores the
    // rest less the margin PELS leaves, so almost nothing is exported.
    expect(writesTo(home.put, PUMP)).toContainEqual(['onoff', true]);
    expect(writesTo(home.put, BATTERY)[0]).toEqual(['target_power_mode', 'homey']);
    const setpoints = setpointsSent(home.put);
    expect(setpoints.some((value) => value > 0)).toBe(true);
    expect(setpoints.every((value) => value >= 0)).toBe(true);
    expect(readW(home.battery)).toBeGreaterThan(1000);
    expect(home.netW()).toBeLessThanOrEqual(0);
    expect(home.netW()).toBeGreaterThanOrEqual(-400);
    expect(home.events.some((event) => event.event === 'battery_storage_setpoint_confirmed')).toBe(true);
    // When a cloud takes the solar, PELS stops charging and keeps control.
    const before = setpointsSent(home.put).length;
    home.setSolarW(0);
    await home.advance(2);
    expect(setpointsSent(home.put).slice(before)).toContain(0);

    await home.advance(14);
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('homey');
    expect(readW(home.battery)).toBe(0);
    expect(home.pump.getActualCapabilityValue('onoff')).toBe(false);
    expect(writesTo(home.put, BATTERY).filter(([capability]) => capability === 'target_power_mode'))
      .toEqual([['target_power_mode', 'homey']]);
  });

  it('turns the pump off when the solar that sustains it falls, while an unmanaged battery covers the gap', async () => {
    mockHomeyInstance.settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    // A full battery exports the 1.4 kW of spare solar, and the pump starts on it.
    const home = await startHome(1700, true, 'full');
    await home.advance(15);
    expect(writesTo(home.put, PUMP)).toContainEqual(['onoff', true]);
    expect(readW(home.pump)).toBe(PUMP_W);

    // With 0.6 kW to spare, the battery's zero-feed mode supplies the other 0.4 kW.
    home.setSolarW(900);
    await home.advance(2);
    expect(readW(home.battery)).toBeLessThan(0);
    expect(home.netW()).toBe(0);

    await home.advance(12);
    expect(writesTo(home.put, PUMP).at(-1)).toEqual(['onoff', false]);
    expect(readW(home.battery)).toBe(0);
    expect(writesTo(home.put, BATTERY)).toEqual([]);
  });

  it('reserves surplus for a battery ranked above the pump before the pump starts', async () => {
    const home = await startHome(2600);
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { [BATTERY]: 1, [PUMP]: 2 } });
    await home.advance(44);

    expect(readW(home.battery)).toBeGreaterThan(2000);
    expect(readW(home.battery)).toBeLessThanOrEqual(2300);
    expect(home.pump.getActualCapabilityValue('onoff')).toBe(false);
    expect(writesTo(home.put, PUMP)).not.toContainEqual(['onoff', true]);
  });

  it('charges from measured surplus with price planning off and no other device using surplus', async () => {
    const home = await startHome(2600, false);
    await home.advance(20);

    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('homey');
    expect(readW(home.battery)).toBeGreaterThan(0);
    const spareW = 2600 - BASE_LOAD_W - readW(home.pump);
    expect(readW(home.battery)).toBeLessThanOrEqual(spareW);
    expect(readW(home.battery)).toBeGreaterThan(spareW - 300);
  });
});
