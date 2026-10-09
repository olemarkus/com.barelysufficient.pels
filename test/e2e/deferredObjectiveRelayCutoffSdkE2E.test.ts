import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  COMBINED_PRICES, CONTROLLABLE_DEVICES, DAILY_BUDGET_ENABLED,
  MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const DEVICE_ID = 'mechanical-thermostat-relay';
const HOUR_MS = 3_600_000;
const START_MS = Date.UTC(2026, 0, 1, 17);
const DEADLINE_MS = START_MS + 4 * HOUR_MS;

describe('relay energy cutoff through Homey SDK and the real control owner', () => {
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

  it('attributes an on relay taking no energy to the device, with ample house capacity', async () => {
    const heater = new MockDevice(DEVICE_ID, 'Relay water heater', ['onoff', 'measure_power'], 'socket');
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', 2_000);
    setMockDrivers({ relays: new MockDriver('relays', [heater]) });
    const settings = mockHomeyInstance.settings;
    settings.set('power_source', 'homey_energy');
    settings.set('homey_energy_meter_device_id', 'meter-main');
    settings.set(CAPACITY_LIMIT_KW, 10);
    settings.set(CAPACITY_MARGIN_KW, 0);
    settings.set(CAPACITY_DRY_RUN, false);
    settings.set(DAILY_BUDGET_ENABLED, false);
    settings.set(OPERATING_MODE_SETTING, 'Home');
    settings.set(MANAGED_DEVICES, { [DEVICE_ID]: true });
    settings.set(CONTROLLABLE_DEVICES, { [DEVICE_ID]: true });
    settings.set('capacity_priorities', { Home: { [DEVICE_ID]: 1 } });
    settings.set('price_optimization_enabled', true);
    settings.set(COMBINED_PRICES, {
      version: 2,
      days: {
        '2026-01-01': {
          hours: Array.from({ length: 24 }, (_, hour) => ({
            startsAt: new Date(Date.UTC(2026, 0, 1, hour)).toISOString(),
            total: 10, isCheap: false, isExpensive: false,
          })),
        },
      },
      avgPrice: 10, lowThreshold: 5, highThreshold: 15,
      priceScheme: 'norway', priceUnit: 'øre/kWh',
    });
    settings.set(`deferred_objective.${DEVICE_ID}`, {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 6, deadlineAtMs: DEADLINE_MS,
    });
    let wholeHomeW = 2_500;
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: wholeHomeW } }] }
        : originalGet(path)
    ));
    const app = createApp();
    await app.onInit();
    const pump = async (minutes: number) => {
      for (let minute = 0; minute < minutes; minute += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        await drainPending();
      }
    };
    await pump(3);
    expect(app.planService.getTaskDeliveryControl(DEVICE_ID)).toEqual({ kind: 'permitted' });
    const recorder = app.deferredObjectivePlanHistoryRecorder;
    if (!recorder) throw new Error('Real app must construct its history recorder');

    // Only measured power changes: PELS' relay command remains on while its
    // mechanical thermostat cuts the heating element. The meter leaves 9.5 kW.
    wholeHomeW = 500;
    await heater.setCapabilityValue('measure_power', 0);
    await api.ui_refresh_devices({ homey: mockHomeyInstance as never });
    await pump(16);
    expect(app.planService.getTaskDeliveryControl(DEVICE_ID)).toEqual({ kind: 'permitted' });
    expect(await heater.getCapabilityValue('onoff')).toBe(true);
    expect(recorder.getDeliveryEvidence(DEVICE_ID, DEADLINE_MS)).toMatchObject({
      nonDelivery: { kind: 'confirmed' },
      explanation: { kind: 'recorded', primary: { kind: 'blocked', cause: 'device_not_accepting' } },
    });
    const active = app.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot().plansByDeviceId[DEVICE_ID];
    expect(active?.diagnosticReasonCode).toBe('objective_not_accepting_energy');

    // The clock reaches ready-by with the device still refusing energy.
    vi.setSystemTime(DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(31_000);
    await drainPending();
    const history = await api.ui_deferred_objective_history({ homey: mockHomeyInstance as never });
    expect(history.entriesByDeviceId[DEVICE_ID]).toEqual([
      expect.objectContaining({
        outcome: 'missed',
        deliveryExplanation: {
          kind: 'recorded', primary: { kind: 'blocked', cause: 'device_not_accepting' },
          contributors: expect.any(Array), intervals: expect.any(Array),
        },
      }),
    ]);
    expect(JSON.stringify(history.entriesByDeviceId[DEVICE_ID][0].deliveryExplanation)).not.toContain('capacity_limited');
  });
});
