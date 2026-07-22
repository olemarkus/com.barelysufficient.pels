// SDK-boundary e2e for the R5 membership complement: with a sub-home
// configured, main's planner NEVER sheds a device inside the sub-home's zone
// subtree — even under hard overshoot — while a main-home device IS shed under
// the same conditions (fails safe: the sub-home device is simply uncontrolled,
// never double-controlled).
//
// THE RULE THIS TEST ENFORCES: nothing internal is mocked. Zones enter through
// the mock `manager/zones/zone` route, device zones through `MockDevice.setZone`,
// the homes registry through the settings seam (the store adapter writes
// `homes_config`, which drives the app's real settings handler → membership
// recompute), and power through the real Homey Energy poll. The control decision
// is observed purely through what PELS writes back via `api.put`.
//
// The no-sub-homes control test in the same file proves the negative assertion
// bites: under identical overshoot WITHOUT a sub-home, BOTH devices are shed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Homey from 'homey';
import { mockHomeyInstance, setMockDrivers, setMockZones, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { createHomesStore } from '../../setup/homeRegistryAdapter';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
} from '../../lib/utils/settingsKeys';
import { drainPending, drainUntilCalledWith } from '../utils/asyncDrain';

const homeyLike = mockHomeyInstance as unknown as Homey.App['homey'];

const ONOFF_CAP = (deviceId: string) => `manager/devices/device/${deviceId}/capability/onoff`;

const ZONES = {
  z1: { id: 'z1', name: 'Home', parent: null },
  z2: { id: 'z2', name: 'Annex', parent: 'z1' },
};

const buildOnOffDevice = async (deviceId: string, zoneId: string) => {
  const device = new MockDevice(
    deviceId,
    `Socket ${deviceId}`,
    ['onoff', 'measure_power', 'meter_power', 'rms_voltage', 'rms_current'],
    'socket',
  );
  device.setZone(zoneId);
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 2000);
  return device;
};

// Drive total home power through the real Homey Energy poll at the wire path
// the REST client hits (`manager/energy/live`), so the real query path runs.
const reportHomePower = (totalW: number) => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
};

const configureCapacity = (limitKw: number) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('controllable_devices', { 'device-main': true, 'device-sub': true });
  mockHomeyInstance.settings.set('managed_devices', { 'device-main': true, 'device-sub': true });
};

// Boot the app, let the bootstrap snapshot refresh + the detached zone-tree
// fetch settle (the tree-commit trigger recomputes membership as soon as the
// detached fetch lands), then run `configureHomes` — mirroring a user creating
// a sub-home on a running app — then drive an overshoot poll.
const bootAndOvershoot = async (configureHomes?: () => void) => {
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
  const app = createApp();
  await app.onInit();
  await vi.advanceTimersByTimeAsync(1000);
  configureHomes?.();
  await vi.advanceTimersByTimeAsync(1000);
  reportHomePower(5000);
  await vi.advanceTimersByTimeAsync(10_000);
  await drainUntilCalledWith(putSpy, ONOFF_CAP('device-main'), { value: false });
  // Quiescence for the negative scan: a write queued on the final poll must
  // not land after the test reads `mock.calls`.
  await drainPending();
  return putSpy;
};

describe('Main plan is the membership complement (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked: under NODE_ENV=test the plan-rebuild scheduler
    // reads its clock via Date.now(); an unfaked Date runs real wall-clock
    // against fake timers and strands the rebuild (the drainUntil flake).
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    setMockZones({ ...ZONES });
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('never sheds a sub-home zone member under overshoot; the main-home device IS shed', async () => {
    setMockDrivers({
      driverA: new MockDriver('driverA', [
        await buildOnOffDevice('device-main', 'z1'),
        await buildOnOffDevice('device-sub', 'z2'),
      ]),
    });
    configureCapacity(1);

    const putSpy = await bootAndOvershoot(() => {
      createHomesStore(homeyLike).write({
        subHomes: [{ homeId: 'h_sub', name: 'Annex', rootZoneId: 'z2', meterDeviceId: null }],
      });
    });

    expect(putSpy).toHaveBeenCalledWith(ONOFF_CAP('device-main'), { value: false });
    // The sub-home member is uncontrolled by main: NO write of any kind —
    // a single actuation here would be double-control.
    const subDeviceWrites = putSpy.mock.calls.filter(([path]) =>
      typeof path === 'string' && path.includes('device-sub'),
    );
    expect(subDeviceWrites).toEqual([]);
  });

  it('control: without a sub-home the same overshoot sheds BOTH devices (the identity path)', async () => {
    setMockDrivers({
      driverA: new MockDriver('driverA', [
        await buildOnOffDevice('device-main', 'z1'),
        await buildOnOffDevice('device-sub', 'z2'),
      ]),
    });
    configureCapacity(1);

    const putSpy = await bootAndOvershoot();
    await drainUntilCalledWith(putSpy, ONOFF_CAP('device-sub'), { value: false });

    expect(putSpy).toHaveBeenCalledWith(ONOFF_CAP('device-main'), { value: false });
    expect(putSpy).toHaveBeenCalledWith(ONOFF_CAP('device-sub'), { value: false });
  });
});
