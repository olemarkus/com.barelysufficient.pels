// SDK-boundary e2e for the drift breaker (`lib/executor/controlContest.ts`): a
// device that keeps moving away from what PELS set and confirmed is reported
// as contested. The retries of a value the device never took are not; that
// half drives the retry ladder in `test/integration/planExecutor.test.ts`,
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
const MINUTE_MS = 60_000;

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

const setpointWrites = (putSpy: ReturnType<typeof vi.spyOn>): number => putSpy.mock.calls
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

  it('reports a thermostat that something sets away from PELS\'s limit four times in an hour', async () => {
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
      await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
      expect((await deviceFromUi()).controlContest).toBeUndefined();
      const before = setpointWrites(putSpy);
      // Something outside PELS (a Flow, an app, a schedule) sets its own value.
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
});
