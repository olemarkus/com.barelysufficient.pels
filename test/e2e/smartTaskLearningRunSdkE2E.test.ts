/**
 * SDK-boundary e2e for a temperature smart task on a thermostat PELS has never
 * seen heat. Every mode holds the room below its current temperature, so the
 * heater never runs and no energy per degree is ever learned. Without a rate
 * nothing can be allocated; the task heats toward its own target instead, which
 * is also what produces the readings the rate is learned from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedHourlyFlowPricesForTests } from '../helpers/smartTaskPriceSourceFixture';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = Date.UTC(2026, 10, 14);
const NOW_MS = DAY_MS + 13 * HOUR_MS + 50 * 60 * 1000;
const THERMOSTAT_ID = 'living-room-thermostat';
const MODE_TARGET_C = 10;
const TASK_TARGET_C = 21;
const TARGET_PATH = `manager/devices/device/${THERMOSTAT_ID}/capability/target_temperature`;

const seedSettings = (): void => {
  const settings = mockHomeyInstance.settings;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-main');
  settings.set(OPERATING_MODE_SETTING, 'Home');
  settings.set(CAPACITY_LIMIT_KW, 10);
  settings.set(CAPACITY_MARGIN_KW, 0);
  settings.set(CAPACITY_DRY_RUN, false);
  settings.set('daily_budget_enabled', false);
  settings.set('price_optimization_enabled', true);
  settings.set(MANAGED_DEVICES, { [THERMOSTAT_ID]: true });
  settings.set(CONTROLLABLE_DEVICES, { [THERMOSTAT_ID]: true });
  settings.set('mode_device_targets', { Home: { [THERMOSTAT_ID]: MODE_TARGET_C } });
  seedHourlyFlowPricesForTests(DAY_MS, Array.from({ length: 24 }, () => 70));
  settings.set(`deferred_objective.${THERMOSTAT_ID}`, {
    enabled: true,
    kind: 'temperature',
    enforcement: 'soft',
    targetTemperatureC: TASK_TARGET_C,
    deadlineAtMs: DAY_MS + 17 * HOUR_MS,
  });
};

describe('smart task on a thermostat with no learned rate (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(NOW_MS);
    resetMockHomey();
    setMockDrivers({});
    vi.spyOn(mockHomeyInstance.clock, 'getTimezone').mockReturnValue('UTC');
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('heats toward the task target instead of holding the mode target', async () => {
    seedSettings();
    const thermostat = new MockDevice(THERMOSTAT_ID, 'Thermostat living room',
      ['onoff', 'measure_power', 'measure_temperature', 'target_temperature'], 'thermostat');
    thermostat.setCapabilityMetadata('target_temperature', { min: 4, max: 40, step: 0.5 });
    await thermostat.setCapabilityValue('onoff', true);
    await thermostat.setCapabilityValue('measure_power', 0);
    await thermostat.setCapabilityValue('measure_temperature', 13.3);
    await thermostat.setCapabilityValue('target_temperature', MODE_TARGET_C);
    setMockDrivers({ thermostats: new MockDriver('thermostats', [thermostat]) });
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 500 } }] }
        : originalGet(path)
    ));
    const writes = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    for (let minute = 0; minute < 3; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      await drainPending();
    }

    expect(writes).toHaveBeenCalledWith(TARGET_PATH, pelsCapabilityWrite(TASK_TARGET_C));
  });
});
