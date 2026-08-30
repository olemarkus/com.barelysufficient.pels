// SDK-boundary e2e for the smart-task budget-slice defect: on a day whose SOFT
// daily budget is already overspent, a task must still book every hour left
// before its deadline that holds a real share of the plan.
//
// The soft budget deliberately does not claw back later hours, so the day plan's
// per-hour allocations legitimately sum ABOVE `dailyBudgetKWh` once the day has
// run hot. `buildAllowedCumKWh` nonetheless clamps its running total at the day
// total, and the allocator USED TO recover an hour's share by DIFFERENCING that
// clamped curve (the since-deleted `resolvePerBucketBudget`). Every hour past the
// point where the cumulative met the cap therefore subtracted to zero — even when
// that hour held several kWh of its own, and even though nothing else in the
// system applied the clamp (the live controller paces off the raw, unclamped
// `plannedKWh[currentBucketIndex]`). The allocator now reads the hour's own share
// (`controlledShareKWh`, `policyHorizon.ts`), deliberately not by differencing.
//
// Reproduced from production 2026-08-08 21:54 local: 22:00 and 23:00 each held
// 4.700 kWh against ~4.1 kWh of forecast background — ~0.6 kWh of genuine
// controlled share apiece — and the task booked 0.000 in both, starting its
// schedule at midnight instead.
//
// THE RULE THIS TEST FOLLOWS (notes/testing-taxonomy.md): nothing internal is
// mocked. The overspent day enters as persisted Homey settings (the daily-budget
// state and the power history), prices and the clock enter at the SDK boundary,
// and the behaviour is OBSERVED ONLY through structured logs at the Homey
// logging seam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  CONTROLLABLE_DEVICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_STATE,
  DEBUG_LOGGING_TOPICS,
  DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const HOUR_MS = 60 * 60 * 1000;
// Europe/Oslo local day 2026-07-25 — UTC+2 throughout, no DST edge in the window.
const DAY_START_UTC_MS = Date.UTC(2026, 6, 24, 22, 0, 0);
const OSLO_OFFSET_MS = 2 * HOUR_MS;
const TODAY_KEY = '2026-07-25';
const TOMORROW_KEY = '2026-07-26';
// The task is created 21:54 local, six minutes before the last hour of the day.
const BOOT_MS = DAY_START_UTC_MS + 21 * HOUR_MS + 54 * 60 * 1000;
// 07:00 local the next morning — nine hours of runway: the tail of 21:00, then
// 22:00 and 23:00 today, then 00:00 through 06:00 tomorrow.
const DEADLINE_MS = DAY_START_UTC_MS + 31 * HOUR_MS;

const TANK = 'tank';
const CURRENT_C = 48;
const TARGET_C = 53;
// 5 °C at 2 kWh/°C = 10 kWh needed — far more than the horizon can supply, so
// the allocator has a reason to fill every hour it is allowed to touch.
const KWH_PER_DEGREE = 2;
const STEP_LOW_W = 1500;

const DAILY_BUDGET_KWH_VALUE = 60;
// Flat hourly profile: tomorrow's preview then offers every hour the same share,
// so nothing about the hour-of-day shape can explain a skipped hour.
const FLAT_WEIGHTS = Array.from({ length: 24 }, () => 1 / 24);
const PROFILE_SAMPLES = 140;

