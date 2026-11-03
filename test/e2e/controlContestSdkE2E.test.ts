// SDK-boundary e2e for the drift breaker (`lib/executor/controlContest.ts`): a
// device that keeps moving away from what PELS set, after it kept it for the
// settle, is reported as contested. A thermostat that clamps PELS's setpoint
// is not. On a real Homey its driver's listener sets its own minimum while it
// runs, Homey then stores PELS's value over it and answers the PUT, so PELS
// confirms its value, and the driver reports its own value again only on its
// next poll. The retries of a value Homey never stored are not counted either;
// that half drives the retry ladder in `test/integration/planExecutor.test.ts`,
// because a house whose plan does not change applies no plan to retry from.
//
// Nothing internal is mocked. Power enters through the Homey Energy poll, the
// thermostat is a Homey device whose setpoint PELS writes through the Web API
// and whose changes come back on the live feed, and the assertions read what
// leaves PELS: the setpoint writes, the `ui_devices` endpoint the settings UI
// reads, and the device journal the event reports are built from.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { createDeviceEventStore } from '../../lib/diagnostics/deviceEventStore';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
} from '../../lib/utils/settingsKeys';
import type { SettingsUiDeviceSnapshot } from '../../packages/contracts/src/settingsUi/devices';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntilCalledWith } from '../utils/asyncDrain';

const DEVICE_ID = 'heatpump-a';
const SETPOINT_PATH = `manager/devices/device/${DEVICE_ID}/capability/target_temperature`;
const LIMITED_C = 15;
/** The thermostat's own minimum, above PELS's limit. */
const CLAMPED_C = 16;
const MINUTE_MS = 60_000;
/** How long the driver's listener takes, write after write: 14-19 s, as measured on a real Homey. */
const LISTENER_MS = [14_000, 17_000, 19_000, 16_000] as const;
/** When the driver sets its own minimum, inside the listener. */
const CLAMP_IN_LISTENER_MS = 2_000;
/** The REST client's socket-idle timeout (`managerHomeyApi.ts`): it stops waiting on a longer listener. */
const HTTP_IDLE_TIMEOUT_MS = 15_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const buildThermostat = async (): Promise<MockDevice> => {
  const device = new MockDevice(
    DEVICE_ID,
    'Hallway Heatpump',
    ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power'],
    'heatpump',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 2000);
  await device.setCapabilityValue('meter_power', 100);
  await device.setCapabilityValue('target_temperature', 22);
  await device.setCapabilityValue('measure_temperature', 21);
  return device;
};

/**
 * A house over its 1 kW limit whose only managed device is limited by
 * lowering its setpoint to {@link LIMITED_C}, so PELS keeps asking for it.
 */
const limitTheHouse = (): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
    path === 'manager/energy/live'
      ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 5000 } }] }
      : originalGet(path)
  ));
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE_ID]: true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE_ID]: true });
  mockHomeyInstance.settings.set('overshoot_behaviors', {
    [DEVICE_ID]: { action: 'set_temperature', temperature: LIMITED_C },
  });
};

const setpointWrites = (putSpy: { mock: { calls: readonly (readonly unknown[])[] } }): number => putSpy.mock.calls
  .filter(([path, body]) => path === SETPOINT_PATH && (body as { value?: unknown }).value === LIMITED_C).length;

/** The device as the settings UI receives it, through the registered endpoint. */
const deviceFromUi = async (): Promise<SettingsUiDeviceSnapshot> => {
  const payload = await api.ui_devices({ homey: mockHomeyInstance as never });
  const device = payload.devices.find((entry: SettingsUiDeviceSnapshot) => entry.id === DEVICE_ID);
  if (!device) throw new Error('thermostat missing from the settings-UI devices payload');
  return device;
};

