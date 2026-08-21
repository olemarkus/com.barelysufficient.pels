/**
 * The rule that replaced the device-observation rebuild trigger: **a device that
 * moves on its own is converged by the next whole-home reading, not by the
 * event.**
 *
 * The two halves both matter, and only one of them is obvious:
 *
 * - PELS must not decide on the event. A capacity decision taken there runs
 *   against a meter reading taken before the device moved.
 * - PELS must still converge. Removing the trigger without a reading to fall
 *   back on would strand a device that drifted out of plan, and the executor has
 *   no clock of its own — `applyPlanActions` is reachable only from a rebuild.
 *
 * So the bound on that reading is the whole safety argument, and it is what this
 * asserts: nothing at all on the event, convergence within one Homey Energy poll
 * (10 s) plus the rebuild floor.
 *
 * Integration tier (not e2e) for the same reason `steppedDriftDownReplanRealtime`
 * and `externalOffHoldRealtime` are: realtime observations cannot enter through
 * the e2e SDK boundary, because the live feed is stubbed off in `test/setup.ts`.
 * `injectDeviceUpdateForTest` is the transport's documented inbound seam and the
 * closest available equivalent — but it IS an internal call, so this is not an
 * SDK-boundary test and must not claim to be one.
 *
 * Nothing else is mocked: the home total arrives through the real Homey API seam,
 * and the only assertion is the capability command PELS writes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending, drainUntil } from '../utils/asyncDrain';

const HEATER_ID = 'heater-1';
const HEATER_ONOFF_PATH = `manager/devices/device/${HEATER_ID}/capability/onoff`;

/**
 * One Homey Energy poll (10 s) plus `TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS`
 * (15 s), with margin. NOT the deleted reconcile lane's 2 s floor — the shed here
 * comes from the poll, and this house is tight-and-unactionable (pinned over its
 * cap with its only controllable load already shed), which is exactly the state
 * that floor gates.
 */
const ONE_READING_MS = 30_000;

type AppLike = {
  onInit: () => Promise<void>;
  deviceManager?: {
    injectDeviceUpdateForTest: (payload: unknown) => void;
  };
};

function reportHomePower(getTotalW: () => number): void {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: getTotalW() } }] };
    }
    return originalGet(path);
  });
}

/**
 * The heater announces that it is ON again after PELS turned it off — the shape
 * of an outside actor (a wall switch, a vendor app, a schedule) putting a shed
 * load back.
 */
const announceTurnedItselfOn = (app: AppLike, measuredW: number): void => {
  app.deviceManager?.injectDeviceUpdateForTest({
    id: HEATER_ID,
    name: 'Heater',
    class: 'heater',
    capabilities: ['onoff', 'measure_power', 'measure_temperature', 'target_temperature'],
    capabilitiesObj: {
      onoff: { id: 'onoff', value: true },
      measure_power: { id: 'measure_power', value: measuredW },
      measure_temperature: { id: 'measure_temperature', value: 20 },
      target_temperature: { id: 'target_temperature', value: 22, units: '°C' },
    },
  });
};

async function buildHeater(): Promise<MockDevice> {
  const device = new MockDevice(
    HEATER_ID,
    'Heater',
    ['onoff', 'measure_power', 'measure_temperature', 'target_temperature'],
    'heater',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 2000);
  await device.setCapabilityValue('measure_temperature', 20);
  await device.setCapabilityValue('target_temperature', 22);
  return device;
}

function configureCapacity(): void {
  const enabled = { [HEATER_ID]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 3);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  mockHomeyInstance.settings.set('overshoot_behaviors', { [HEATER_ID]: { action: 'turn_off' } });
}

describe('a device that turns itself back on', () => {
  beforeEach(() => {
    // 'Date' MUST be faked: under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now() (`setup/planRebuildIntentPolicy.ts`). Without it the
    // rebuild runs on real wall-clock while the test drives fake timers.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 7, 20, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('writes nothing on the event, and converges within one whole-home reading', async () => {
    const heater = await buildHeater();
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });
    configureCapacity();
    // Over the 3 kW cap from the first reading, so the heater is shed on boot.
    let totalW = 4000;
    reportHomePower(() => totalW);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp() as unknown as AppLike;
    await app.onInit();
    await vi.advanceTimersByTimeAsync(ONE_READING_MS);

    const offWrites = () => putSpy.mock.calls.filter(
      ([path, body]) => path === HEATER_ONOFF_PATH && (body as { value?: unknown })?.value === false,
    ).length;
    await drainUntil(() => offWrites() >= 1);
    const offWritesAfterShed = offWrites();

    // The heater comes back on by itself, and the house is over the cap again.
    announceTurnedItselfOn(app, 2000);
    totalW = 4000;
    // Deliberately longer than the observation lane's old 250 ms debounce and
    // shorter than the 10 s poll: this window is where the removed trigger used
    // to fire, so the assertion below is decisive rather than merely early.
    await vi.advanceTimersByTimeAsync(1_000);
    await drainPending();

    // Not a single write on the event. This is the half that the old lane got
    // wrong twice over — first by re-asserting the committed plan (inc_26449fb9),
    // then by re-planning against a reading taken before the change.
    expect(offWrites()).toBe(offWritesAfterShed);

    // The reading that sees it converges the device. This bound IS the safety
    // argument for removing the trigger: without it, nothing would.
    await vi.advanceTimersByTimeAsync(ONE_READING_MS);
    // Drain rather than assert straight off the advance: a fixed flush is the
    // shape `test/utils/asyncDrain.ts` documents as flaking to zero calls under
    // full-suite CPU load.
    await drainUntil(() => offWrites() > offWritesAfterShed);
    expect(offWrites()).toBeGreaterThan(offWritesAfterShed);
  });
});
