// SDK-boundary e2e for a whole-home meter that keeps reporting one frozen value.
//
// Production shape (2026-09-14): a grid operator's HAN port stopped sending for
// three days. The owner's reader app kept serving its last value, so PELS kept
// admitting "1.1 kW" every poll, the 10-minute silence pass never fired, and
// the hard cap went unenforced. Holding one value proves nothing by itself (a
// quiet home, a meter that reports past a threshold); holding it for ten
// minutes while a device's own meter shows kilowatts moving is a dead meter.
// An estimate from Homey's Energy settings is no such evidence, and nor is a
// load a battery could be covering.
//
// Driven through the real Homey Energy poll (the live report at the wire path
// the REST client hits); observed only through what PELS writes back via
// `api.put`. Nothing internal is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  HOMEY_ENERGY_METER_DEVICE_ID,
} from '../../lib/utils/settingsKeys';
import { drainPending } from '../utils/asyncDrain';
import api from '../../api';

const HEATER = 'water-heater';
const CHARGER = 'car-socket';
const RELAY = 'relay-heater';
const ONOFF_PATH = `manager/devices/device/${HEATER}/capability/onoff`;
const POLL_MS = 10_000;

/**
 * What Homey Energy reports: the whole-home meter (`null` while it reports
 * nothing), Homey's figure for each device it estimates, and PV production
 * when the home has any.
 */
const energy = {
  meterW: 1100 as number | null,
  estimatesW: {} as Record<string, number>,
  generationW: undefined as number | undefined,
};

/**
 * A relay with no meter of its own. Served as a raw Homey device, because a
 * `MockDevice` always declares `measure_power`: Homey reports only its
 * Energy-settings estimate for it.
 */
type Relay = { on: boolean };

const relayApiDevice = (relay: Relay): Record<string, unknown> => ({
  id: RELAY,
  name: 'Relay heater',
  class: 'socket',
  capabilities: ['onoff'],
  capabilitiesObj: { onoff: { id: 'onoff', value: relay.on, lastUpdated: new Date().toISOString() } },
  settings: {},
  available: true,
  ready: true,
});

const installHomeyApi = (relay: Relay | null): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return {
        items: [
          { type: 'cumulative', id: 'm-main', values: { W: energy.meterW } },
          ...Object.entries(energy.estimatesW).map(([id, W]) => ({ type: 'device', id, values: { W } })),
          ...(energy.generationW === undefined ? [] : [{ type: 'generator', values: { W: energy.generationW } }]),
        ],
      };
    }
    if (relay !== null && path === `manager/devices/device/${RELAY}`) return relayApiDevice(relay);
    const served = await originalGet(path);
    return relay !== null && path === 'manager/devices/device'
      ? { ...(served as Record<string, unknown>), [RELAY]: relayApiDevice(relay) }
      : served;
  });
};

const setUpHome = async (extraDevices: MockDevice[], relay: Relay | null): Promise<MockDevice> => {
  const heater = new MockDevice(HEATER, 'Water heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
  await heater.setCapabilityValue('onoff', true);
  await heater.setCapabilityValue('measure_power', 2000);
  await heater.setCapabilityValue('meter_power', 100);
  // A socket the owner plugs a car into later: its own meter is what shows the
  // whole-home reading should have moved.
  const charger = new MockDevice(CHARGER, 'Car socket', ['onoff', 'measure_power', 'meter_power'], 'socket');
  await charger.setCapabilityValue('onoff', true);
  await charger.setCapabilityValue('measure_power', 0);
  await charger.setCapabilityValue('meter_power', 50);
  setMockDrivers({ driverA: new MockDriver('driverA', [heater, charger, ...extraDevices]) });
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
  // Far above anything the meter reports: only the silence pass can shed.
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 20);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  const devices = {
    [HEATER]: true,
    [CHARGER]: true,
    ...(relay === null ? {} : { [RELAY]: true }),
    ...Object.fromEntries(extraDevices.map((device) => [device.idValue, true])),
  };
  mockHomeyInstance.settings.set('managed_devices', devices);
  mockHomeyInstance.settings.set('controllable_devices', devices);
  return charger;
};

const startApp = async (
  extraDevices: MockDevice[] = [],
  relay: Relay | null = null,
): Promise<{ charger: MockDevice; putSpy: ApiPutSpy; app: ReturnType<typeof createApp> }> => {
  const charger = await setUpHome(extraDevices, relay);
  installHomeyApi(relay);
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
  const app = createApp();
  await app.onInit();
  return { charger, putSpy, app };
};