describe('Drift breaker (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    resetMockHomey();
    connectLiveFeed();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports a thermostat set away from PELS\'s limit after it kept it, four times in 2 hours', async () => {
    const device = await buildThermostat();
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    limitTheHouse();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, SETPOINT_PATH, { value: LIMITED_C });
    // The thermostat took the limit; PELS confirms it from the live feed.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    for (let round = 1; round <= 4; round += 1) {
      // The thermostat keeps PELS's limit past the settle, then something
      // outside PELS (a Flow, an app, a schedule) sets its own value.
      await vi.advanceTimersByTimeAsync(20 * MINUTE_MS);
      expect((await deviceFromUi()).controlContest).toBeUndefined();
      const before = setpointWrites(putSpy);
      device.setActualCapabilityValue('target_temperature', 23);
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      expect(setpointWrites(putSpy)).toBe(before + 1);
    }

    expect((await deviceFromUi()).controlContest).toEqual({
      setting: 'temperature', kind: 'overridden', count: 4, sinceMs: expect.any(Number),
    });
    const journal = createDeviceEventStore(app.getUserdataDatabase()).read([DEVICE_ID], 0, Date.now());
    expect(journal.filter(({ event }) => event === 'device_control_contested')).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          deviceId: DEVICE_ID, deviceName: 'Hallway Heatpump', setting: 'temperature', kind: 'overridden', count: 4,
        }),
      }),
    ]);
  });

  it.each([5, 15])(
    'never reports a thermostat that clamps PELS\'s limit, polled every %i minutes for 2.5 hours',
    async (pollMinutes) => {
      const device = await buildThermostat();
      // Homey stores and publishes the setpoint PELS writes; the thermostat keeps its own.
      device.configureCapabilityBehavior('target_temperature', {
        onApiWrite: { updateActual: false, emitCapabilityEvent: true },
      });
      // The driver reports a value; Homey stores and publishes it only when it
      // changes what Homey holds, so a repeat fires nothing and keeps its date.
      const report = async (value: number): Promise<void> => {
        const changed = await device.getCapabilityValue('target_temperature') !== value;
        device.setActualCapabilityValue('target_temperature', value, {
          updateApi: changed, emitCapabilityEvent: changed, emitDeviceUpdate: changed,
        });
      };
      setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
      limitTheHouse();
      const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
      let writes = 0;
      const putSpy = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
        if (path !== SETPOINT_PATH) return originalPut(path, body);
        const listenerMs = LISTENER_MS[writes % LISTENER_MS.length];
        writes += 1;
        // Inside the listener the driver sets its own minimum; once it returns,
        // Homey stores PELS's value over it and answers the PUT.
        const listener = (async () => {
          await delay(CLAMP_IN_LISTENER_MS);
          await report(CLAMPED_C);
          await delay(listenerMs - CLAMP_IN_LISTENER_MS);
          await originalPut(path, body);
        })();
        if (listenerMs <= HTTP_IDLE_TIMEOUT_MS) return listener;
        // The REST client stops waiting; the listener runs on, and its write lands.
        await delay(HTTP_IDLE_TIMEOUT_MS);
        throw new HomeyRequestTimeoutError('PUT', path);
      });
      const app = createApp();
      // Start-up may already wait on the first write, which waits on the listener's time.
      const initialized = app.onInit();
      await vi.advanceTimersByTimeAsync(10_000);
      await drainUntilCalledWith(putSpy, SETPOINT_PATH, { value: LIMITED_C });
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await initialized;
      const firstWrites = setpointWrites(putSpy);

      // The driver's poll reports the value it holds: its minimum.
      const polls = 150 / pollMinutes;
      for (let poll = 1; poll <= polls; poll += 1) {
        await vi.advanceTimersByTimeAsync(pollMinutes * MINUTE_MS);
        await report(CLAMPED_C);
      }
      await vi.advanceTimersByTimeAsync(MINUTE_MS);

      // PELS set its limit again after every poll, and Homey stored each write.
      expect(setpointWrites(putSpy)).toBeGreaterThanOrEqual(firstWrites + polls);
      expect((await deviceFromUi()).controlContest).toBeUndefined();
      const journal = createDeviceEventStore(app.getUserdataDatabase()).read([DEVICE_ID], 0, Date.now());
      expect(journal.filter(({ event }) => event === 'device_control_contested')).toEqual([]);
    },
  );
});
