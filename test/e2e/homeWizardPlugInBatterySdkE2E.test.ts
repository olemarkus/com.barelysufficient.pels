// SDK-boundary e2e for HomeWizard Plug-In Batteries, by the homes that own
// them: a P1 meter that steers a group of batteries by one mode. Nothing
// internal is mocked: the whole-home net enters through Homey Energy's live
// report for the P1, the P1 and the batteries through the device API, the
// settings the UI writes through Homey settings, and what is asserted is what
// the device list route serves (`/ui_devices`) and what PELS writes back
// through the SDK (`api.put`).
//
// A group that follows is simulated the way the firmware behaves: in each
// mode it holds the P1 at zero within its limits, so its power covers the
// house's import (discharge), takes the export (charge from surplus), sits
// still (standby), or charges at full power (to full).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { connectLiveFeed, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import {
  BATTERY_CONTROL_DEVICES,
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const P1 = '3f1c8a52-6b7e-4d1a-9c2e-5a0b7d4e8f11';
const GROUP = `${P1}~battery_group`;
const MODE = 'battery_group_charge_mode';
const MODES = ['zero', 'zero_charge_only', 'zero_discharge_only', 'standby', 'to_full', 'predictive'];
const POLL_MS = 10_000;
const MODE_WRITE = `manager/devices/device/${P1}/capability/${MODE}`;

const quiet = { emitCapabilityEvent: false, emitDeviceUpdate: false };

const GROUP_CAPABILITIES = [
  'measure_power.battery_group_power_w', 'measure_power.battery_group_max_consumption_w',
  'measure_power.battery_group_max_production_w', 'battery_group_total_capacity_kwh',
  'battery_group_average_soc', MODE,
];

/** The P1, with its battery group when `batteries` > 0, as HomeWizard 3.20.3 publishes it. */
const buildP1 = (batteries: number, mode = 'zero', groupLimitW = 800): MockDevice => {
  const group = batteries > 0 ? [
    'measure_power.battery_group_power_w', 'measure_power.battery_group_max_consumption_w',
    'measure_power.battery_group_max_production_w', 'battery_group_total_capacity_kwh',
    'battery_group_average_soc', MODE,
  ] : [];
  const p1 = new MockDevice(P1, 'P1 meter', ['measure_power', ...group], 'sensor');
  p1.setDriverIdentity({ driverId: 'homey:app:com.homewizard:energy_v2' });
  p1.setActualCapabilityValue('measure_power', 0, quiet);
  if (batteries === 0) return p1;
  p1.setCapabilityMetadata(MODE, { setable: true, values: MODES.map((id) => ({ id })) });
  // The firmware's group limit: often 800 W, one battery's, however many there are.
  p1.setActualCapabilityValue('measure_power.battery_group_max_consumption_w', groupLimitW, quiet);
  p1.setActualCapabilityValue('measure_power.battery_group_max_production_w', groupLimitW, quiet);
  p1.setActualCapabilityValue('battery_group_total_capacity_kwh', 2.7 * batteries, quiet);
  p1.setActualCapabilityValue('battery_group_average_soc', 60, quiet);
  p1.setActualCapabilityValue('measure_power.battery_group_power_w', 0, quiet);
  p1.setActualCapabilityValue(MODE, mode, quiet);
  return p1;
};

const buildPlugInBattery = (id: string): MockDevice => {
  const battery = new MockDevice(id, 'Plug-In Battery', ['measure_battery', 'measure_power', 'target_power_mode'], 'battery');
  battery.setDriverIdentity({ driverId: 'homey:app:com.homewizard:plugin_battery' });
  battery.setCapabilityMetadata('target_power_mode', { setable: true, values: [{ id: 'device' }] });
  battery.setActualCapabilityValue('measure_battery', 60, quiet);
  battery.setActualCapabilityValue('measure_power', 0, quiet);
  battery.setActualCapabilityValue('target_power_mode', 'device', quiet);
  return battery;
};

/** The group's power in a mode, W: it holds the P1 at zero within its limit, or charges at full power. */
const followedPowerW = (mode: unknown, houseW: number, limitW: number): number => {
  switch (mode) {
    case 'zero_discharge_only': return -Math.min(limitW, Math.max(0, houseW));
    case 'zero_charge_only': return Math.min(limitW, Math.max(0, -houseW));
    case 'to_full': return limitW;
    case 'zero': return Math.max(-limitW, Math.min(limitW, -houseW));
    default: return 0;
  }
};

