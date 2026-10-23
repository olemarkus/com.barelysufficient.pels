// SDK-boundary e2e for "Only PELS starts this device": a device something else
// turns on is turned back off, whether it was already running at boot or is
// started mid-session. The feature adds no actuation of its own. The
// planner holds the device off as a standing decision, and the executor's
// ordinary convergence writes a device whose observation disagrees with its
// plan, so an unplanned start is ordinary drift.
//
// Nothing internal is mocked. The policy enters as a persisted Homey setting,
// the device's state through the real device API, whole-home power through the
// real Homey Energy poll, and the only thing asserted is what PELS writes back
// through the SDK (`api.put` of `onoff`). The policy applies only with power
// limiting off for the device, so every case seeds it that way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DEVICE_START_POLICIES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { drainPending, drainUntil } from '../utils/asyncDrain';
import { connectLiveFeed, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const DEVICE = 'water-heater';
const LOAD_W = 2000;
const NOW_MS = Date.UTC(2026, 6, 25, 12, 0, 0);

const buildHeater = async (on: boolean) => {
  const device = new MockDevice(DEVICE, 'Water heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
  device.setSettings({ load: LOAD_W });
  await device.setCapabilityValue('onoff', on);
  await device.setCapabilityValue('measure_power', on ? LOAD_W : 0);
  await device.setCapabilityValue('meter_power', 100);
  return device;
};

// Whole-home power fed through the real Homey Energy poll, with ample room
// below the limit: nothing about capacity asks PELS to turn the device off.
const wireHomePower = () => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 2500 } }] };
    }
    return originalGet(path);
  });
};

const seedSettings = (policy: 'pels_only' | 'unrestricted') => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: false });
  mockHomeyInstance.settings.set(DEVICE_START_POLICIES, { [DEVICE]: policy });
};

const advancePolls = async (count: number) => {
  for (let i = 0; i < count; i += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

const onoffPuts = (putSpy: { mock: { calls: unknown[][] } }) => putSpy.mock.calls
  .filter(([path]) => path === cap(DEVICE, 'onoff'))
  .map(([, body]) => (body as { value?: boolean } | undefined)?.value);

describe('Only PELS starts this device (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' and 'performance' MUST be faked: the plan-rebuild scheduler reads
    // the monotonic clock and the rest of the app reads Date.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(NOW_MS);
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const startApp = async () => {
    wireHomePower();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    connectLiveFeed();
    const app = createApp();
    await app.onInit();
    return putSpy;
  };

  /** Something other than PELS (a wall switch, the vendor app) turns the heater on. */
  const announceTurnedOn = () => {
    const lastUpdated = new Date().toISOString();
    emitDeviceUpdate({
      id: DEVICE,
      name: 'Water heater',
      class: 'socket',
      capabilities: ['onoff', 'measure_power', 'meter_power'],
      capabilitiesObj: {
        onoff: { id: 'onoff', value: true, lastUpdated },
        measure_power: { id: 'measure_power', value: LOAD_W, lastUpdated },
        meter_power: { id: 'meter_power', value: 100, lastUpdated },
      },
    });
  };

  it('turns off a device that something else started', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater(true)]) });
    seedSettings('pels_only');

    const putSpy = await startApp();
    await advancePolls(6);
    await drainPending();

    expect(onoffPuts(putSpy)).toContain(false);
    expect(onoffPuts(putSpy)).not.toContain(true);
  });

  it('turns off a device something else starts mid-session, on the next reading', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater(false)]) });
    seedSettings('pels_only');
    const putSpy = await startApp();
    await advancePolls(6);
    await drainPending();
    expect(onoffPuts(putSpy)).toEqual([]);

    announceTurnedOn();
    // Shorter than the 10 s poll: a device observation decides nothing itself.
    await vi.advanceTimersByTimeAsync(1_000);
    await drainPending();
    expect(onoffPuts(putSpy)).toEqual([]);

    // The next whole-home reading converges it.
    await advancePolls(3);
    await drainUntil(() => onoffPuts(putSpy).includes(false));
    expect(onoffPuts(putSpy)).toEqual([false]);
  });

  it('leaves the same device running without the policy', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater(true)]) });
    seedSettings('unrestricted');

    const putSpy = await startApp();
    await advancePolls(6);
    await drainPending();

    expect(onoffPuts(putSpy)).toEqual([]);
  });
});
