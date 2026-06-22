// SDK-boundary e2e (createApp): a SMART TASK (deferred objective) running during a
// sunny hour, with solar PV self-consuming most of the home load.
//
// THE RULE THIS TEST FOLLOWS (lib/objectives/deferredObjectives/AGENTS.md): nothing
// internal is mocked. The whole app boots through `createApp().onInit()`; only the
// Homey SDK boundary is simulated — the energy poll (`manager/energy/live`: a NET
// `cumulative.W` plus a `totalGenerated.W` production term), the `combined_prices`
// setting, the device's observed temperature, the clock, and the persisted
// learned-rate datum. The real planner, the real deferred bridge + recorder +
// admission, and the real executor all run. The smart task is OBSERVED only through
// the `deferred_objective_horizon_planned` structured log; the managed/unmanaged
// split and the cap view are observed through `power_tracker_state` + the
// `plan_rebuild_completed` log. No internal reads.
//
// WHAT IT DEMONSTRATES (two things at once):
//  1. The smart task is admitted and SCHEDULED to run in the current (cheapest,
//     sunny) hour — `status` plannable, energy booked this hour, not price-deferred.
//  2. Under PV self-consumption the managed/unmanaged accounting is correct: the
//     task's heater draw (1.5 kW, partly solar-fed) is attributed in full as MANAGED
//     and the residual is true background — while the hard-cap import path still
//     sees only the 0.5 kW NET. (This is the gross-up fix exercised on the smart-task
//     path: a stale clamp would have mis-attributed the heater to ~0.5 kW.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  COMBINED_PRICES, CONTROLLABLE_DEVICES, DAILY_BUDGET_ENABLED,
  DEBUG_LOGGING_TOPICS, DEVICE_TARGET_POWER_CONFIGS, MANAGED_DEVICES,
} from '../../lib/utils/settingsKeys';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';

const HOUR_MS = 60 * 60 * 1000;
const DAY = Date.UTC(2026, 4, 10, 0, 0, 0); // midnight UTC: price day-key == clock day
const TODAY_KEY = new Date(DAY).toISOString().slice(0, 10);
const TANK = 'tank';

const NOON_HOUR = 12; // sunny midday — also the single cheapest price hour
const TARGET_C = 53;
const CURRENT_C = 52; // 1 degC to go -> ~1.5 kWh of work to book
const KWH_PER_DEGREE = 1.5;

const HEATER_DRAW_W = 1500; // the task's heater drawing at its step (metered at the device)
const SOLAR_W = 2000; // PV producing 2.0 kW
const BACKGROUND_W = 1000; // implicit non-managed load
const TRUE_CONSUMPTION_W = HEATER_DRAW_W + BACKGROUND_W; // 2.5 kW actual home consumption
const NET_W = TRUE_CONSUMPTION_W - SOLAR_W; // 0.5 kW net grid import (self-consuming, no export)
const CAP_KW = 5.0; // far above net -> task has ample headroom, nothing is shed

type DeferredDiag = {
  event?: string;
  deviceId?: string;
  status?: string;
  reasonCode?: string;
  plannedUsefulEnergyKWh?: number | null;
  priceDeferralEligible?: boolean | null;
  expectedStepId?: string | null;
};
type PlanRebuildEvent = { event?: string; totalKw?: number; hardCapHeadroomKw?: number };

const buildPrices = (cheapHour: number): number[] => (
  Array.from({ length: 24 }, (_, h) => (h === cheapHour ? 5 : 50))
);
const buildCombinedPrices = (cheapHour: number) => ({
  version: 2,
  days: {
    [TODAY_KEY]: {
      hours: buildPrices(cheapHour).map((total, i) => ({
        startsAt: new Date(DAY + i * HOUR_MS).toISOString(),
        total,
        isCheap: false,
        isExpensive: false,
      })),
    },
  },
  avgPrice: 0,
  lowThreshold: 0,
  highThreshold: 0,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

// Persisted learned-rate datum (temperature objectives have no bootstrap rate).
const buildPowerTracker = (nowMs: number) => ({
  lastTimestamp: nowMs,
  objectiveProfiles: {
    [TANK]: {
      kind: 'temperature' as const,
      updatedAtMs: DAY,
      lastSample: { observedAtMs: DAY, value: CURRENT_C, unit: 'degree_c' as const },
      kwhPerUnit: {
        sampleCount: 50, mean: KWH_PER_DEGREE, m2: 0, min: KWH_PER_DEGREE, max: KWH_PER_DEGREE,
        confidence: 'high' as const, lastUpdatedMs: DAY,
      },
      acceptedSamples: 50,
      rejectedSamples: 0,
    },
  },
});

// Drive `manager/energy/live` with a fixed NET cumulative + gross generation.
const driveHomeEnergy = (netW: number, generationW: number): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return {
        items: [
          { type: 'cumulative', values: { W: netW } },
          { type: 'generator', values: { W: generationW } },
        ],
        totalGenerated: { W: generationW },
      };
    }
    return originalGet(path);
  });
};

