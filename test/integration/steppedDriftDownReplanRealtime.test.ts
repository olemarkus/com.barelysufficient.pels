/**
 * The reconcile half of the 2026-08-05 hard-cap breach (`inc_26449fb9`), driven
 * end to end through the app. The shed-selection half is
 * `test/e2e/steppedShedStaleMeasurementSdkE2E.test.ts`.
 *
 * Production shape: at 20:01:29 a Høiax stepped water heater announced
 * `pels_measure_step: low` — it had drifted DOWN from the `max` PELS wanted.
 * 281 ms later the reconcile lane wrote `max_power_3000 = "3"`, re-asserting
 * `max` from a plan built at 20:01:24, while the device was still believed to be
 * at `max`. The house went 3839 W -> 5562 W in one 10 s poll, 839 W over the cap.
 *
 * The step-up was never admitted: it needed 1.81 kW against 0.89 kW available,
 * and `admitSteppedRestore` would have rejected it. Every plan-mode step-up in
 * the production log carries a `restore_stepped_admitted` record; the 20:01:38
 * one carries none — because the reconcile re-applied an existing decision
 * instead of deciding against the observation that triggered it.
 *
 * What this pins is the layering, not a threshold: an observation must reach the
 * devices only through a PLAN, so every write is admitted. The old lane could
 * write without planning at all; there is now no such path.
 *
 * It also pins the second half, added when the device-event rebuild trigger went
 * away: the observation schedules NOTHING. Replacing the re-assert with a
 * re-plan fixed the admission bypass but still let a device event decide a
 * whole-home capacity question from a reading taken before the device moved.
 * The reading that sees the drift is the one that re-plans.
 *
 * Integration tier (not e2e) because realtime observations cannot enter through
 * the e2e SDK boundary: the live feed is stubbed off in `test/setup.ts`, so
 * `injectDeviceUpdateForTest` — the transport's documented inbound seam, the
 * exact call the live feed makes — is the closest available equivalent. Same
 * reasoning as `externalOffHoldRealtime.test.ts`. Nothing internal is mocked:
 * the real transport, planner, admission and executor all run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const HEATER_ID = 'connected-300';
const HEATER_STEP_PATH = `manager/devices/device/${HEATER_ID}/capability/max_power_3000`;

// Høiax step ids on the native overlay: '1' = low (1250 W), '3' = max (3000 W).
const STEP_LOW = '1';
const STEP_MAX = '3';

type AppLike = {
  onInit: () => Promise<void>;
  deviceManager?: {
    injectCapabilityUpdateForTest: (deviceId: string, capabilityId: string, value: unknown) => void;
  };
  planService?: { rebuildPlanFromCache: (...args: never[]) => Promise<unknown> };
};

/**
 * Announce a step change the way the production device did.
 *
 * A stepped device's own step move arrives on the realtime CAPABILITY seam
 * (`handleRealtimeCapabilityUpdate` -> `nativeSteppedRealtime`), not through
 * `device.update`: `getControlRelevantRealtimeChanges` reports binary and target
 * changes only, so a `device.update` carrying a new step reports no
 * control-relevant change at all. The production log line for this incident is
 * `realtime_capability_drift` on `pels_measure_step`, which is this path.
 */
const announceStep = (app: AppLike, stepId: string): void => {
  app.deviceManager?.injectCapabilityUpdateForTest(HEATER_ID, 'max_power_3000', stepId);
};

function reportHomePower(getTotalW: () => number): void {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: getTotalW() } }] };
    }
    return originalGet(path);
  });
}

const startApp = async (): Promise<AppLike> => {
  const device = new MockDevice(
    HEATER_ID,
    'Connected 300',
    ['onoff', 'measure_power', 'max_power_3000', 'measure_temperature', 'target_temperature'],
    'heater',
  );
  // Recognised as a Høiax so the native stepped-load overlay applies its
  // off/1250/1750/3000 profile (`CONNECTED_300_STEPPED_LOAD_PROFILE`).
  device.setDriverIdentity({ ownerUri: 'homey:app:no.hoiax' });
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('max_power_3000', STEP_MAX);
  await device.setCapabilityValue('measure_power', 3000);
  await device.setCapabilityValue('measure_temperature', 20.3);
  await device.setCapabilityValue('target_temperature', 65);
  setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

  const enabled = { [HEATER_ID]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 4.727);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, enabled);

  const app = createApp() as unknown as AppLike;
  await app.onInit();
  await vi.advanceTimersByTimeAsync(30_000);
  return app;
};

/**
 * Advance past the next Homey Energy poll (10 s) and the rebuild floor it feeds.
 * This is the ONLY thing that re-plans now — the observation itself schedules
 * nothing, so a test that only drains microtasks sees no rebuild at all.
 */
const settleThroughNextReading = async () => {
  await vi.advanceTimersByTimeAsync(15_000);
};

describe('stepped device drifting down from the planned step', () => {
  beforeEach(() => {
    // 'Date' MUST be faked: under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now() (`setup/planRebuildIntentPolicy.ts`). Without it the
    // rebuild runs on real wall-clock while the test drives fake timers.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 7, 5, 20, 1, 24));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('decides nothing on the observation itself, and never re-asserts the pre-drift step', async () => {
    // Tight house: 4500 W against a 4727 W cap leaves 227 W, far short of the
    // 1.75 kW that stepping low -> max would add. This is the production
    // condition under which the re-assert fired anyway.
    reportHomePower(() => 4500);
    const app = await startApp();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const rebuildSpy = vi.spyOn(app.planService!, 'rebuildPlanFromCache');

    // The device drifts DOWN on its own — the production 20:01:29 event.
    announceStep(app, STEP_LOW);
    // 5 s, deliberately: longer than the deleted lane's 250 ms debounce and 2 s
    // rebuild floor, shorter than the 10 s poll. `drainPending` alone advances no
    // clock, so it would let the removed trigger pass unnoticed.
    await vi.advanceTimersByTimeAsync(5_000);
    await drainPending();

    // Nothing at all happens on the event. The 281 ms re-assert is gone, and so
    // is the re-plan that replaced it: a capacity decision taken here would run
    // against a whole-home reading taken before the device moved.
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(putSpy.mock.calls.filter(([path]) => path === HEATER_STEP_PATH)).toEqual([]);

    // The reading that DOES see the drift arrives on the poll, and it re-plans.
    await settleThroughNextReading();
    expect(rebuildSpy).toHaveBeenCalled();

    // It still does not push the heater back to max: no plan asked for it, and
    // the admission gate that the re-assert bypassed would have refused.
    const stepUpWrites = putSpy.mock.calls.filter(
      ([path, body]) => path === HEATER_STEP_PATH && (body as { value?: unknown })?.value === STEP_MAX,
    );
    expect(stepUpWrites).toEqual([]);
  });

  it('has no path from an observation to a device write that skips planning', async () => {
    reportHomePower(() => 4500);
    const app = await startApp();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    // Make every rebuild a no-op decision. Any capability write that still lands
    // after this point did NOT come from a plan — which is exactly the shape of
    // the re-assert lane, and must be impossible now.
    vi.spyOn(app.planService!, 'rebuildPlanFromCache')
      .mockResolvedValue({ failed: false, appliedActions: false } as never);

    announceStep(app, STEP_LOW);
    await settleThroughNextReading();

    expect(putSpy.mock.calls.filter(([path]) => path === HEATER_STEP_PATH)).toEqual([]);
  });
});