/**
 * What the owner is shown: the readings stamp the no-readings banner ages,
 * and the published status stamp the headroom widget ages (floored to its
 * 30-second bucket).
 */
const shownStamps = async (app: ReturnType<typeof createApp>): Promise<{ readingsMs: number; statusMs: number }> => {
  const payload = await api.ui_power({ homey: app.homey });
  if (payload.readings.state !== 'received' || payload.status.state !== 'live') {
    throw new Error('expected a received reading and a live status');
  }
  const statusMs = payload.status.status.lastPowerUpdate;
  if (typeof statusMs !== 'number') throw new Error('expected a status stamp');
  return { readingsMs: payload.readings.lastPowerUpdateMs, statusMs };
};

type ApiPutSpy = { mock: { calls: unknown[][] } };

const turnedOff = (spy: ApiPutSpy, fromIndex = 0): boolean => spy.mock.calls.slice(fromIndex).some(([path, body]) => (
  path === ONOFF_PATH && (body as { value?: unknown } | undefined)?.value === false
));

const turnedOn = (spy: ApiPutSpy, fromIndex = 0): boolean => spy.mock.calls.slice(fromIndex).some(([path, body]) => (
  path === ONOFF_PATH && (body as { value?: unknown } | undefined)?.value === true
));

/** Advance whole poll cycles, letting `nextW` choose what the meter reports on each. */
const poll = async (count: number, nextW: (index: number) => number | null): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    energy.meterW = nextW(index);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await drainPending();
  }
};

/** A live meter: the reading moves by a few watts on every poll. */
const live = (index: number): number => 1100 + (index % 7);
const frozen = (): number => 1100;

/** The device list is re-read now, as the next scheduled refresh would. */
const refreshDevices = (): void => {
  mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
};

