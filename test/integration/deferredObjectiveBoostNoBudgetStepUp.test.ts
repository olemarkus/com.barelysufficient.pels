// Integration proof: with NO daily budget, the hourly capacity hard cap is the
// only per-hour constraint, and a smart task's limit-lower-priority "boost"
// permission lets a priority-1 stepped device escalate past the shed invariant
// ONLY during its planned hours.
//
// Scenario (the counterintuitive shed invariant from docs/technical.md): a
// priority-1 stepped tank, capacity control ON, NO device-level boost config,
// currently at its low step. A lower-priority device is held shed (its restore
// power exceeds the available headroom), so the shed invariant normally pins the
// tank at its lowest step even though there is hard-cap headroom for a
// low -> medium step. A smart task with `rescue.limitLowerPriorityDevices:
// 'always'` flips this: in its PLANNED hours the deferred admission forces boost
// on, which `isBoostEffectiveForEscalation` honours to bypass the shed invariant.
// In RELEASED hours (a cheaper hour carries the load) no boost is engaged.
//
// What makes this the NO-BUDGET case: `getDailyBudgetSnapshot` returns null, so
// the deferred horizon sources price+grid purely from the price layer
// (`buildPriceHorizonFromCombined`) and the per-hour energy ceiling is the hard
// cap (`reservedHeadroomKw = hardCapKw`, background = 0) — not a daily-budget
// slice. Nothing internal is mocked: the REAL DeferredObjectiveDecorationController
// (price horizon -> diagnostics -> admission -> forceBoostActive) drives the REAL
// PlanBuilder, exactly as production wires it. The only lever between the two
// assertions is the clock hour (cheap planned vs expensive released); capacity
// pressure is identical, so the step decision is attributable to boost alone.
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
import type { CombinedPriceEntry, CombinedPricesV2 } from '../../lib/price/priceTypes';

const HOUR_MS = 60 * 60 * 1000;
const DAY_START_UTC = Date.UTC(2026, 4, 10, 0, 0, 0);

const STEP_DEVICE_ID = 'dev_priority_tank';
const LOWER_PRIORITY_ID = 'dev_lower_priority';

// Stepped tank: lowest non-zero step is `low`; `medium` is the next step up. The
// shed invariant only ever blocks stepping ABOVE `low`, so `low -> medium` is the
// escalation under test.
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

// Alternating cheap/expensive hours: hour 0/2/4 cheap (allocator books them —
// planned), hour 1/3 expensive (released — a cheaper hour carries the load).
const HOURLY_PRICES = [10, 50, 10, 50, 10, 50, 30, 30, 30, 30, 30, 30,
  30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];

// Capacity: only the tank draws (1.5 kW), under the 3.0 kW hard cap, so the guard
// is NOT actively shedding (positive headroom — the precondition for the planner
// to consider escalating). The lower-priority device is OFF and held shed (its
// 2.5 kW restore would not fit the 1.5 kW of headroom). That leaves a genuine shed
// device on the books with 1.5 kW of hard-cap headroom — enough for the tank's
// low->medium delta (0.5 kW). The ONLY thing between the tank and that headroom is
// the shed invariant. There is NO daily budget; the hard cap is the constraint.
const LIMIT_KW = 3.0;
const STEP_LOW_KW = 1.5;
const LOWER_PRIORITY_RESTORE_KW = 2.5;

// Price-layer source for the allocation horizon (UTC day ⇒ hour-aligned), built
// from the same HOURLY_PRICES so the cheap/expensive shaping flows through the
// real producer. NO daily-budget snapshot is involved.
const buildCombinedPrices = (): CombinedPricesV2 => {
  const hours: CombinedPriceEntry[] = HOURLY_PRICES.map((total, i) => ({
    startsAt: new Date(DAY_START_UTC + i * HOUR_MS).toISOString(),
    total,
    isCheap: false,
    isExpensive: false,
  }));
  return {
    version: 2,
    days: { '2026-05-10': { hours } },
    avgPrice: 0,
    lowThreshold: 0,
    highThreshold: 0,
    priceScheme: 'norway',
    priceUnit: 'øre/kWh',
  };
};

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