const readSplit = () => {
  const tracker = mockHomeyInstance.settings.get('power_tracker_state') as PowerTrackerState | null;
  return {
    controlledW: tracker?.lastControlledPowerW ?? Number.NaN,
    uncontrolledW: tracker?.lastUncontrolledPowerW ?? Number.NaN,
    netW: tracker?.lastPowerW ?? Number.NaN,
  };
};

describe('smart task running during a sunny hour (SDK-boundary e2e via createApp)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked: the price store prunes its window relative to the clock.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('admits and schedules the task this hour, and attributes the heater as managed despite PV self-consumption', async () => {
    const hourStartMs = DAY + NOON_HOUR * HOUR_MS;
    vi.setSystemTime(new Date(hourStartMs + 30 * 60 * 1000)); // 12:30, mid-hour

    mockHomeyInstance.settings.set(DEBUG_LOGGING_TOPICS, ['plan', 'diagnostics', 'deferred_objectives']);
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, CAP_KW);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(DAILY_BUDGET_ENABLED, false);
    mockHomeyInstance.settings.set('price_optimization_enabled', true);
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { [TANK]: true });
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [TANK]: true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { [TANK]: 1 } });
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, { [TANK]: { enabled: true, min: 0, max: 3000, step: 500 } });
    mockHomeyInstance.settings.set(COMBINED_PRICES, buildCombinedPrices(NOON_HOUR)); // now is cheapest
    mockHomeyInstance.settings.set('power_tracker_state', buildPowerTracker(hourStartMs));
    // A plain "heat to 53 degC by 18:00" task — no rescue permissions.
    mockHomeyInstance.settings.set(`deferred_objective.${TANK}`, {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: TARGET_C,
      deadlineAtMs: DAY + 18 * HOUR_MS,
    });

    const tank = new MockDevice(TANK, 'Tank',
      ['measure_power', 'target_temperature', 'measure_temperature', 'onoff', 'target_power'], 'heater');
    await tank.setCapabilityValue('measure_power', HEATER_DRAW_W);
    await tank.setCapabilityValue('measure_temperature', CURRENT_C);
    await tank.setCapabilityValue('target_temperature', TARGET_C);
    await tank.setCapabilityValue('onoff', true);
    await tank.setCapabilityValue('target_power', HEATER_DRAW_W);
    setMockDrivers({ d: new MockDriver('d', [tank]) });

    driveHomeEnergy(NET_W, SOLAR_W); // net 0.5 kW, PV 2.0 kW -> gross consumption 2.5 kW

    const app = createApp();
    const diagEvents: DeferredDiag[] = [];
    const planEvents: PlanRebuildEvent[] = [];
    const origLog = app.log.bind(app);
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const parsed = JSON.parse(arg) as DeferredDiag & PlanRebuildEvent;
          if (parsed.event === 'deferred_objective_horizon_planned' && parsed.deviceId === TANK) {
            diagEvents.push(parsed);
          } else if (parsed.event === 'plan_rebuild_completed') {
            planEvents.push(parsed);
          }
        } catch { /* non-JSON log line */ }
      }
      return origLog(...args);
    };
    await app.onInit();

    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainUntil(() => false, { rounds: 20 }).catch(() => {});
    }

    const diag = diagEvents.at(-1);
    const split = readSplit();
    const capView = [...planEvents].reverse().find((e) => typeof e.totalKw === 'number');

    // (1) The smart task is admitted and scheduled to RUN this (cheap, sunny) hour.
    expect(diag).toBeDefined();
    expect(['on_track', 'at_risk', 'cannot_meet']).toContain(diag?.status);
    expect(diag?.plannedUsefulEnergyKWh ?? 0).toBeGreaterThan(0);
    expect(diag?.priceDeferralEligible).not.toBe(true); // current hour is cheapest -> not deferred

    // (2) Under PV self-consumption the heater is attributed in full as MANAGED, and
    // the residual is true background (gross = net 0.5 + PV 2.0 = 2.5 kW).
    expect(split.controlledW).toBeCloseTo(HEATER_DRAW_W, -1); // ~1500 W, not collapsed to net
    expect(split.uncontrolledW).toBeCloseTo(BACKGROUND_W, -1); // ~1000 W

    // (3) The hard-cap import path still sees only the NET 0.5 kW (gross never leaks).
    expect(split.netW).toBeCloseTo(NET_W, -1); // ~500 W
    expect(capView?.totalKw).toBeCloseTo(NET_W / 1000, 2); // 0.5 kW
  });
});
