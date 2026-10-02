import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp, seedStoredPowerTrackerForTests } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  CONTROLLABLE_DEVICES,
  DEBUG_LOGGING_TOPICS,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = Date.UTC(2026, 9, 2);
const HEATER_ID = 'connected-300';
const TARGET_C = 65;
const cap = (id: string): string => `manager/devices/device/${HEATER_ID}/capability/${id}`;

const seedSettings = (nowMs: number, cheaperAhead: boolean): void => {
  const enabled = { [HEATER_ID]: true };
  mockHomeyInstance.settings.set(DEBUG_LOGGING_TOPICS, ['deferred_objectives', 'plan']);
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('daily_budget_enabled', false);
  mockHomeyInstance.settings.set('price_optimization_enabled', true);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, enabled);
  mockHomeyInstance.settings.set('overshoot_behaviors', {
    [HEATER_ID]: { action: 'set_temperature', temperature: 40 },
  });
  mockHomeyInstance.settings.set(COMBINED_PRICES, {
    version: 2,
    days: {
      '2026-10-02': {
        hours: Array.from({ length: 24 }, (_, hour) => ({
          startsAt: new Date(DAY_MS + hour * HOUR_MS).toISOString(),
          total: cheaperAhead && hour === 0 ? 100 : 70,
          isCheap: false,
          isExpensive: false,
        })),
      },
    },
    avgPrice: 70,
    lowThreshold: 60,
    highThreshold: 80,
    priceScheme: 'norway',
    priceUnit: 'øre/kWh',
  });
  mockHomeyInstance.settings.set(`deferred_objective.${HEATER_ID}`, {
    enabled: true,
    kind: 'temperature',
    enforcement: 'soft',
    targetTemperatureC: TARGET_C,
    deadlineAtMs: DAY_MS + 4 * HOUR_MS,
  });
  seedStoredPowerTrackerForTests({
    objectiveProfiles: {
      [HEATER_ID]: {
        updatedAtMs: nowMs,
        lastSample: { observedAtMs: nowMs, value: 63.5 },
        kwhPerUnit: {
          sampleCount: 8, mean: 0.344, m2: 0, min: 0.344, max: 0.344,
          confidence: 'high', lastUpdatedMs: nowMs,
        },
        acceptedSamples: 8,
        rejectedSamples: 0,
      },
    },
  });
};

const bootHeater = async (nowMs: number, cheaperAhead = false) => {
  seedSettings(nowMs, cheaperAhead);
  const heater = new MockDevice(HEATER_ID, 'Connected 300',
    ['onoff', 'measure_power', 'max_power_3000', 'measure_temperature', 'target_temperature'], 'heater');
  heater.setDriverIdentity({ ownerUri: 'homey:app:no.hoiax' });
  await heater.setCapabilityValue('onoff', true);
  await heater.setCapabilityValue('measure_power', 0);
  await heater.setCapabilityValue('max_power_3000', '3');
  await heater.setCapabilityValue('measure_temperature', 63.5);
  await heater.setCapabilityValue('target_temperature', TARGET_C);
  setMockDrivers({ heater: new MockDriver('heater', [heater]) });
  const pollTimes: number[] = [];
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      pollTimes.push(Date.now());
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 500 } }] };
    }
    return originalGet(path);
  });
  const writes = vi.spyOn(mockHomeyInstance.api, 'put');
  const app = createApp();
  const plans: Array<{ event?: string; deviceId?: string; currentHourClaim?: string }> = [];
  const originalLog = app.log.bind(app);
  app.log = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string' || !arg.startsWith('{')) continue;
      const entry = JSON.parse(arg) as (typeof plans)[number];
      if (entry.event === 'deferred_objective_horizon_planned' && entry.deviceId === HEATER_ID) plans.push(entry);
    }
    return originalLog(...args);
  };
  await app.onInit();
  return { heater, writes, plans, pollTimes };
};

describe('smart-task hour boundary (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.api.clearRealtimeEvents();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([{ hour: 0, minute: 57 }, { hour: 1, minute: 57 }, { hour: 0, minute: 59 }])(
    'keeps the heater on through rollover when booted at $hour:$minute:58 on flat prices', async ({ hour, minute }) => {
      const nowMs = DAY_MS + hour * HOUR_MS + minute * 60_000 + 58_000;
      vi.setSystemTime(nowMs);
      const { heater, writes, plans, pollTimes } = await bootHeater(nowMs);
      // Booting at :57:58 aligns the real 30-second rebuild cadence with :59:58.
      // Booting at :59:58 exercises allocation without an earlier commitment.
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await drainPending();
      expect(pollTimes.map((time) => time % HOUR_MS)).toContain(HOUR_MS - 2000);
      expect(plans.some((plan) => plan.currentHourClaim === 'claimed')).toBe(true);
      expect(writes).not.toHaveBeenCalledWith(cap('onoff'), { value: false });
      expect(writes).not.toHaveBeenCalledWith(cap('target_temperature'), { value: 40 });
      await expect(heater.getCapabilityValue('onoff')).resolves.toBe(true);
      await expect(heater.getCapabilityValue('target_temperature')).resolves.toBe(TARGET_C);
    },
  );

  it('still releases the heater when a genuinely cheaper booked hour is ahead', async () => {
    const nowMs = DAY_MS + 57 * 60_000 + 48_000;
    vi.setSystemTime(nowMs);
    const { writes, plans } = await bootHeater(nowMs, true);
    await vi.advanceTimersByTimeAsync(60_000);
    await drainPending();
    expect(plans.some((plan) => plan.currentHourClaim === 'released')).toBe(true);
    expect(writes).toHaveBeenCalledWith(cap('onoff'), { value: false });
  });
});