// The priority-1 tank, capacity control ON, running at its low step. A smart task
// targets +3 °C by the deadline with the limit-lower-priority rescue set to
// `always` ("boost on"). No device-level boost config — the only thing that can
// engage boost is the smart task.
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
  // Calibration confirms the tank draws at its current step, so the boost
  // escalation gate (`isBoostEffectiveForEscalation`) is satisfiable.
  hasRecentObservedDrawAtSelectedStep: true,
  targets: [{ id: 'target_temperature', value: TARGET_C, unit: '°C', min: 30, max: 75, step: 1 }],
});

// A lower-priority on/off heater with no smart task. It is OFF and held shed (its
// restore power exceeds the hard-cap headroom), so it remains a shed device every
// cycle — the thing that triggers the shed invariant against the tank.
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
      // "boost on": claim capacity from lower-priority devices in planned hours.
      rescue: { limitLowerPriorityDevices: 'always' },
    },
  },
});

type CycleResult = {
  tank: DevicePlanDevice;
  lowerPriorityShed: boolean;
  softLimitSource: string;
};

// Drive ONE real plan cycle at the given clock hour with fresh planner state.
const runCycleAtHour = async (hour: number): Promise<CycleResult> => {
  const nowMs = DAY_START_UTC + hour * HOUR_MS;
  vi.setSystemTime(new Date(nowMs));

  const powerTracker = buildPowerTracker(nowMs);
  const capacityGuard = new CapacityGuard({ limitKw: LIMIT_KW, softMarginKw: 0 });
  // Only the tank draws; under the cap ⇒ guard not actively shedding (positive
  // headroom), yet the off lower-priority device stays shed.
  capacityGuard.reportTotalPower(STEP_LOW_KW);

  const deferredController = new DeferredObjectiveDecorationController({
    getDeferredObjectiveSettings: () => buildSettings(),
    getTimeZone: () => 'UTC',
    getPowerTracker: () => powerTracker,
    getPriceOptimizationEnabled: () => true,
    // Price horizon sourced from the price layer — NOT a daily-budget snapshot.
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
    // NO daily budget: the hourly hard cap is the per-hour constraint.
    getDailyBudgetSnapshot: () => null,
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
  };
};

describe('smart-task boost — no daily budget, hourly hard cap as the per-hour constraint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('steps UP past the shed invariant in a planned (cheap) hour, with the hard cap as the only per-hour limit', async () => {
    const { tank, lowerPriorityShed, softLimitSource } = await runCycleAtHour(0);

    // No daily budget: the soft limit is the capacity hard cap, not a daily slice.
    expect(softLimitSource).toBe('capacity');

    // A lower-priority device is shed — the shed invariant would normally apply.
    expect(lowerPriorityShed).toBe(true);

    // The smart task engaged boost for this planned hour.
    expect(tank.boostActive).toBe(true);
    expect(tank.temperatureBoostActive).toBe(true);

    // Boost bypassed the shed invariant: the tank steps up to `medium`, claiming
    // the hard-cap headroom a shed lower-priority device would otherwise reserve.
    expect(tank.desiredStepId).toBe('medium');
    expect(tank.reason.code).not.toBe(PLAN_REASON_CODES.shedInvariant);
    expect([PLAN_REASON_CODES.restoreNeed, PLAN_REASON_CODES.swapPending])
      .toContain(tank.reason.code);
  });

  it('is held at its lowest step in a released (expensive) hour because boost is NOT engaged', async () => {
    const { tank, lowerPriorityShed, softLimitSource } = await runCycleAtHour(1);

    expect(softLimitSource).toBe('capacity'); // still no daily budget
    // Identical capacity pressure: the same lower-priority device is still shed.
    expect(lowerPriorityShed).toBe(true);

    // No boost this hour — the only lever that changed versus the planned hour.
    expect(tank.boostActive ?? false).toBe(false);
    expect(tank.temperatureBoostActive ?? false).toBe(false);

    // Without boost the shed invariant pins the tank at its lowest step.
    expect(tank.desiredStepId).not.toBe('medium');
    expect(tank.reason.code).toBe(PLAN_REASON_CODES.shedInvariant);
  });
});
