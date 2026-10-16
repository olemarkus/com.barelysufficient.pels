import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES,
  DEVICE_TARGET_POWER_CONFIGS, DEVICE_TARGET_POWER_REACHABILITY, MANAGED_DEVICES, NATIVE_EV_WIRING_DEVICES,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';

const ID = 'easee';
const CURRENT_PATH = `manager/devices/device/${ID}/capability/target_charger_current`;

describe('a larger stepped increase at the Homey SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(Date.UTC(2026, 9, 16, 8, 10));
    resetMockHomey();
    setMockDrivers({});
  });
  afterEach(async () => { await cleanupApps(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('writes a distant target directly and waits five minutes before increasing again', async () => {
    const charger = new MockDevice(ID, 'Easee', [
      'onoff', 'measure_power', 'target_charger_current', 'evcharger_charging', 'evcharger_charging_state',
    ], 'evcharger');
    charger.setDriverIdentity({ ownerUri: 'homey:app:no.easee', driverId: 'homey:app:no.easee:charger' });
    charger.setCapabilityMetadata('target_charger_current', { units: 'A', min: 0, max: 40, step: 1, setable: true });
    await charger.setCapabilityValue('onoff', true);
    await charger.setCapabilityValue('evcharger_charging', true);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('target_charger_current', 6);
    await charger.setCapabilityValue('measure_power', 1380);
    setMockDrivers({ chargers: new MockDriver('chargers', [charger]) });
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    for (const key of [CONTROLLABLE_DEVICES, MANAGED_DEVICES, NATIVE_EV_WIRING_DEVICES]) {
      mockHomeyInstance.settings.set(key, { [ID]: true });
    }
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
      [ID]: { enabled: true, preset: 'ev_charger_1_phase', max: 7360 },
    });
    // Persisted device evidence from earlier charging: the full range is known.
    // Unfamiliar currents still go through the separate one-rung probe policy.
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_REACHABILITY, {
      [ID]: {
        profileFingerprint: 'ev_charger_1_phase:off=0,6a=1380,8a=1840,10a=2300,12a=2760,14a=3220,16a=3680,20a=4600,24a=5520,28a=6440,32a=7360',
        maxReachedPowerW: 7360, probeFailureCount: 0,
      },
    });
    let totalW = 2000;
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW } }] }
        : originalGet(path)
    ));
    const writes = vi.spyOn(mockHomeyInstance.api, 'put');
    const currentWrites = () => writes.mock.calls.filter(([path]) => path === CURRENT_PATH);
    const requestedCurrent = (index: number): number => {
      const body = currentWrites()[index]?.[1];
      if (!body || typeof body !== 'object' || !('value' in body) || typeof body.value !== 'number') {
        throw new Error('Expected a numeric charger-current SDK write');
      }
      return body.value;
    };
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(65_000);

    expect(currentWrites()).toHaveLength(1);
    const firstAmps = requestedCurrent(0);
    expect(firstAmps).toBeGreaterThan(8);
    expect(firstAmps).toBeLessThan(32);
    // A real observation confirms the command and its draw. Fresh meter samples
    // with spare capacity must still not bypass the existing home-wide cooldown.
    await charger.setCapabilityValue('target_charger_current', firstAmps);
    await charger.setCapabilityValue('measure_power', firstAmps * 230);
    totalW = firstAmps * 230 + 620;
    await vi.advanceTimersByTimeAsync(230_000);
    expect(currentWrites()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(currentWrites()).toHaveLength(2);
    expect(requestedCurrent(1)).toBeGreaterThan(firstAmps);
  });
});
