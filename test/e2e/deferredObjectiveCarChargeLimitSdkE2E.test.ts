// SDK-boundary e2e for an EV smart task capped at its car's own charge limit.
//
// WHAT THIS PROBES: an 80% task retains its requested target when the car's
// own charger limit is 70%. The lower limit is a device constraint and cannot
// turn an unmet requested target into a completed task.
//
// HOW IT IS SIMULATED: through real Homey signals only. The car's limit is the
// evidence the probe persists (`ev_car_link_state`: two stops at 70 %); the car
// is ticked for the charger, links on a coincident plug-in, and lends its
// battery level. Nothing inside PELS is mocked: the cap has to travel from the
// probe through the transport, the observer and the plan device to the smart
// task, and the outcome is read back through the settings-UI history endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp, getLatestTargetSnapshotForTests } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING,
  EV_CAR_ASSOCIATIONS,
  EV_CAR_LINK_STATE,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { drainUntil } from '../utils/asyncDrain';
import type { DeviceStateOfChargeSnapshot } from '../../packages/contracts/src/types';

const CAR_ID = 'polestar';
const CHARGER_ID = 'elbillader';
const CHARGING_PATH = `manager/devices/device/${CHARGER_ID}/capability/evcharger_charging`;
const BOOT_MS = Date.UTC(2026, 8, 26, 0, 15, 0);
const DEADLINE_MS = BOOT_MS + 3 * 60 * 60 * 1000;

const flushDetached = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

const pumpMinutes = async (minutes: number): Promise<void> => {
  for (let i = 0; i < minutes; i += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
    await flushDetached();
  }
};

const chargerLevel = (): DeviceStateOfChargeSnapshot['level'] | undefined => (
  (getLatestTargetSnapshotForTests().find((device) => device.id === CHARGER_ID) as {
    stateOfCharge?: DeviceStateOfChargeSnapshot;
  } | undefined)?.stateOfCharge?.level
);

describe('EV smart task capped at the car\'s own charge limit (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
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

  it('retains the requested target and records a miss when the car stops at its lower limit', async () => {
    const car = new MockDevice(CAR_ID, 'Polestar 3', ['ev_charging_state', 'measure_battery'], 'car');
    await car.setCapabilityValue('ev_charging_state', 'plugged_out');
    await car.setCapabilityValue('measure_battery', 53);
    const charger = new MockDevice(
      CHARGER_ID,
      'Elbillader',
      ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
      'evcharger',
    );
    await charger.setCapabilityValue('evcharger_charging', false);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_out');
    await charger.setCapabilityValue('measure_power', 0);
    setMockDrivers({ ev: new MockDriver('ev', [car, charger]) });

    const settings = mockHomeyInstance.settings;
    settings.set('power_source', 'homey_energy');
    settings.set('homey_energy_meter_device_id', 'meter-main');
    settings.set(CAPACITY_LIMIT_KW, 20);
    settings.set(CAPACITY_MARGIN_KW, 0);
    settings.set(CAPACITY_DRY_RUN, false);
    settings.set(OPERATING_MODE_SETTING, 'Home');
    settings.set(MANAGED_DEVICES, { [CHARGER_ID]: true });
    settings.set(CONTROLLABLE_DEVICES, { [CHARGER_ID]: true });
    settings.set('capacity_priorities', { Home: { [CHARGER_ID]: 1 } });
    settings.set(EV_CAR_ASSOCIATIONS, { [CHARGER_ID]: { carIds: [CAR_ID] } });
    // Two earlier sessions where the car stopped on its own at 70 %.
    settings.set(EV_CAR_LINK_STATE, {
      version: 2,
      pairs: {},
      cars: { [CAR_ID]: { stopSocPct: [70, 70], lastObservedAtMs: BOOT_MS - 60_000 } },
      sessions: {},
    });
    settings.set(`deferred_objective.${CHARGER_ID}`, {
      enabled: true, kind: 'ev_soc', enforcement: 'soft', targetPercent: 80, deadlineAtMs: DEADLINE_MS,
    });
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 3_000 } }] }
        : originalGet(path)
    ));
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await pumpMinutes(2);

    // Plug in: both sides move together, so the probe links the pair.
    await car.setCapabilityValue('ev_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging', true);
    await charger.setCapabilityValue('measure_power', 7_000);
    // Allow the car poll and the extended competition window to settle.
    await pumpMinutes(26);

    // The car's level reaches the charger with the car's ceiling on it.
    await car.setCapabilityValue('measure_battery', 65);
    await pumpMinutes(6);
    await drainUntil(() => {
      const level = chargerLevel();
      return level?.kind === 'known' && level.percent === 65;
    });
    expect(chargerLevel()).toMatchObject({ kind: 'known', percent: 65, carChargeLimitPercent: 70 });
    expect(app.planService.getTaskDeliveryControl(CHARGER_ID)).toEqual({ kind: 'permitted' });
    // The persisted active plan the smart-task card and widget read carries the
    // cap, so they can say why the plan stops short of the 80 % shown.
    await pumpMinutes(1);
    expect(
      (settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING) as {
        plansByDeviceId?: Record<string, { carChargeLimit?: { limitValue: number; reached: boolean } }>;
      } | undefined)?.plansByDeviceId?.[CHARGER_ID],
    ).toMatchObject({ carChargeLimit: { limitValue: 70, reached: false } });

    // The car reaches its limit. The requested 80% remains unmet, and PELS
    // leaves charging available for the car to decide when it stops.
    const writesBefore = putSpy.mock.calls.filter(([path]) => path === CHARGING_PATH).length;
    await car.setCapabilityValue('measure_battery', 70);
    await pumpMinutes(10);
    const pauses = putSpy.mock.calls
      .slice(writesBefore)
      .filter(([path, body]) => path === CHARGING_PATH && (body as { value?: unknown }).value === false);
    expect(pauses).toEqual([]);

    // The car stops, the charger ends the session; the deadline passes.
    await car.setCapabilityValue('ev_charging_state', 'plugged_in');
    await charger.setCapabilityValue('evcharger_charging', false);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_out');
    await charger.setCapabilityValue('measure_power', 0);
    await pumpMinutes(3 * 60);

    const history = await api.ui_deferred_objective_history({ homey: mockHomeyInstance as never });
    expect(history.entriesByDeviceId[CHARGER_ID]).toEqual([
      expect.objectContaining({ outcome: 'missed', targetValue: 80, finalProgressValue: 70 }),
    ]);
    expect(JSON.stringify(history.entriesByDeviceId[CHARGER_ID][0].deliveryExplanation)).not.toContain('capacity_limited');
  });
});
