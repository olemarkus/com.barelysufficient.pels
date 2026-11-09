// SDK-boundary e2e for binary admission across an unreadable pull.
// PELS internals remain real: Homey's API and live feed supply the readings,
// and capacity pressure must produce no binary SDK write while the sole
// control facet is rejected. A later valid pull restores normal shedding.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainPending, drainUntil, drainUntilCalledWith } from '../utils/asyncDrain';
import { connectLiveFeed, emitCapability } from '../helpers/liveFeedSocketHarness';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const DEVICE_ID = 'device-a';
const FRESH_ISO = '2026-06-03T06:00:00.000Z';

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

const onoffCap = (deviceId: string) => `manager/devices/device/${deviceId}/capability/onoff`;
const deviceListPullPath = 'manager/devices/device';

const buildPullDevice = (onoff: boolean | undefined) => ({ ...HOMEY_DEVICE_FIELDS,
  id: DEVICE_ID,
  name: 'On/Off Socket',
  class: 'socket',
  capabilities: ['onoff', 'measure_power'],
  capabilitiesObj: {
    onoff: onoff === undefined ? { id: 'onoff' } : { id: 'onoff', value: onoff, lastUpdated: FRESH_ISO },
    measure_power: { id: 'measure_power', value: 2000, lastUpdated: FRESH_ISO },
  },
  settings: {},
  available: true,
  ready: true,
});

const configureCapacity = (limitKw: number) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE_ID]: true });
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE_ID]: true });
};

const stubSdk = (totalW: () => number, pullOnoff: () => boolean | undefined = () => undefined) => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  const getSpy = vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW() } }] };
    }
    if (path === deviceListPullPath) {
      return { [DEVICE_ID]: buildPullDevice(pullOnoff()) };
    }
    if (path === `manager/devices/device/${DEVICE_ID}`) {
      return buildPullDevice(pullOnoff());
    }
    return originalGet(path);
  });
  return getSpy;
};

const countDeviceListPulls = (getSpy: ReturnType<typeof stubSdk>) => (
  getSpy.mock.calls.filter(([path]) => path === deviceListPullPath).length
);

const waitForDeviceListPullAfter = async (
  getSpy: ReturnType<typeof stubSdk>,
  previousCount: number,
) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushPromises();
    if (countDeviceListPulls(getSpy) > previousCount) return;
  }
  throw new Error('Expected settings-triggered device list refresh');
};

describe('On/off realtime observation across pull gap (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: new Date(FRESH_ISO),
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    connectLiveFeed();
    resetMockHomey();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Every pull rejects the sole control facet, so the device is not admitted.
  it('does not control a cold-start missing onoff value before realtime arrives', async () => {
    let totalW = 500;
    const device = new MockDevice(DEVICE_ID, 'On/Off Socket', ['onoff', 'measure_power'], 'socket');
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    configureCapacity(1);
    stubSdk(() => totalW);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await flushPromises();
    putSpy.mockClear();

    totalW = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    // Settle the detached meter → plan → executor chain before asserting no SDK write.
    await drainPending();

    expect(app.getPlanInputSnapshot().some(device => device.id === DEVICE_ID)).toBe(false);
    expect(putSpy.mock.calls.some(([path]) => path === onoffCap(DEVICE_ID))).toBe(false);
  });

  it('withholds sole binary control after an unreadable pull and recovers on a valid pull', async () => {
    let totalW = 500;
    // Seen off by a conforming pull at boot; every later pull omits the value.
    let pullOnoff: boolean | undefined = false;
    const device = new MockDevice(DEVICE_ID, 'On/Off Socket', ['onoff', 'measure_power'], 'socket');
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    configureCapacity(1);
    const getSpy = stubSdk(() => totalW, () => pullOnoff);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await flushPromises();

    pullOnoff = undefined;
    await emitCapability(DEVICE_ID, 'onoff', true);
    await flushPromises();

    const pullsBeforeRefresh = countDeviceListPulls(getSpy);
    mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
    await waitForDeviceListPullAfter(getSpy, pullsBeforeRefresh);
    await drainUntil(() => !app.getPlanInputSnapshot().some(device => device.id === DEVICE_ID));
    putSpy.mockClear();

    totalW = 10_000;
    await vi.advanceTimersByTimeAsync(20_000);
    await drainPending();
    expect(app.getPlanInputSnapshot().some(device => device.id === DEVICE_ID)).toBe(false);
    expect(putSpy.mock.calls.some(([path]) => path === onoffCap(DEVICE_ID))).toBe(false);

    // A real, valid control report re-admits the device. The next meter cycle
    // can then shed it through the SDK under the same capacity pressure.
    pullOnoff = true;
    const pullsBeforeRecovery = countDeviceListPulls(getSpy);
    mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
    await waitForDeviceListPullAfter(getSpy, pullsBeforeRecovery);
    await drainUntil(() => app.getPlanInputSnapshot().some(device => device.id === DEVICE_ID));
    // A refresh changes planner input without invalidating the empty plan's
    // unactionable verdict. Steady meter readings recheck it after the 30 s
    // maximum rebuild interval; include the following meter poll as well.
    await vi.advanceTimersByTimeAsync(40_000);
    await drainUntilCalledWith(putSpy, onoffCap(DEVICE_ID), pelsCapabilityWrite(false));
    expect(putSpy).toHaveBeenCalledWith(onoffCap(DEVICE_ID), pelsCapabilityWrite(false));
  });
});