// The day plan of an overspent day. Hours 0-19 at 2.8 and hours 20-21 at 1.0
// reach 58.0 by the current hour; the two hours still to come hold 4.5 each.
// Sum is 67.0 against a 60 kWh budget — the soft budget's "do not penalise later
// hours" behaviour, and exactly the shape production produced on 8 of 10 days.
//
// What the clamped cumulative then does to those two hours:
//   hour 22 → min(62.5, 60) = 60 → slice 2.0 kWh, minus 3.9 background → 0
//   hour 23 → min(67.0, 60) = 60 → slice 0.0 kWh                      → 0
// One squeezed, one plateaued — which is why `dailyBudgetExhaustedBucketCount`
// counts a single bucket while two are blank.
const seededPlannedKWh = (): number[] => [
  ...Array.from({ length: 20 }, () => 2.8),
  1, 1,
  4.5, 4.5,
];
const seededUncontrolledKWh = (): number[] => [
  ...Array.from({ length: 20 }, () => 2.24),
  0.8, 0.8,
  3.9, 3.9,
];
const seededControlledKWh = (): number[] => {
  const uncontrolled = seededUncontrolledKWh();
  return seededPlannedKWh().map((planned, index) => planned - (uncontrolled[index] ?? 0));
};

// Usage that genuinely overspends the day: 61.95 kWh across the elapsed hours
// plus 0.5 kWh into the hour in progress, against a 57.9 kWh allowance at 21:54.
// The positive deviation is what keeps the plan frozen, so the seeded plan
// reaches the allocator verbatim (`shouldRebuildDailyBudgetPlan` short-circuits
// on `frozen`).
const seedPowerTracker = (): void => {
  const buckets: Record<string, number> = {};
  for (let hourIndex = 0; hourIndex < 21; hourIndex += 1) {
    buckets[new Date(DAY_START_UTC_MS + hourIndex * HOUR_MS).toISOString()] = 2.95;
  }
  buckets[new Date(DAY_START_UTC_MS + 21 * HOUR_MS).toISOString()] = 0.5;
  mockHomeyInstance.settings.set('power_tracker_state', {
    lastTimestamp: BOOT_MS - 30_000,
    buckets,
    objectiveProfiles: {
      [TANK]: {
        kind: 'temperature' as const,
        updatedAtMs: DAY_START_UTC_MS,
        lastSample: { observedAtMs: DAY_START_UTC_MS, value: CURRENT_C, unit: 'degree_c' as const },
        kwhPerUnit: {
          sampleCount: 50,
          mean: KWH_PER_DEGREE,
          m2: 0,
          min: KWH_PER_DEGREE,
          max: KWH_PER_DEGREE,
          confidence: 'high' as const,
          lastUpdatedMs: DAY_START_UTC_MS,
        },
        acceptedSamples: 50,
        rejectedSamples: 0,
      },
    },
  });
};

