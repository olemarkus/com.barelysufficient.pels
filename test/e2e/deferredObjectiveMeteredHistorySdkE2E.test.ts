import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';

const BOOT_MS = Date.UTC(2026, 8, 22, 8);
const DEVICE_ID = 'metered-charger';

describe('Smart-task metered history through the SDK', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BOOT_MS);
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('books a cumulative meter\'s resolved draw across the run on the lifecycle clock', async () => {
    const charger = new MockDevice(DEVICE_ID, 'Metered charger', [
      'meter_power', 'measure_battery', 'evcharger_charging', 'evcharger_charging_state',
    ], 'evcharger');
    await charger.setCapabilityValue('meter_power', 100);
    await charger.setCapabilityValue('measure_battery', 40);
    await charger.setCapabilityValue('evcharger_charging', true);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
    setMockDrivers({ ev: new MockDriver('ev', [charger]) });
    const settings = mockHomeyInstance.settings;
    settings.set('power_source', 'homey_energy');
    settings.set('homey_energy_meter_device_id', 'meter-main');
    settings.set('capacity_limit_kw', 20);
    settings.set('capacity_margin_kw', 0);
    settings.set('capacity_dry_run', true);
    settings.set('operating_mode', 'Home');
    settings.set('managed_devices', { [DEVICE_ID]: true });
    settings.set('controllable_devices', { [DEVICE_ID]: false });
    settings.set(`deferred_objective.${DEVICE_ID}`, {
      enabled: true, kind: 'ev_soc', enforcement: 'soft', targetPercent: 80,
      deadlineAtMs: BOOT_MS + 90_000,
    });
    await createApp().onInit();
    await drainPending();
    // The meter advances 0.01 kWh every 10 s, which the observer resolves to a
    // 3.6 kW draw. Tracking starts at the 30-second lifecycle tick, and the draw
    // each tick sees holds until the next one, so the run books 3.6 kW from 30 s
    // to its 90 s deadline. The held level also covers 80–90 s, which the meter
    // had not yet reported: a cumulative meter's draw lags by one push.
    for (let sample = 1; sample <= 8; sample += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      charger.setActualCapabilityValue('meter_power', 100 + sample * 0.01);
      await drainPending();
      await api.ui_refresh_devices({ homey: mockHomeyInstance as never });
    }
    await vi.advanceTimersByTimeAsync(11_000);
    await drainPending();
    const history = await api.ui_deferred_objective_history({ homey: mockHomeyInstance as never });
    expect(history.entriesByDeviceId[DEVICE_ID]).toHaveLength(1);
    expect(history.entriesByDeviceId[DEVICE_ID][0].deliveredKWh).toBeCloseTo(3.6 * (60 / 3600), 7);
  });
});
