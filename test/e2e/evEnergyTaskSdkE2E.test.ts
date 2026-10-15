import type { DeferredObjectiveActivePlansV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  COMBINED_PRICES, CONTROLLABLE_DEVICES, DAILY_BUDGET_ENABLED,
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES, NATIVE_EV_WIRING_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const DEVICE_ID = 'energy-charger';
const START_MS = Date.UTC(2026, 0, 1, 17);
const DEADLINE_MS = START_MS + 4 * 3_600_000;
const context = () => ({ homey: mockHomeyInstance as never });

// All inputs and assertions cross the SDK/Flow/API boundary. No internal
// planner, tracker or control owner is mocked or driven directly.
describe('EV energy task through Homey SDK', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(START_MS);
    resetMockHomey();
    setMockDrivers({});
  });
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function boot(stepped = false) {
    const charger = new MockDevice(DEVICE_ID, 'Energy charger',
      ['evcharger_charging', 'evcharger_charging_state', 'measure_power'], 'evcharger');
    await charger.setCapabilityValue('evcharger_charging', false);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_paused');
    await charger.setCapabilityValue('measure_power', 0);
    setMockDrivers({ chargers: new MockDriver('chargers', [charger]) });
    const settings = mockHomeyInstance.settings;
    settings.set('power_source', 'homey_energy');
    settings.set('homey_energy_meter_device_id', 'meter-main');
    settings.set(CAPACITY_LIMIT_KW, 10);
    settings.set(CAPACITY_MARGIN_KW, 0);
    settings.set(CAPACITY_DRY_RUN, false);
    settings.set(DAILY_BUDGET_ENABLED, false);
    settings.set(OPERATING_MODE_SETTING, 'Home');
    settings.set(MANAGED_DEVICES, { [DEVICE_ID]: true });
    settings.set(CONTROLLABLE_DEVICES, { [DEVICE_ID]: false });
    settings.set(NATIVE_EV_WIRING_DEVICES, { [DEVICE_ID]: true });
    if (stepped) settings.set(DEVICE_TARGET_POWER_CONFIGS, {
      [DEVICE_ID]: { enabled: true, preset: 'ev_charger_1_phase', max: 7_360 },
    });
    settings.set('capacity_priorities', { Home: { [DEVICE_ID]: 1 } });
    settings.set('price_optimization_enabled', true);
    settings.set(COMBINED_PRICES, {
      version: 2,
      days: { '2026-01-01': { hours: Array.from({ length: 24 }, (_, hour) => ({
        startsAt: new Date(Date.UTC(2026, 0, 1, hour)).toISOString(),
        total: hour === 17 ? 5 : 50, isCheap: hour === 17, isExpensive: hour !== 17,
      })) } },
      avgPrice: 40, lowThreshold: 10, highThreshold: 45,
      priceScheme: 'norway', priceUnit: 'øre/kWh',
    });
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: {
          W: 500 + Number(await charger.getCapabilityValue('measure_power')),
        } }] }
        : originalGet(path)
    ));
    const app = createApp();
    await app.onInit();
    await mockHomeyInstance.flow._actionCardListeners.set_energy_deadline({
      device: DEVICE_ID, target_kwh: 0.5, ready_by: '22:00',
    });
    return charger;
  }

  const pump = async (minutes: number) => {
    for (let minute = 0; minute < minutes; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      await drainPending();
    }
  };

  const active = () => {
    const stored = mockHomeyInstance.settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING) as
      DeferredObjectiveActivePlansV1 | null;
    return stored?.plansByDeviceId[DEVICE_ID];
  };

  it.each([false, true])('delivers energy without SoC across unplugging and editing (stepped=%s)', async (stepped) => {
    const charger = await boot(stepped);
    const drawW = stepped ? 1_380 : 2_000;
    await pump(3);
    expect(await charger.getCapabilityValue('evcharger_charging')).toBe(true);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('measure_power', drawW);
    await api.ui_refresh_devices(context());
    await pump(6);
    expect(active()?.objectiveKind).toBe('energy');

    // The same UI editor used for existing energy tasks must accept a charger.
    expect(await api.ui_smart_task_update({ ...context(), body: {
      deviceId: DEVICE_ID, kind: 'energy', target: 0.6,
      readyByLocalTime: '22:00', deadlineAtMs: DEADLINE_MS,
    } })).toEqual({ ok: true });
    expect(mockHomeyInstance.settings.get(`deferred_objective.${DEVICE_ID}`))
      .toMatchObject({ kind: 'energy', targetEnergyKWh: 0.6 });

    await charger.setCapabilityValue('evcharger_charging', false);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_out');
    await charger.setCapabilityValue('measure_power', 0);
    await api.ui_refresh_devices(context());
    await pump(3);
    expect(active()?.diagnosticReasonCode).toBe('objective_invalid_session');
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_paused');
    await api.ui_refresh_devices(context());
    await pump(3);
    expect(await charger.getCapabilityValue('evcharger_charging')).toBe(true);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('measure_power', drawW);
    await api.ui_refresh_devices(context());
    // Remaining charging time includes the six minutes before unplugging.
    // Restarting the count on reconnect would leave this run short.
    await pump(Math.ceil(0.6 * 60_000 / drawW) - 6 + 1);
    expect(await charger.getCapabilityValue('evcharger_charging')).toBe(false);
    expect(active()?.liveCompletion.kind).toBe('satisfied');
  });

  it('plans a stepped charger without SoC and records a miss if the car accepts no energy', async () => {
    const charger = await boot(true);
    await pump(3);
    expect(active()?.objectiveKind).toBe('energy');
    expect(active()?.diagnosticReasonCode).not.toBe('objective_progress_stale');
    expect(await charger.getCapabilityValue('evcharger_charging')).toBe(true);
    // The car remains connected but refuses energy, like a full battery.
    await pump(17);
    expect(active()?.liveCompletion.kind).not.toBe('satisfied');
    vi.setSystemTime(DEADLINE_MS);
    await pump(1);
    const history = await api.ui_deferred_objective_history(context());
    expect(history.entriesByDeviceId[DEVICE_ID]).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'missed', objectiveKind: 'energy' }),
    ]));
  });
});
