/**
 * SDK-boundary e2e for the 2026-08-05 hard-cap breach (`inc_26449fb9`).
 *
 * The production shape, reproduced entirely through Homey inputs: a Høiax
 * stepped water heater sits at its `max` step while its own `measure_power`
 * still reports the `low`-step draw — the device's power capability lagged its
 * step change by ~5 minutes — and whole-home power is over the hard cap.
 *
 * Nothing internal is mocked. The device and the home total both arrive through
 * the real Homey API seam, and the only assertion is the capability command PELS
 * writes back. The planner's rung arithmetic, the candidate builders and the
 * executor all run for real: mocking any of them would confirm the assumption
 * instead of the behaviour.
 *
 * Before the ladder descent, `max -> medium` priced at exactly zero relief
 * (`min(1.193, 3.0) - min(1.193, 1.75)`), the heater never became a shed
 * candidate, and the house stayed over the cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntilCalledWith } from '../utils/asyncDrain';

const HEATER_ID = 'connected-300';
const HEATER_ONOFF_PATH = `manager/devices/device/${HEATER_ID}/capability/onoff`;

// The real device's measured draw at its `low` step, which is what
// `measure_power` kept reporting while the element ran at `max`.
const STALE_LOW_STEP_W = 1193;

async function buildStaleSteppedWaterHeater(): Promise<MockDevice> {
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
  // The step capability says `max` (3000 W)...
  await device.setCapabilityValue('max_power_3000', '3');
  // ...while the power capability still reports the old `low`-step draw.
  await device.setCapabilityValue('measure_power', STALE_LOW_STEP_W);
  await device.setCapabilityValue('measure_temperature', 20.3);
  await device.setCapabilityValue('target_temperature', 65);
  return device;
}

function reportHomePower(totalW: number): void {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
}

function configureCapacity(): void {
  const enabled = { [HEATER_ID]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 4.727);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, enabled);
  mockHomeyInstance.settings.set('overshoot_behaviors', { [HEATER_ID]: { action: 'turn_off' } });
}

describe('stepped shed with a lagging power measurement (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked: under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now() (`setup/planRebuildIntentPolicy.ts`). Without it the
    // rebuild runs on real wall-clock while the test drives fake timers.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 7, 5, 20, 2, 4));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sheds the heater even though its measurement lags its step', async () => {
    const heater = await buildStaleSteppedWaterHeater();
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });
    configureCapacity();
    // 5566 W against a 4727 W limit — the production breach, 839 W over.
    reportHomePower(5566);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);

    await drainUntilCalledWith(putSpy, HEATER_ONOFF_PATH, { value: false });
    expect(putSpy).toHaveBeenCalledWith(HEATER_ONOFF_PATH, { value: false });
  });
});
