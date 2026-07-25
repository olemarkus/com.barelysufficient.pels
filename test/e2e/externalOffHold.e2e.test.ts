// SDK-boundary e2e for "Leave off until turned on again": once a hold exists,
// PELS must not turn the device back on — including across a restart, and
// including the capacity-control-off force-ON lane.
//
// Nothing internal is mocked. The hold and the opt-in enter as persisted Homey
// settings (exactly the state a previous session would have left behind), the
// device's off state enters through the real device API, whole-home power
// through the real Homey Energy poll, and the only thing asserted is what PELS
// writes back through the SDK (`api.put` of `onoff`).
//
// Scope note: the DETECTION half of the feature is push-driven and cannot be
// exercised here — the live feed is stubbed off in `test/setup.ts`, so no
// realtime observation can enter through the SDK boundary. It is covered
// end-to-end through the app in test/integration/externalOffHoldRealtime.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  EXTERNAL_OFF_HOLDS,
  OPERATING_MODE_SETTING,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';
import { drainPending, drainUntilCalledWith } from '../utils/asyncDrain';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const DEVICE = 'water-heater';
const LOAD_W = 2000;
const HOLD_AT_MS = Date.UTC(2026, 6, 25, 11, 0, 0);

const buildHeater = async () => {
  const device = new MockDevice(DEVICE, 'Water heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
  device.setSettings({ load: LOAD_W });
  await device.setCapabilityValue('onoff', false);
  await device.setCapabilityValue('measure_power', 0);
  return device;
};

// Whole-home power fed through the real Homey Energy poll. Zero import means
// there is ample available power, so the restore lane would normally resume an
// off managed device — which is exactly what the hold has to prevent.
const wireHomePower = () => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: 0 } }] };
    }
    return originalGet(path);
  });
};

const seedSettings = (params: { optedIn: boolean; held: boolean; controllable?: boolean }) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: params.controllable ?? true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  if (params.optedIn) mockHomeyInstance.settings.set(RESPECT_EXTERNAL_OFF_DEVICES, { [DEVICE]: true });
  if (params.held) {
    mockHomeyInstance.settings.set(EXTERNAL_OFF_HOLDS, {
      version: 1,
      entriesByDeviceId: {
        [DEVICE]: { sinceMs: HOLD_AT_MS, observedAtMs: HOLD_AT_MS, capabilityId: 'onoff' },
      },
    });
  }
};

const advancePolls = async (count: number) => {
  for (let i = 0; i < count; i += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

const onoffPuts = (putSpy: { mock: { calls: unknown[][] } }) => putSpy.mock.calls
  .filter(([path]) => path === cap(DEVICE, 'onoff'))
  .map(([, body]) => (body as { value?: boolean } | undefined)?.value);

describe('Leave off until turned on again (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked — under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now() (app.ts getAppPlanRebuildNowMs); a real-vs-fake split
    // intermittently strands the rebuild under CI load.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 6, 25, 12, 0, 0));
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

  const startApp = async () => {
    wireHomePower();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    return putSpy;
  };

  it('never resumes a device whose hold survived the restart', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: true });

    const putSpy = await startApp();
    // Well past the 60–300 s restore cooldowns, with ample available power.
    await advancePolls(60);
    await drainPending();

    expect(onoffPuts(putSpy)).not.toContain(true);
  });

  it('resumes the same device when no hold is persisted (the behaviour that changed)', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: false });

    const putSpy = await startApp();
    await advancePolls(60);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: true });

    expect(onoffPuts(putSpy)).toContain(true);
  });

  it('releases the device when the opt-in is switched off while it is held', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: true });

    const putSpy = await startApp();
    await advancePolls(6);
    expect(onoffPuts(putSpy)).not.toContain(true);

    // The user turns "Leave off until turned on again" off in Settings.
    mockHomeyInstance.settings.set(RESPECT_EXTERNAL_OFF_DEVICES, {});
    await advancePolls(60);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: true });

    expect(onoffPuts(putSpy)).toContain(true);
    expect(mockHomeyInstance.settings.get(EXTERNAL_OFF_HOLDS)).toMatchObject({ entriesByDeviceId: {} });
  });

  it('does not force a held device on when Power-limit control is turned off', async () => {
    // The capacity-control-off lane force-turns-ON devices PELS had shed, so it
    // gets the same carve-out as the solar dump-load posture.
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: true });

    const putSpy = await startApp();
    await advancePolls(6);

    mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: false });
    await advancePolls(30);
    await drainPending();

    expect(onoffPuts(putSpy)).not.toContain(true);
  });
});
