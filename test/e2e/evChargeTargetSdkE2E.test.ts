/**
 * SDK-boundary e2e for a charger's target battery level ("charge to N%").
 *
 * Every input crosses the Homey boundary: the charger's own `measure_battery`,
 * its plug state, the whole-home meter reading (which is what rebuilds the
 * plan), the settings key, prices and the smart task. Every assertion reads
 * what PELS wrote back to the charger, plus the published plan's reason. No
 * planner, admission or actuator internal is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  CONTROLLABLE_DEVICES,
  DAILY_BUDGET_ENABLED,
  DEVICE_TARGET_POWER_CONFIGS,
  EV_CHARGE_TARGET_SETTINGS,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';

const CHARGER_ID = 'target-charger';
const START_MS = Date.UTC(2026, 0, 1, 17, 5);

type ChargerSetup = {
  /** The charger's own battery level, or none: a charger that has not reported one. */
  levelPercent: number | null;
  chargeBeforeLevelKnown: boolean;
  /** A current-controlled charger, whose lowest step still charges. */
  stepped?: boolean;
  /** The hard cap; the default leaves ample headroom. */
  capacityLimitKw?: number;
};

const buildCharger = async (setup: ChargerSetup): Promise<MockDevice> => {
  const capabilities = ['measure_power', 'evcharger_charging', 'evcharger_charging_state'];
  const charger = new MockDevice(
    CHARGER_ID,
    'Target charger',
    setup.levelPercent === null ? capabilities : [...capabilities, 'measure_battery'],
    'evcharger',
  );
  await charger.setCapabilityValue('measure_power', 7_000);
  if (setup.levelPercent !== null) await charger.setCapabilityValue('measure_battery', setup.levelPercent);
  await charger.setCapabilityValue('evcharger_charging', true);
  await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
  return charger;
};

/** Hour 17 is cheap, every other hour dear, so a smart task books the hour it starts in. */
const cheapNowPrices = () => ({
  version: 2,
  days: {
    '2026-01-01': {
      hours: Array.from({ length: 24 }, (_, hour) => ({
        startsAt: new Date(Date.UTC(2026, 0, 1, hour)).toISOString(),
        total: hour === 17 ? 5 : 50,
        isCheap: hour === 17,
        isExpensive: hour !== 17,
      })),
    },
  },
  avgPrice: 40,
  lowThreshold: 10,
  highThreshold: 45,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

const boot = async (setup: ChargerSetup): Promise<MockDevice> => {
  const charger = await buildCharger(setup);
  setMockDrivers({ ev: new MockDriver('ev', [charger]) });
  const settings = mockHomeyInstance.settings;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-main');
  settings.set(CAPACITY_LIMIT_KW, setup.capacityLimitKw ?? 20);
  settings.set(CAPACITY_MARGIN_KW, 0);
  settings.set(CAPACITY_DRY_RUN, false);
  settings.set(DAILY_BUDGET_ENABLED, false);
  settings.set(OPERATING_MODE_SETTING, 'Home');
  settings.set(MANAGED_DEVICES, { [CHARGER_ID]: true });
  // Power-limit control on: the standing command authority the hold needs.
  settings.set(CONTROLLABLE_DEVICES, { [CHARGER_ID]: true });
  settings.set(NATIVE_EV_WIRING_DEVICES, { [CHARGER_ID]: true });
  if (setup.stepped) {
    settings.set(DEVICE_TARGET_POWER_CONFIGS, {
      [CHARGER_ID]: { enabled: true, preset: 'ev_charger_1_phase', max: 7_360 },
    });
    // Power limiting parks it at its lowest current, which still charges. The
    // target must turn it off instead.
    settings.set(OVERSHOOT_BEHAVIORS, { [CHARGER_ID]: { action: 'set_step' } });
  }
  settings.set('capacity_priorities', { Home: { [CHARGER_ID]: 1 } });
  settings.set('price_optimization_enabled', true);
  settings.set(COMBINED_PRICES, cheapNowPrices());
  settings.set(EV_CHARGE_TARGET_SETTINGS, {
    [CHARGER_ID]: { targetPercent: 30, chargeBeforeLevelKnown: setup.chargeBeforeLevelKnown },
  });
  // The whole-home reading is what rebuilds the plan; it follows the charger.
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
    path === 'manager/energy/live'
      ? {
        items: [{
          type: 'cumulative',
          id: 'meter-main',
          values: { W: 500 + Number(await charger.getCapabilityValue('measure_power')) },
        }],
      }
      : originalGet(path)
  ));
  return charger;
};

const pump = async (minutes: number): Promise<void> => {
  for (let minute = 0; minute < minutes; minute += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
    await drainPending();
  }
};

type AppUnderTest = ReturnType<typeof createApp>;

const plannedReason = (app: AppUnderTest) => (
  app.planService.getLatestPlanSnapshot()?.devices.find((device) => device.id === CHARGER_ID)?.reason
);

describe('EV charge target (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'Date', 'setTimeout', 'setInterval', 'setImmediate',
        'clearTimeout', 'clearInterval', 'clearImmediate', 'performance',
      ],
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

  it.each([false, true])('charges below its target and turns the charger off once it reaches it (stepped=%s)', async (stepped) => {
    const charger = await boot({ levelPercent: 25, chargeBeforeLevelKnown: true, stepped });
    const app = createApp();
    await app.onInit();
    await pump(3);
    expect(await charger.getCapabilityValue('evcharger_charging')).toBe(true);

    await charger.setCapabilityValue('measure_battery', 30);
    await pump(3);
    expect(await charger.getCapabilityValue('evcharger_charging')).toBe(false);
    expect(plannedReason(app)).toEqual({ code: PLAN_REASON_CODES.chargeTargetReached, targetPercent: 30 });
  });

  it('turns a current-controlled charger off at its target while the house is also short of power', async () => {
    // A capacity shed alone would park it at its lowest current, which still
    // charges; reaching the target must still mean off.
    const charger = await boot({ levelPercent: 30, chargeBeforeLevelKnown: true, stepped: true, capacityLimitKw: 1.5 });
    const app = createApp();
    await app.onInit();
    await pump(5);
    expect(await charger.getCapabilityValue('evcharger_charging')).toBe(false);
  });

  it('holds the charger off with no battery level when the owner chose to wait for one', async () => {
    const charger = await boot({ levelPercent: null, chargeBeforeLevelKnown: false });
    const app = createApp();
    await app.onInit();
    await pump(3);
    expect(await charger.getCapabilityValue('evcharger_charging')).toBe(false);
    expect(plannedReason(app)).toEqual({ code: PLAN_REASON_CODES.awaitingBatteryLevel });
  });

  it('lets a smart task booked in this hour charge past the target', async () => {
    const charger = await boot({ levelPercent: 50, chargeBeforeLevelKnown: true });
    mockHomeyInstance.settings.set(`deferred_objective.${CHARGER_ID}`, {
      enabled: true,
      kind: 'ev_soc',
      enforcement: 'soft',
      targetPercent: 80,
      deadlineAtMs: START_MS + 4 * 60 * 60 * 1000,
    });
    const app = createApp();
    await app.onInit();
    await pump(5);
    expect(await charger.getCapabilityValue('evcharger_charging')).toBe(true);
    expect(app.planService.getPlanDevices().find((device) => device.id === CHARGER_ID)?.chargeTargetHold)
      .toEqual({ kind: 'target_reached', targetPercent: 30 });
  });
});
