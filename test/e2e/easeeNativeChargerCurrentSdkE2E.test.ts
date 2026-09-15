/**
 * SDK-boundary e2e for built-in Easee charger current control.
 *
 * The production shape: an Easee charger (`no.easee` 2.0.5) has just started a
 * session, and the charger has reset its dynamic charger current to 32 A, which
 * the app publishes on `target_charger_current`. The owner runs the EV 1-phase
 * control mode with built-in control on, and the house is over the hard cap.
 *
 * Nothing internal is mocked. The charger and the home total arrive through the
 * Homey API seam; the assertion is the capability PELS writes back: a lower
 * whole-amp current on `target_charger_current`, and no stepped-load Flow
 * trigger, because no bridge Flow is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';

const CHARGER_ID = 'easee-charger';
const CHARGER_CURRENT_PATH = `manager/devices/device/${CHARGER_ID}/capability/target_charger_current`;
const RESET_CURRENT_A = 32;
const RESET_POWER_W = RESET_CURRENT_A * 230;

async function buildEaseeCharger(): Promise<MockDevice> {
  const charger = new MockDevice(
    CHARGER_ID,
    'Elbillader',
    ['onoff', 'measure_power', 'target_charger_current', 'evcharger_charging', 'evcharger_charging_state'],
    'evcharger',
  );
  charger.setDriverIdentity({ ownerUri: 'homey:app:no.easee', driverId: 'homey:app:no.easee:charger' });
  charger.setCapabilityMetadata('target_charger_current', { units: 'A', min: 0, max: 40, step: 1, setable: true });
  await charger.setCapabilityValue('onoff', true);
  await charger.setCapabilityValue('target_charger_current', RESET_CURRENT_A);
  await charger.setCapabilityValue('measure_power', RESET_POWER_W);
  await charger.setCapabilityValue('evcharger_charging', true);
  await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
  return charger;
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

function configureRuntime(): void {
  const enabled = { [CHARGER_ID]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 8);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, enabled);
  mockHomeyInstance.settings.set('overshoot_behaviors', { [CHARGER_ID]: { action: 'set_step' } });
  mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
    [CHARGER_ID]: { enabled: true, preset: 'ev_charger_1_phase', max: RESET_POWER_W },
  });
}

describe('built-in Easee charger current (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      // `performance` too: the plan-rebuild scheduler reads the monotonic
      // clock, so leaving it real strands a queued rebuild (test/AGENTS.md).
      toFake: [
        'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
        'clearTimeout', 'clearInterval', 'clearImmediate',
      ],
    });
    // Early in an empty hourly bucket, 9.36 kW is above the safe pace toward
    // the 8 kWh hard cap. Late in the hour the unused energy allowance would
    // legitimately let that instantaneous draw continue.
    vi.setSystemTime(Date.UTC(2026, 8, 15, 4, 1, 52));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._triggerCardTriggers = {};
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('lowers the charger current on target_charger_current without a bridge Flow', async () => {
    const charger = await buildEaseeCharger();
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime();
    // The 32 A reset plus 2 kW of background load, against an 8 kW hard cap.
    reportHomePower(RESET_POWER_W + 2_000);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);

    const chargerCurrentWrites = (): number[] => putSpy.mock.calls
      .filter(([path]) => path === CHARGER_CURRENT_PATH)
      .map(([, body]) => (body as { value?: unknown }).value)
      .filter((value): value is number => typeof value === 'number');
    await drainUntil(() => chargerCurrentWrites().length > 0);

    const [firstWrite] = chargerCurrentWrites();
    expect(Number.isInteger(firstWrite)).toBe(true);
    expect(firstWrite).toBeLessThan(RESET_CURRENT_A);
    expect(mockHomeyInstance.flow._triggerCardTriggers.desired_stepped_load_changed ?? []).toEqual([]);
  });
});