type Home = {
  p1: MockDevice;
  put: ReturnType<typeof vi.spyOn>;
  /** The house's own net draw without the batteries, W: negative exports. */
  setHouseW: (watts: number) => void;
  advance: (polls: number) => Promise<void>;
  modeWrites: () => unknown[];
  /** Stop the app and start a fresh one over the same settings and devices, as an app restart or reinstall does. */
  restart: () => Promise<void>;
  /** Ask PELS to read the devices again, as the settings UI's refresh does. */
  refreshDevices: () => void;
};

const startHome = async (params: {
  country: string; batteries: number; houseW: number; settings?: Record<string, unknown>; mode?: string;
  /** Also a heater on a smart plug, as most homes list other devices beside the meter. */
  heater?: boolean;
  /** The group's charge and discharge limit the P1 reports, W. */
  groupLimitW?: number;
}): Promise<Home> => {
  const p1 = buildP1(params.batteries, params.mode, params.groupLimitW);
  const batteries = Array.from({ length: params.batteries }, (_, index) => buildPlugInBattery(`battery-${index + 1}`));
  const others: MockDevice[] = [];
  if (params.heater === true) {
    const heater = new MockDevice('heater', 'Heater', ['onoff', 'measure_power'], 'socket');
    heater.setActualCapabilityValue('onoff', true, quiet);
    heater.setActualCapabilityValue('measure_power', 0, quiet);
    others.push(heater);
  }
  setMockDrivers({ homewizard: new MockDriver('homewizard', [p1, ...batteries, ...others]) });
  for (const [key, value] of Object.entries(params.settings ?? {})) mockHomeyInstance.settings.set(key, value);
  let houseW = params.houseW;
  const groupW = (): number => {
    const value = p1.getActualCapabilityValue('measure_power.battery_group_power_w');
    return typeof value === 'number' ? value : 0;
  };
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/system') return { country: params.country };
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: P1, values: { W: houseW + groupW() } }] };
    }
    return originalGet(path);
  });
  const put = vi.spyOn(mockHomeyInstance.api, 'put');
  await createApp().onInit();
  const follow = (): void => {
    if (params.batteries === 0) return;
    const targetW = followedPowerW(p1.getActualCapabilityValue(MODE), houseW, params.groupLimitW ?? 800);
    if (targetW !== groupW()) p1.setActualCapabilityValue('measure_power.battery_group_power_w', targetW);
  };
  return {
    p1,
    put,
    setHouseW: (watts) => { houseW = watts; },
    advance: async (polls) => {
      for (let poll = 0; poll < polls; poll += 1) {
        await vi.advanceTimersByTimeAsync(POLL_MS);
        await drainPending();
        follow();
      }
    },
    restart: async () => {
      await cleanupApps();
      await createApp().onInit();
      await drainPending();
    },
    refreshDevices: () => { mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now()); },
    modeWrites: () => (put.mock.calls as unknown[][])
      .filter(([path]) => path === MODE_WRITE)
      .map(([, body]) => (body as { value?: unknown }).value),
  };
};

const listedDevices = async () => (await api.ui_devices({ homey: mockHomeyInstance as never })).devices;

const meterSettings = (extra: Record<string, unknown> = {}) => ({
  power_source: 'homey_energy',
  homey_energy_meter_device_id: P1,
  [CAPACITY_DRY_RUN]: false,
  [OPERATING_MODE_SETTING]: 'Home',
  ...extra,
});

