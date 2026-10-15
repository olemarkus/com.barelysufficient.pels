import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES, DAILY_BUDGET_ENABLED, DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING,
  MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const DEVICE_ID = 'thermal-completion-heater';
const START_MS = Date.UTC(2026, 0, 1, 17);

async function advanceMinutes(minutes: number): Promise<void> {
  for (let minute = 0; minute < minutes; minute += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
    await drainPending();
  }
}

describe('thermal task completion without initial prices through the Homey SDK', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(START_MS);
    resetMockHomey();
    setMockDrivers({});
    vi.spyOn(mockHomeyInstance.clock, 'getTimezone').mockReturnValue('UTC');
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    { replacement: 'deadline', nextReadyBy: '22:00', nextTargetC: 65 },
    { replacement: 'target', nextReadyBy: '21:00', nextTargetC: 64 },
  ])('agrees without allocating and rejects inherited evidence after changing $replacement', async (scenario) => {
    const heater = new MockDevice(DEVICE_ID, 'Water heater',
      ['onoff', 'measure_power', 'measure_temperature', 'target_temperature'], 'heater');
    heater.setCapabilityMetadata('target_temperature', { min: 30, max: 90, step: 0.5 });
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', 0);
    await heater.setCapabilityValue('measure_temperature', 61);
    await heater.setCapabilityValue('target_temperature', 65);
    setMockDrivers({ heaters: new MockDriver('heaters', [heater]) });
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
    settings.set('mode_device_targets', { Home: { [DEVICE_ID]: 65 } });
    settings.set('price_optimization_enabled', true);
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 500 } }] }
        : originalGet(path)
    ));
    const app = createApp();
    await app.onInit();
    await advanceMinutes(7);
    const setTemperatureDeadline = mockHomeyInstance.flow._actionCardListeners.set_temperature_deadline;
    expect(setTemperatureDeadline).toBeTypeOf('function');
    await expect(setTemperatureDeadline({
      device: { id: DEVICE_ID }, target_c: 65, ready_by: '21:00',
    })).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();
    const expectLiveCompletion = (kind: 'unavailable' | 'satisfied') => {
      expect(settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING)).toMatchObject({
        plansByDeviceId: { [DEVICE_ID]: { latest: null, liveCompletion: { kind } } },
      });
    };
    expectLiveCompletion('unavailable');

    await advanceMinutes(1);
    expectLiveCompletion('satisfied');

    // The old run is met. Changing either deadline or target starts a distinct
    // obligation. The old 65 C evidence covers both targets, so eligibility
    // must reject carryover independently of the observer's target check.
    await expect(setTemperatureDeadline({
      device: { id: DEVICE_ID }, target_c: scenario.nextTargetC, ready_by: scenario.nextReadyBy,
    })).resolves.toBe(true);
    const history = await api.ui_deferred_objective_history({ homey: mockHomeyInstance as never });
    expect(history.entriesByDeviceId[DEVICE_ID]).toEqual([
      expect.objectContaining({ outcome: 'met', metReason: 'stalled' }),
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();
    expectLiveCompletion('unavailable');
    await advanceMinutes(1);
    expectLiveCompletion('satisfied');
  });
});
