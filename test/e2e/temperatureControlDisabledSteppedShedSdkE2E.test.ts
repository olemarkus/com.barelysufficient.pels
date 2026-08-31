/**
 * SDK-boundary e2e for the per-device "Disable temperature control" setting.
 *
 * The setting names one axis — the `target_temperature` capability — and used to
 * disable three: the flagged device was demoted to `binary_power` and its whole
 * stepped cluster wiped, so a stepped water heater whose setpoint another Flow
 * owns lost its ladder and PELS could only switch it off.
 *
 * The shape here is the one that cost the owner that ladder: a Høiax stepped
 * water heater with the flag on, drawing at its `max` rung while the house is
 * modestly over the hard cap. PELS must trim it to a lower rung and must not
 * write `target_temperature` at all.
 *
 * Nothing internal is mocked. The device, the flag and the home total all arrive
 * through the real Homey API/settings seams, and the only assertions are the
 * capability commands PELS writes back.
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
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';

const HEATER_ID = 'connected-300';
const cap = (capability: string) => `manager/devices/device/${HEATER_ID}/capability/${capability}`;
const STEP_PATH = cap('max_power_3000');
const TEMPERATURE_PATH = cap('target_temperature');
const ONOFF_PATH = cap('onoff');

// `max_power_3000` value '3' is the `max` rung (3000 W) of the native Høiax
// ladder off/low(1250)/medium(1750)/max(3000).
const MAX_RUNG = '3';
const OFF_RUNG_TARGET_TEMPERATURE = 65;

async function buildSteppedWaterHeater(): Promise<MockDevice> {
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
  await device.setCapabilityValue('max_power_3000', MAX_RUNG);
  await device.setCapabilityValue('measure_power', 3000);
  await device.setCapabilityValue('measure_temperature', 40);
  await device.setCapabilityValue('target_temperature', OFF_RUNG_TARGET_TEMPERATURE);
  return device;
}

function reportHomePower(totalW: number): void {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
}

function configureCapacity(): void {
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
  // The setting under test: PELS may not touch this heater's setpoint.
  mockHomeyInstance.settings.set(TEMPERATURE_CONTROL_DISABLED_DEVICES, enabled);
  // The configured behaviour is the FLOOR — the deepest the planner may go —
  // not this cycle's decision, so a modest deficit stops at a rung.
  mockHomeyInstance.settings.set('overshoot_behaviors', { [HEATER_ID]: { action: 'turn_off' } });
}

const writesTo = (spy: { mock: { calls: unknown[][] } }, path: string): unknown[] => spy.mock.calls
  .filter((call) => call[0] === path)
  .map((call) => call[1]);

describe('stepped shed with temperature control disabled (SDK-boundary e2e)', () => {
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

  it('trims the flagged heater to a lower rung instead of switching it off', async () => {
    const heater = await buildSteppedWaterHeater();
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });
    configureCapacity();
    // 5200 W against a 4727 W hard cap — 473 W over, which one rung down covers.
    reportHomePower(5200);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);

    await drainUntil(() => writesTo(putSpy, STEP_PATH).length > 0);

    // A rung below `max`, and not the off rung (which writes `onoff:false`).
    expect(writesTo(putSpy, STEP_PATH)).toEqual([{ value: '2' }]);
    // The whole point of the setting: PELS never touches the setpoint.
    expect(writesTo(putSpy, TEMPERATURE_PATH)).toEqual([]);
    await expect(heater.getCapabilityValue('target_temperature'))
      .resolves.toBe(OFF_RUNG_TARGET_TEMPERATURE);
    // ...and it did not fall back to the only axis the old demotion left it.
    expect(writesTo(putSpy, ONOFF_PATH)).toEqual([]);
  });
});