describe('HomeWizard Plug-In Batteries at the SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(Date.UTC(2026, 10, 12, 12, 2));
    resetMockHomey();
    setMockDrivers({});
    connectLiveFeed();
  });
  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('(e) leaves a P1 with no batteries as the meter alone: no battery listed, nothing written', async () => {
    const home = await startHome({ country: 'NL', batteries: 0, houseW: 1200, settings: meterSettings() });
    await home.advance(6);
    expect((await listedDevices()).filter((device) => device.batteryControl !== 'not_battery')).toEqual([]);
    const p1Writes = (home.put.mock.calls as unknown[][])
      .filter(([path]) => String(path).startsWith(`manager/devices/device/${P1}/`));
    expect(p1Writes).toEqual([]);
  });

  it('(a) offers only the P1 as the meter, lists one group battery and never the battery itself, and lets it soak the export', async () => {
    // A new NL install on Homey Energy, no meter chosen: PELS reads the P1 as Homey Energy's sole meter.
    const { homey_energy_meter_device_id: _meter, ...unpicked } = meterSettings();
    const home = await startHome({ country: 'NL', batteries: 1, houseW: -500, settings: unpicked });
    await home.advance(12);
    // The meter pickers offer the P1 alone: the group battery is no meter.
    expect(await api.homey_energy_meters({ homey: mockHomeyInstance as never })).toEqual([{ id: P1, name: 'P1 meter' }]);
    const devices = await listedDevices();
    const batteries = devices.filter((device) => device.batteryControl !== 'not_battery');
    expect(batteries.map((device) => device.id)).toEqual([GROUP]);
    expect(batteries[0]).toMatchObject({ name: 'P1 meter batteries', batteryControl: 'drivable' });
    expect(devices.some((device) => device.id === 'battery-1')).toBe(false);
    // In its own mode the group already holds the P1 at zero, so it takes the
    // export by itself: PELS has no need to claim it, and never grid-charges it.
    expect(home.p1.getActualCapabilityValue('measure_power.battery_group_power_w')).toBe(500);
    expect(home.modeWrites()).toEqual([]);
  });

  it('(b) reads three batteries as one group, and under quarter-hour capacity pressure covers the import', async () => {
    const home = await startHome({
      country: 'BE', batteries: 3, houseW: 5000,
      settings: meterSettings({
        [CAPACITY_LIMIT_KW]: 3, [CAPACITY_MARGIN_KW]: 0, [CAPACITY_PERIOD_MINUTES]: 15,
      }),
    });
    await home.advance(12);
    const batteries = (await listedDevices()).filter((device) => device.batteryControl !== 'not_battery');
    expect(batteries.map((device) => device.id)).toEqual([GROUP]);
    expect(home.modeWrites()).toContain('zero_discharge_only');
    expect(home.modeWrites()).not.toContain('to_full');
  });

  it('(c) drops Plug-In Batteries an earlier version listed, with no claim left behind, and lists the group once', async () => {
    const home = await startHome({
      country: 'NL', batteries: 2, houseW: 300,
      settings: meterSettings({
        managed_devices: { 'battery-1': true, 'battery-2': true },
        [BATTERY_CONTROL_DEVICES]: { 'battery-1': false },
      }),
    });
    await home.advance(6);
    const ids = (await listedDevices()).map((device) => device.id);
    expect(ids).not.toContain('battery-1');
    expect(ids).not.toContain('battery-2');
    expect(ids.filter((id) => id === GROUP)).toHaveLength(1);
    const claimKeys = mockHomeyInstance.settings.getKeys().filter((key: string) => key.startsWith('battery_control_claim.'));
    expect(claimKeys.filter((key: string) => key.includes('battery-'))).toEqual([]);
  });

  it('(d) hands the group back to the mode it held, exactly once, when the owner turns Power-limit control off', async () => {
    const home = await startHome({
      country: 'BE', batteries: 1, houseW: 5000, mode: 'predictive',
      settings: meterSettings({ [CAPACITY_LIMIT_KW]: 3, [CAPACITY_MARGIN_KW]: 0, [CAPACITY_PERIOD_MINUTES]: 15 }),
    });
    await home.advance(12);
    expect(home.modeWrites()).toContain('zero_discharge_only');
    const before = home.modeWrites().length;
    mockHomeyInstance.settings.set(BATTERY_CONTROL_DEVICES, { [GROUP]: false });
    await home.advance(12);
    expect(home.modeWrites().slice(before)).toEqual(['predictive']);
  });

  const pressured = () => ({
    country: 'BE', batteries: 1, houseW: 5000, mode: 'predictive',
    settings: meterSettings({ [CAPACITY_LIMIT_KW]: 3, [CAPACITY_MARGIN_KW]: 0, [CAPACITY_PERIOD_MINUTES]: 15 }),
  });

  it('(d, dropped) hands the group back again when the P1 dropped a hand-back sent within 5 s of a command', async () => {
    const original = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
    // HomeWizard drops a mode change made within 5 s of the last one and still answers success.
    const DROP_WINDOW_MS = 5_000;
    let lastChangeMs = Number.NEGATIVE_INFINITY;
    let commandWrites = 0;
    vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path: string, body: unknown) => {
      if (path !== MODE_WRITE) return original(path, body);
      const nowMs = Date.now();
      if (nowMs - lastChangeMs < DROP_WINDOW_MS) return undefined;
      lastChangeMs = nowMs;
      const result = await original(path, body);
      // The owner opts out 1 s after PELS's first command: the hand-back falls inside the P1's window.
      commandWrites += 1;
      if (commandWrites === 1) {
        setTimeout(() => { mockHomeyInstance.settings.set(BATTERY_CONTROL_DEVICES, { [GROUP]: false }); }, 1_000);
      }
      return result;
    });
    const home = await startHome(pressured());
    await home.advance(12);
    expect(home.modeWrites().slice(0, 2)).toEqual(['zero_discharge_only', 'predictive']);
    // Past the report window, PELS sees the group still in its command and writes the hand-back again.
    await home.advance(36);
    expect(home.p1.getActualCapabilityValue(MODE)).toBe('predictive');
    expect(home.modeWrites()).toEqual(['zero_discharge_only', 'predictive', 'predictive']);
    expect(mockHomeyInstance.settings.get(`battery_control_claim.${GROUP}`)).toBeNull();
  });

  it('(d, restart) still hands the group back to its recorded mode, once, after an app restart', async () => {
    const home = await startHome(pressured());
    await home.advance(12);
    expect(home.modeWrites()).toContain('zero_discharge_only');
    expect(mockHomeyInstance.settings.get(`battery_control_claim.${GROUP}`)).toMatchObject({ previousValue: 'predictive' });
    await home.restart();
    await home.advance(6);
    const before = home.modeWrites().length;
    mockHomeyInstance.settings.set(BATTERY_CONTROL_DEVICES, { [GROUP]: false });
    await home.advance(12);
    expect(home.modeWrites().slice(before)).toEqual(['predictive']);
    expect(mockHomeyInstance.settings.get(`battery_control_claim.${GROUP}`)).toBeNull();
  });

  it('(d, restart) hands back a group the P1 reports only after its first read since the restart', async () => {
    const home = await startHome(pressured());
    await home.advance(12);
    expect(home.modeWrites()).toContain('zero_discharge_only');
    // The HomeWizard app starts without its batteries: the P1's first read has no group.
    for (const capabilityId of GROUP_CAPABILITIES) home.p1.removeCapability(capabilityId);
    await home.restart();
    await home.advance(6);
    for (const capabilityId of GROUP_CAPABILITIES) home.p1.restoreCapability(capabilityId);
    home.refreshDevices();
    await home.advance(6);
    const before = home.modeWrites().length;
    mockHomeyInstance.settings.set(BATTERY_CONTROL_DEVICES, { [GROUP]: false });
    await home.advance(12);
    expect(home.modeWrites().slice(before)).toEqual(['predictive']);
  });

  it('(e, batteries removed) drops a claimed group as soon as the P1 reports no batteries, writing nothing to it', async () => {
    const home = await startHome({ ...pressured(), heater: true });
    await home.advance(12);
    expect(home.modeWrites()).toContain('zero_discharge_only');
    const before = home.modeWrites().length;
    // The owner unplugs the batteries: the HomeWizard app removes the group from the P1.
    for (const capabilityId of GROUP_CAPABILITIES) home.p1.removeCapability(capabilityId);
    emitDeviceUpdate(await mockHomeyInstance.api.get(`manager/devices/device/${P1}`));
    await home.advance(3);
    expect((await listedDevices()).some((device) => device.id === GROUP)).toBe(false);
    // Past the next full device read: a battery missing from two complete reads in a row is gone.
    await home.advance(36);
    // The mode capability is gone: nothing is written to it, and no claim is left owed.
    expect(home.modeWrites().slice(before)).toEqual([]);
    expect(mockHomeyInstance.settings.get(`battery_control_claim.${GROUP}`)).toBeNull();
  });

  it('(b, load drops) hands the group back to the owner\'s standby once the hold is no longer needed', async () => {
    const home = await startHome({
      country: 'BE', batteries: 3, houseW: 3500, mode: 'standby', groupLimitW: 2400,
      settings: meterSettings({ [CAPACITY_LIMIT_KW]: 3, [CAPACITY_MARGIN_KW]: 0, [CAPACITY_PERIOD_MINUTES]: 15 }),
    });
    await home.advance(12);
    expect(home.modeWrites()).toContain('zero_discharge_only');
    const before = home.modeWrites().length;
    // The load drops: 1.8 kW of room, less than the group's 2.4 kW charge ceiling, but its own standby imports nothing.
    home.setHouseW(1200);
    await home.advance(72);
    // The hold steps down to 0 W (standby, PELS's hold) and is then handed back to the owner's standby.
    const after = home.modeWrites().slice(before);
    expect(after).toEqual(['standby', 'standby']);
    // Handed back once: nothing more is written while the load stays low. The
    // group already held standby, so it reports no change: its record goes once
    // the report window has passed with the group still in standby.
    await home.advance(36);
    expect(home.modeWrites().slice(before)).toEqual(['standby', 'standby']);
    expect(mockHomeyInstance.settings.get(`battery_control_claim.${GROUP}`)).toBeNull();
  });
});