// Flat price across both local days: the fill order is then plain
// earliest-first, so price ordering cannot explain a skipped hour. Coverage must
// be continuous from the current hour to the deadline or `coversHorizon` rejects
// the horizon outright and no plan is built at all.
const flatDay = (dayStartMs: number) => ({
  hours: Array.from({ length: 24 }, (_, index) => ({
    startsAt: new Date(dayStartMs + index * HOUR_MS).toISOString(),
    total: 70,
    isCheap: false,
    isExpensive: false,
  })),
});
const buildCombinedPrices = () => ({
  version: 2,
  days: {
    [TODAY_KEY]: flatDay(DAY_START_UTC_MS),
    [TOMORROW_KEY]: flatDay(DAY_START_UTC_MS + 24 * HOUR_MS),
  },
  avgPrice: 70,
  lowThreshold: 60,
  highThreshold: 80,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

type PlannedBucket = {
  id: string;
  startMs: number;
  plannedUsefulEnergyKWh: number;
};
type HorizonPlanned = {
  event?: string;
  deviceId?: string;
  status?: string;
  reasonCode?: string;
  energyNeededKWh?: number;
  plannedUsefulEnergyKWh?: number;
  plannedBuckets?: PlannedBucket[];
};

const localLabel = (startMs: number): string => (
  new Date(startMs + OSLO_OFFSET_MS).toISOString().slice(5, 16).replace('T', ' ')
);

const readPersistedBudgetState = (): {
  frozen?: boolean;
  plannedKWh?: number[];
  plannedControlledKWh?: number[];
} => mockHomeyInstance.settings.get(DAILY_BUDGET_STATE) ?? {};

const seedSettings = (): void => {
  mockHomeyInstance.settings.set(DEBUG_LOGGING_TOPICS, ['plan', 'diagnostics', 'deferred_objectives', 'daily_budget']);
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  // A roomy hard cap: capacity must not be the binding constraint, so the daily
  // budget slice is the only thing that can zero an hour.
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(DAILY_BUDGET_ENABLED, true);
  mockHomeyInstance.settings.set(DAILY_BUDGET_KWH, DAILY_BUDGET_KWH_VALUE);
  // Price shaping off — one less thing shaping the per-hour allocations.
  mockHomeyInstance.settings.set(DAILY_BUDGET_PRICE_SHAPING_ENABLED, false);
  mockHomeyInstance.settings.set(DAILY_BUDGET_STATE, {
    dateKey: TODAY_KEY,
    dayStartUtcMs: DAY_START_UTC_MS,
    plannedKWh: seededPlannedKWh(),
    plannedUncontrolledKWh: seededUncontrolledKWh(),
    plannedGrossUncontrolledKWh: seededUncontrolledKWh(),
    plannedControlledKWh: seededControlledKWh(),
    frozen: true,
    lastPlanBucketStartUtcMs: DAY_START_UTC_MS + 21 * HOUR_MS,
    // A learned profile with a real controlled share. Without one,
    // `getEffectiveProfileData` reports every hour as 100% uncontrolled, and
    // TOMORROW's preview — which is rebuilt from the profile rather than seeded —
    // would offer a smart task nothing at all. 0.42 is the share production was
    // carrying on the night this reproduces.
    profileUncontrolled: { weights: FLAT_WEIGHTS, sampleCount: PROFILE_SAMPLES },
    profileControlled: { weights: FLAT_WEIGHTS, sampleCount: PROFILE_SAMPLES },
    profileControlledShare: 0.42,
    profileSampleCount: PROFILE_SAMPLES,
    profileSplitSampleCount: PROFILE_SAMPLES,
  });
  mockHomeyInstance.settings.set('price_optimization_enabled', true);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [TANK]: true });
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [TANK]: true });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { [TANK]: 1 } });
  mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
    [TANK]: { enabled: true, min: 0, max: 3000, step: 500 },
  });
  mockHomeyInstance.settings.set(COMBINED_PRICES, buildCombinedPrices());
  // No rescue permissions — the production task had all three off, so the
  // allocator has no licence to schedule past the budget slice.
  mockHomeyInstance.settings.set(`deferred_objective.${TANK}`, {
    enabled: true,
    kind: 'temperature' as const,
    enforcement: 'soft' as const,
    targetTemperatureC: TARGET_C,
    deadlineAtMs: DEADLINE_MS,
  });
  seedPowerTracker();
};

const buildTank = async (): Promise<MockDevice> => {
  const device = new MockDevice(TANK, 'Tank',
    ['measure_power', 'target_temperature', 'measure_temperature', 'onoff', 'target_power'], 'heater');
  await device.setCapabilityValue('measure_power', STEP_LOW_W);
  await device.setCapabilityValue('measure_temperature', CURRENT_C);
  await device.setCapabilityValue('target_temperature', TARGET_C);
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('target_power', STEP_LOW_W);
  return device;
};

