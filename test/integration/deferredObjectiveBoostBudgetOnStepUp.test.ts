// Integration proof: with the daily budget ON, the per-hour DAILY-BUDGET slice is
// the binding soft constraint (not the hard cap), and a smart task's
// limit-lower-priority "boost" permission still lets a priority-1 stepped device
// escalate past the shed invariant ONLY during its planned hours.
//
// Companion to deferredObjectiveBoostNoBudgetStepUp.test.ts (the no-budget case
// where the hourly hard cap is the constraint). Here the daily budget supplies the
// per-bucket budget overlay AND the binding planner soft limit (`softLimitSource:
// 'daily'`), proving the boost / shed-invariant behavior is identical under the
// budget-overlay path. Prices still come from the price layer
// (`buildPriceHorizonFromCombined`), independent of the budget snapshot.
//
// Nothing internal is mocked: the REAL DeferredObjectiveDecorationController drives
// the REAL PlanBuilder. The only lever between the two assertions is the clock hour
// (cheap planned vs expensive released); capacity pressure is identical.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CapacityGuard from '../../lib/power/capacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  DeferredObjectiveDecorationController,
  type DeferredObjectiveSettingsV1,
} from '../../lib/objectives/deferredObjectives';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DevicePlanDevice, PlanInputDevice } from '../../lib/plan/planTypes';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { CombinedPriceEntry, CombinedPricesV2 } from '../../lib/price/priceTypes';

const HOUR_MS = 60 * 60 * 1000;
const DAY_START_UTC = Date.UTC(2026, 4, 10, 0, 0, 0);
const TODAY_KEY = '2026-05-10';

const STEP_DEVICE_ID = 'dev_priority_tank';
const LOWER_PRIORITY_ID = 'dev_lower_priority';