describe('a whole-home meter frozen on one value (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 8, 14, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    energy.meterW = 1100;
    energy.estimatesW = {};
    energy.generationW = undefined;
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('holds on a steady reading, and limits once a metered load has moved for ten minutes under it', async () => {
    const { charger, putSpy, app } = await startApp();
    await poll(6, live);

    // The HAN port stops; the reader keeps serving its last value. A quiet
    // home looks exactly like this, so a quarter of an hour of it is nothing,
    // and the owner is shown the latest delivery as the latest reading.
    const frozenFromMs = Date.now();
    await poll(90, frozen);
    expect(turnedOff(putSpy)).toBe(false);
    expect((await shownStamps(app)).readingsMs).toBeGreaterThan(Date.now() - POLL_MS);

    // A car is plugged in: the socket's own meter reads 7 kW, the whole-home
    // reading stays on 1100 W. Five minutes of that is only a warning: the
    // banner and the widget date the reading from when it took its value.
    await charger.setCapabilityValue('measure_power', 7000);
    refreshDevices();
    await poll(30, frozen);
    expect(turnedOff(putSpy)).toBe(false);
    const shown = await shownStamps(app);
    expect(shown.readingsMs).toBeGreaterThan(frozenFromMs);
    expect(shown.readingsMs).toBeLessThanOrEqual(frozenFromMs + POLL_MS);
    expect(shown.statusMs).toBeLessThanOrEqual(frozenFromMs + POLL_MS);
    expect(shown.statusMs).toBeGreaterThan(frozenFromMs - 30_000);

    // Ten minutes, and the reading is dead: it has been frozen for well over
    // ten minutes, so the fail-closed pass runs at once.
    await poll(40, frozen);
    expect(turnedOff(putSpy)).toBe(true);

    // Readings move again: planning resumes and the heater comes back.
    const resumedFrom = putSpy.mock.calls.length;
    await poll(60, live);
    expect(turnedOn(putSpy, resumedFrom)).toBe(true);
  }, 60_000);

  it('never counts an estimate as evidence: a relay switched off under a steady meter', async () => {
    const relay: Relay = { on: true };
    energy.estimatesW = { [RELAY]: 2000 };
    const { putSpy } = await startApp([], relay);
    // A full device read picks up Homey's estimate: 2 kW while the relay is on.
    refreshDevices();
    await poll(6, live);
    await poll(90, frozen);

    // The relay turns off. Homey's estimate for it drops by 2 kW; a relay
    // heater whose own thermostat was satisfied drew nothing to begin with.
    relay.on = false;
    energy.estimatesW = { [RELAY]: 0 };
    refreshDevices();
    await poll(80, frozen);
    expect(turnedOff(putSpy)).toBe(false);
  }, 60_000);

  it('owes a reading that freezes after a silence its own pass, though it dates from the same moment', async () => {
    const { charger, putSpy } = await startApp();
    await poll(6, live);
    // The reader stops answering, and the silence gets its fail-closed pass.
    await poll(66, () => null);
    expect(turnedOff(putSpy)).toBe(true);
    // It comes back serving the value it last had: a reading again, so
    // planning resumes and the heater comes back on.
    const resumedFrom = putSpy.mock.calls.length;
    await poll(36, () => live(5));
    expect(turnedOn(putSpy, resumedFrom)).toBe(true);
    // Then a car is plugged in and the value never moves: frozen since the
    // same moment the silence dated from, and owed a pass of its own.
    const restoredFrom = putSpy.mock.calls.length;
    await charger.setCapabilityValue('measure_power', 7000);
    refreshDevices();
    await poll(70, () => live(5));
    expect(turnedOff(putSpy, restoredFrom)).toBe(true);
  }, 60_000);

  const pvInverter = async (productionW: number): Promise<MockDevice> => {
    const inverter = new MockDevice('pv-inverter', 'Solar inverter', ['measure_power'], 'solarpanel');
    await inverter.setCapabilityValue('measure_power', productionW);
    energy.generationW = productionW;
    return inverter;
  };

  it('catches a frozen meter though a metered device keeps dropping offline', async () => {
    const plug = new MockDevice('flaky-plug', 'Flaky plug', ['onoff', 'measure_power'], 'socket');
    await plug.setCapabilityValue('onoff', true);
    await plug.setCapabilityValue('measure_power', 500);
    const { charger, putSpy } = await startApp([plug]);
    await poll(6, live);
    await poll(90, frozen);
    await charger.setCapabilityValue('measure_power', 7000);
    refreshDevices();
    // A plug on a weak link drops off and comes back every three minutes; its
    // last reading stands while it is away, so the car's move keeps counting.
    for (let flap = 0; flap < 5; flap += 1) {
      plug.setAvailable(flap % 2 === 1);
      refreshDevices();
      await poll(18, frozen);
    }
    expect(turnedOff(putSpy)).toBe(true);
  }, 60_000);

  it('judges a PV home at night, when its inverter covers nothing', async () => {
    const { charger, putSpy } = await startApp([await pvInverter(0)]);
    await poll(6, live);
    await poll(90, frozen);
    await charger.setCapabilityValue('measure_power', 7000);
    refreshDevices();
    await poll(70, frozen);
    expect(turnedOff(putSpy)).toBe(true);
  }, 60_000);

  it('never acts on a held reading while PV produces, which may be covering the load', async () => {
    const { charger, putSpy } = await startApp([await pvInverter(2500)]);
    await poll(6, live);
    await poll(90, frozen);
    await charger.setCapabilityValue('measure_power', 7000);
    refreshDevices();
    await poll(80, frozen);
    expect(turnedOff(putSpy)).toBe(false);
  }, 60_000);

  it('never acts on a held reading in a home with a battery, which may be covering the load', async () => {
    const battery = new MockDevice('home-battery', 'Home battery', ['measure_battery', 'measure_power'], 'battery');
    await battery.setCapabilityValue('measure_battery', 60);
    await battery.setCapabilityValue('measure_power', 0);
    const { charger, putSpy } = await startApp([battery]);
    await poll(6, live);
    await poll(90, frozen);

    await charger.setCapabilityValue('measure_power', 7000);
    refreshDevices();
    await poll(80, frozen);
    expect(turnedOff(putSpy)).toBe(false);
  }, 60_000);

  it('never treats a steady 0 W as frozen: a feed that cannot express export reads 0 while exporting', async () => {
    const { charger, putSpy } = await startApp();
    await poll(6, live);
    // Exporting: the import-only feed sits at 0 while the load moves under it.
    await charger.setCapabilityValue('measure_power', 3000);
    refreshDevices();
    await poll(140, () => 0);
    expect(turnedOff(putSpy)).toBe(false);
  }, 60_000);
});