describe('smart task on an overspent soft-budget day (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked — under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now(); a real-vs-fake split desyncs the day context.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(BOOT_MS);
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('books every hour left before the deadline, including the tail of the overspent day', async () => {
    seedSettings();
    const tank = await buildTank();
    setMockDrivers({ d: new MockDriver('d', [tank]) });

    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/energy/live') return { items: [{ type: 'cumulative', values: { W: STEP_LOW_W } }] };
      return originalGet(path);
    });

    const app = createApp();
    const plans: HorizonPlanned[] = [];
    const originalLog = app.log.bind(app);
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const entry = JSON.parse(arg) as HorizonPlanned;
          if (entry.event === 'deferred_objective_horizon_planned' && entry.deviceId === TANK) {
            plans.push(entry);
          }
        } catch { /* non-JSON prose log */ }
      }
      return originalLog(...args);
    };

    await app.onInit();
    // Stay inside the 21:00 hour: 20 polls is 200 s, so no hour rollover and no
    // plan rebuild trigger while the first horizon plan settles.
    for (let index = 0; index < 20; index += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainUntil(() => false, { rounds: 20 }).catch(() => { /* drained */ });
    }

    // (1) The overspent day reached the allocator intact: the plan stayed frozen
    // (so the seeded shares are the ones in play) and today's two remaining hours
    // each hold a genuine controlled share. Without this the primary assertion
    // below could go red for the wrong reason — a background squeeze rather than
    // the day-total clamp. Read back through the settings seam because
    // `daily_budget_plan_debug` only fires on a plan REBUILD, which frozen
    // suppresses by design.
    const persisted = readPersistedBudgetState();
    expect(persisted.frozen).toBe(true);
    expect(persisted.plannedKWh?.[22]).toBeCloseTo(4.5, 6);
    expect(persisted.plannedKWh?.[23]).toBeCloseTo(4.5, 6);
    expect(persisted.plannedControlledKWh?.[22]).toBeGreaterThan(0);
    expect(persisted.plannedControlledKWh?.[23]).toBeGreaterThan(0);

    // (2) Assert against the FRESH allocator plan, not a mid-hour frozen read —
    // the frozen path just replays the commitment, so only the fresh plan shows
    // what the allocator decided.
    const plan = plans.find((entry) => (
      (entry.plannedBuckets ?? []).length > 0
      && !(entry.plannedBuckets ?? []).some((bucket) => String(bucket.id).startsWith('frozen-'))
    ));
    expect(plan).toBeDefined();
    const buckets = plan?.plannedBuckets ?? [];
    // Nine hours of runway: the tail of 21:00, 22:00 and 23:00 today, then
    // 00:00-06:00 tomorrow (the last split into a primary and a deadline reserve).
    expect(buckets.length).toBeGreaterThanOrEqual(9);

    // (3) The soft budget is what bound this plan — not capacity, not time, not
    // price. True both before and after the tail hours are booked: 10 kWh of
    // demand still outruns the shares on offer.
    //
    // Deliberately NOT asserted: `dailyBudgetExhaustedBucketCount`. Today it
    // reads 1 while TWO hours are blank (hour 22 keeps a positive but
    // background-swamped clamped slice; only hour 23 is a pure plateau), and it
    // drops to 0 once the slice stops being read off the clamped curve. It is a
    // symptom of the defect rather than a property worth pinning.
    expect(plan?.reasonCode).toBe('limited_by_daily_budget');

    // (4) Every hour between now and the deadline is booked.
    //
    // NOT a general invariant: the allocator stops once the need is met
    // (`bucketAllocation.ts`, `remainingKWh <= epsilonKWh`), so a small task
    // legitimately leaves later hours empty. This scenario is deliberately
    // supply-constrained — 10 kWh needed against a horizon that can offer a
    // fraction of that — so every hour it is allowed to touch should be filled.
    const table = buckets
      .map((bucket) => `  ${localLabel(bucket.startMs)}  ${bucket.plannedUsefulEnergyKWh.toFixed(3)} kWh`)
      .join('\n');
    const unbooked = buckets
      .filter((bucket) => bucket.plannedUsefulEnergyKWh <= 0)
      .map((bucket) => localLabel(bucket.startMs));
    expect(
      unbooked,
      `needed ${plan?.energyNeededKWh?.toFixed(2)} kWh but left hours unbooked.\n${table}`,
    ).toEqual([]);
  });
});