const STEP_PROFILE = {
  model: 'stepped_load' as const,
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1500 },
    { id: 'medium', planningPowerW: 2000 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const TARGET_C = 53;
const KWH_PER_DEGREE = 1.5;
const DEADLINE_AT_MS = Date.UTC(2026, 4, 10, 6, 0, 0);

const HOURLY_PRICES = [10, 50, 10, 50, 10, 50, 30, 30, 30, 30, 30, 30,
  30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];

// Hard cap raised well above the binding daily soft limit so the DAILY budget is
// the per-hour constraint (softLimitSource 'daily'), in contrast with the
// no-budget case where the hard cap binds.
const LIMIT_KW = 5.0;
const STEP_LOW_KW = 1.5;
const LOWER_PRIORITY_RESTORE_KW = 2.5;
// Per-hour planned kWh ⇒ daily soft limit ≈ 3.0 kW at the top of the hour
// (computeDailyUsageSoftLimit: plannedKWh / remainingHours). Binds below the 5 kW
// hard cap, while leaving the ~1.5 kW of headroom the tank's low->medium step
// (0.5 kW delta + restore buffer/reserve) needs to be admitted.
const HOURLY_PLANNED_KWH = 3.0;

const buildCombinedPrices = (): CombinedPricesV2 => {
  const hours: CombinedPriceEntry[] = HOURLY_PRICES.map((total, i) => ({
    startsAt: new Date(DAY_START_UTC + i * HOUR_MS).toISOString(),
    total,
    isCheap: false,
    isExpensive: false,
  }));
  return {
    version: 2,
    days: { [TODAY_KEY]: { hours } },
    avgPrice: 0,
    lowThreshold: 0,
    highThreshold: 0,
    priceScheme: 'norway',
    priceUnit: 'øre/kWh',
  };
};

// Daily-budget snapshot with budget ENABLED. `plannedKWh` per hour drives the
// binding planner soft limit; the generous `allowedCumKWh` (+10/h) keeps the
// deferred per-bucket budget overlay ample so the cheap hour still books load
// (boost only engages on a booked planned hour).
const buildDay = (nowMs: number): DailyBudgetDayPayload => {
  const startUtc: string[] = [];
  const startLocalLabels: string[] = [];
  const plannedKWh: number[] = [];
  const plannedWeight: number[] = [];
  const allowedCumKWh: number[] = [];
  const actualKWh: number[] = [];
  for (let i = 0; i < 24; i += 1) {
    startUtc.push(new Date(DAY_START_UTC + i * HOUR_MS).toISOString());
    startLocalLabels.push(String(i).padStart(2, '0'));
    plannedKWh.push(HOURLY_PLANNED_KWH);
    plannedWeight.push(1 / 24);
    actualKWh.push(0);
    allowedCumKWh.push((i + 1) * 10);
  }
  return {
    dateKey: TODAY_KEY,
    timeZone: 'UTC',
    nowUtc: new Date(nowMs).toISOString(),
    dayStartUtc: new Date(DAY_START_UTC).toISOString(),
    currentBucketIndex: Math.max(0, Math.min(23, Math.floor((nowMs - DAY_START_UTC) / HOUR_MS))),
    budget: { enabled: true, dailyBudgetKWh: 60, priceShapingEnabled: true },
    state: {
      usedNowKWh: 0,
      allowedNowKWh: HOURLY_PLANNED_KWH, // ≈ the binding per-hour soft limit (kW @ top of hour)
      remainingKWh: 60,
      deviationKWh: 0,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: true,
    },
    buckets: {
      startUtc,
      startLocalLabels,
      plannedWeight,
      plannedKWh,
      actualKWh,
      allowedCumKWh,
      price: HOURLY_PRICES,
    },
  };
};

const buildDailyBudgetSnapshot = (nowMs: number): DailyBudgetUiPayload => ({
  todayKey: TODAY_KEY,
  days: { [TODAY_KEY]: buildDay(nowMs) },
});

const buildPowerTracker = (nowMs: number): PowerTrackerState => ({
  lastTimestamp: nowMs,
  objectiveProfiles: {
    [STEP_DEVICE_ID]: {
      kind: 'temperature',
      updatedAtMs: nowMs,
      lastSample: { observedAtMs: nowMs, value: 50, unit: 'degree_c' },
      kwhPerUnit: {
        sampleCount: 50,
        mean: KWH_PER_DEGREE,
        m2: 0,
        min: KWH_PER_DEGREE,
        max: KWH_PER_DEGREE,
        confidence: 'high',
        lastUpdatedMs: nowMs,
      },
      acceptedSamples: 50,
      rejectedSamples: 0,
    },
  },
});

const buildSteppedDevice = (nowMs: number): PlanInputDevice => ({
  id: STEP_DEVICE_ID,
  name: 'Priority Tank',
  controllable: true,
  controlModel: 'stepped_load',
  controlCapabilityId: 'onoff',
  steppedLoadProfile: STEP_PROFILE,
  selectedStepId: 'low',
  binaryControl: { on: true },
  currentTemperature: 50,
  lastFreshDataMs: nowMs,
  observationStale: false,
  measuredPowerKw: STEP_LOW_KW,
  expectedPowerKw: STEP_LOW_KW,
  planningPowerKw: STEP_LOW_KW,
  hasRecentObservedDrawAtSelectedStep: true,
  targets: [{ id: 'target_temperature', value: TARGET_C, unit: '°C', min: 30, max: 75, step: 1 }],
});

const buildLowerPriorityDevice = (nowMs: number): PlanInputDevice => ({
  id: LOWER_PRIORITY_ID,
  name: 'Lower Priority Heater',
  controllable: true,
  controlCapabilityId: 'onoff',
  binaryControl: { on: false },
  measuredPowerKw: 0,
  expectedPowerKw: LOWER_PRIORITY_RESTORE_KW,
  planningPowerKw: LOWER_PRIORITY_RESTORE_KW,
  observationStale: false,
  lastFreshDataMs: nowMs,
  targets: [],
});

const buildSettings = (): DeferredObjectiveSettingsV1 => ({
  version: 1,
  objectivesByDeviceId: {
    [STEP_DEVICE_ID]: {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: TARGET_C,
      deadlineAtMs: DEADLINE_AT_MS,
      rescue: { limitLowerPriorityDevices: 'always' },
    },
  },
});

type CycleResult = {
  tank: DevicePlanDevice;
  lowerPriorityShed: boolean;
  softLimitSource: string;
  dailySoftLimitKw: number | undefined;
};

const runCycleAtHour = async (hour: number): Promise<CycleResult> => {
  const nowMs = DAY_START_UTC + hour * HOUR_MS;
  vi.setSystemTime(new Date(nowMs));

  const powerTracker = buildPowerTracker(nowMs);
  const capacityGuard = new CapacityGuard({ limitKw: LIMIT_KW, softMarginKw: 0 });
  capacityGuard.reportTotalPower(STEP_LOW_KW);

  const deferredController = new DeferredObjectiveDecorationController({
    getDeferredObjectiveSettings: () => buildSettings(),
    getTimeZone: () => 'UTC',
    getPowerTracker: () => powerTracker,
    getPriceOptimizationEnabled: () => true,
    buildPriceHorizon: (start, deadline) => buildPriceHorizonFromCombined(buildCombinedPrices(), start, deadline),
    getHardCapKw: () => LIMIT_KW,
  });

  const builder = new PlanBuilder({
    homey: { settings: { set: vi.fn() } } as never,
    getCapacityGuard: () => capacityGuard,
    getCapacitySettings: () => ({ limitKw: LIMIT_KW, marginKw: 0 }),
    getOperatingMode: () => 'Home',
    getModeDeviceTargets: () => ({}),
    getPriceOptimizationEnabled: () => true,
    getPriceOptimizationSettings: () => ({}),
    isCurrentHourCheap: () => false,
    isCurrentHourExpensive: () => false,
    getPowerTracker: () => powerTracker,
    // Daily budget ON: the per-hour budget slice is the binding soft limit.
    getDailyBudgetSnapshot: () => buildDailyBudgetSnapshot(nowMs),
    decorateDeferredObjectives: (input) => deferredController.decorate(input),
    getPriorityForDevice: (deviceId) => (deviceId === STEP_DEVICE_ID ? 1 : 5),
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    log: vi.fn(),
    logDebug: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  }, createPlanEngineState());

  const snapshot = await builder.buildDevicePlanSnapshot([
    buildSteppedDevice(nowMs),
    buildLowerPriorityDevice(nowMs),
  ]);

  const tank = snapshot.devices.find((d) => d.id === STEP_DEVICE_ID);
  const lowerPriority = snapshot.devices.find((d) => d.id === LOWER_PRIORITY_ID);
  if (!tank || !lowerPriority) throw new Error('expected both devices in the plan snapshot');
  return {
    tank,
    lowerPriorityShed: lowerPriority.plannedState === 'shed',
    softLimitSource: snapshot.meta.softLimitSource,
    dailySoftLimitKw: snapshot.meta.dailySoftLimitKw,
  };
};

describe('smart-task boost — daily budget ON, per-hour budget slice is the binding constraint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('steps UP past the shed invariant in a planned (cheap) hour, with the daily budget as the binding soft limit', async () => {
    const { tank, lowerPriorityShed, softLimitSource, dailySoftLimitKw } = await runCycleAtHour(0);

    // Daily budget is ON and binds below the 5 kW hard cap.
    expect(softLimitSource).toBe('daily');
    expect(dailySoftLimitKw).toBeCloseTo(HOURLY_PLANNED_KWH, 1);

    // A lower-priority device is shed — the shed invariant would normally apply.
    expect(lowerPriorityShed).toBe(true);

    // The smart task engaged boost for this planned hour.
    expect(tank.boostActive).toBe(true);
    expect(tank.temperatureBoostActive).toBe(true);

    // Boost bypassed the shed invariant: the tank steps up to `medium`.
    expect(tank.desiredStepId).toBe('medium');
    expect(tank.reason.code).not.toBe(PLAN_REASON_CODES.shedInvariant);
    expect([PLAN_REASON_CODES.restoreNeed, PLAN_REASON_CODES.swapPending])
      .toContain(tank.reason.code);
  });

  it('is held at its lowest step in a released (expensive) hour because boost is NOT engaged', async () => {
    const { tank, lowerPriorityShed, softLimitSource } = await runCycleAtHour(1);

    expect(softLimitSource).toBe('daily'); // budget still binding
    expect(lowerPriorityShed).toBe(true);

    expect(tank.boostActive ?? false).toBe(false);
    expect(tank.temperatureBoostActive ?? false).toBe(false);

    expect(tank.desiredStepId).not.toBe('medium');
    expect(tank.reason.code).toBe(PLAN_REASON_CODES.shedInvariant);
  });
});
