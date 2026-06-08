// End-to-end proof that a smart task's limit-lower-priority "boost" permission
// lets a priority-1 stepped device escalate past the shed invariant ONLY during
// its planned hours, and never outside them.
//
// The scenario is the counterintuitive one from docs/technical.md: a stepped
// device is normally capped at its lowest non-zero step whenever ANY other
// managed device is being shed (the shed invariant). A priority-1 tank therefore
// cannot step up just because a lower-priority device was shed for capacity — the
// freed headroom would otherwise let it climb while the shed device oscillates.
//
// A smart task with `rescue.limitLowerPriorityDevices: 'always'` flips this: in
// its PLANNED hours the deferred admission forces the device's boost on
// (`forceBoostActive`), which `isBoostEffectiveForEscalation` honours to bypass
// the shed invariant — so the device claims the lower-priority device's capacity
// and steps up. In its RELEASED hours (a cheaper hour carries the load) the task
// engages no boost, so the shed invariant pins the device at its lowest step.
//
// Nothing internal is mocked: the REAL DeferredObjectiveDecorationController
// (diagnostics → admission → forceBoostActive) is wired into the REAL PlanBuilder
// exactly as production wires it (setup/appInit/createPlanEngine.ts). The only
// inputs supplied are the Homey-SDK-boundary-shaped ones: device state, the price
// curve (via the daily-budget snapshot the planner already consumes), capacity
// settings, and the clock. The single lever between the two assertions is the
// clock hour (cheap planned hour vs expensive released hour); capacity pressure
// is held identical, so the only thing that changes the step decision is boost.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CapacityGuard from '../../lib/power/capacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  DeferredObjectiveDecorationController,
  type DeferredObjectiveSettingsV1,
} from '../../lib/objectives/deferredObjectives';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DevicePlanDevice, PlanInputDevice } from '../../lib/plan/planTypes';
import type { DailyBudgetUiPayload, DailyBudgetDayPayload } from '../../lib/dailyBudget/dailyBudgetTypes';

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
// kWh/°C aligned so a +3 °C goal needs several low-step hours and the allocator
// has to spread the load across the cheap buckets (planned) and skip the dear
// ones (released).
const KWH_PER_DEGREE = 1.5;
const DEADLINE_AT_MS = Date.UTC(2026, 4, 10, 6, 0, 0);

// Alternating cheap/expensive buckets: hour 0/2/4 are cheap (the allocator books
// them — planned hours), hour 1/3 are expensive (released — a cheaper hour
// carries the load).
const HOURLY_PRICES = [10, 50, 10, 50, 10, 50, 30, 30, 30, 30, 30, 30,
  30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];

// Capacity: only the tank draws (1.5 kW), comfortably under the 3.0 kW limit, so
// the capacity guard is NOT actively shedding this cycle (positive headroom — the
// precondition for the planner to even consider restoring/escalating). The
// lower-priority device is OFF and held shed: its 2.5 kW would not fit the 1.5 kW
// of headroom, so the restore lane cannot bring it back. That leaves a genuine
// shed device on the books while leaving 1.5 kW of headroom — enough for the
// tank's low->medium delta (0.5 kW). The ONLY thing standing between the tank and
// that headroom is the shed invariant.
const LIMIT_KW = 3.0;
const STEP_LOW_KW = 1.5;
// The off lower-priority device's restore power — deliberately larger than the
// headroom so it stays shed every cycle, regardless of the tank's boost.
const LOWER_PRIORITY_RESTORE_KW = 2.5;

const buildDay = (): DailyBudgetDayPayload => {
  const startUtc: string[] = [];
  const startLocalLabels: string[] = [];
  const plannedKWh: number[] = [];
  const plannedWeight: number[] = [];
  const allowedCumKWh: number[] = [];
  const actualKWh: number[] = [];
  for (let i = 0; i < 24; i += 1) {
    startUtc.push(new Date(DAY_START_UTC + i * HOUR_MS).toISOString());
    startLocalLabels.push(String(i).padStart(2, '0'));
    plannedKWh.push(0);
    plannedWeight.push(1);
    actualKWh.push(0);
    allowedCumKWh.push(0);
  }
  return {
    dateKey: '2026-05-10',
    timeZone: 'UTC',
    nowUtc: new Date(DAY_START_UTC).toISOString(),
    dayStartUtc: new Date(DAY_START_UTC).toISOString(),
    currentBucketIndex: 0,
    budget: { enabled: false, dailyBudgetKWh: 0, priceShapingEnabled: true },
    state: {
      usedNowKWh: 0,
      allowedNowKWh: 0,
      remainingKWh: 0,
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

const buildDailyBudgetSnapshot = (): DailyBudgetUiPayload => ({
  todayKey: '2026-05-10',
  days: { '2026-05-10': buildDay() },
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

// The priority-1 tank, capacity-based control ON, currently running at its low
// step. A smart task targets +3 °C by the deadline with the limit-lower-priority
// rescue permission set to `always` ("boost on"). No device-level boost config —
// the only thing that can engage boost is the smart task.
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
  // Calibration confirms the tank is actually drawing at its current step, so the
  // boost escalation gate (`isBoostEffectiveForEscalation`) is satisfiable.
  hasRecentObservedDrawAtSelectedStep: true,
  targets: [{ id: 'target_temperature', value: TARGET_C, unit: '°C', min: 30, max: 75, step: 1 }],
});

// A lower-priority on/off heater with no smart task. It is OFF and held shed (its
// restore power exceeds the available headroom), so it remains a shed device on
// the books every cycle — the thing that triggers the shed invariant against the
// tank.
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

// Drive ONE real plan cycle at the given clock hour with fresh planner state, and
// return the tank's plan output plus the lower-priority device's shed state.
const runCycleAtHour = async (hour: number): Promise<{
  tank: DevicePlanDevice;
  lowerPriorityShed: boolean;
}> => {
  const nowMs = DAY_START_UTC + hour * HOUR_MS;
  vi.setSystemTime(new Date(nowMs));

  const powerTracker = buildPowerTracker(nowMs);
  const capacityGuard = new CapacityGuard({ limitKw: LIMIT_KW, softMarginKw: 0 });
  // Only the tank draws; the home is under the limit so the guard is not actively
  // shedding (positive headroom) — yet the off lower-priority device stays shed.
  capacityGuard.reportTotalPower(STEP_LOW_KW);

  const deferredController = new DeferredObjectiveDecorationController({
    getDeferredObjectiveSettings: () => buildSettings(),
    getTimeZone: () => 'UTC',
    getPowerTracker: () => powerTracker,
    getPriceOptimizationEnabled: () => true,
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
    getDailyBudgetSnapshot: () => buildDailyBudgetSnapshot(),
    decorateDeferredObjectives: (input) => deferredController.decorate(input),
    // Tank is the high-priority device (1); the heater is lower priority (5) and
    // is the one capacity sheds.
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
  return { tank, lowerPriorityShed: lowerPriority.plannedState === 'shed' };
};

describe('smart-task boost — stepped escalation past the shed invariant only in planned hours (e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('steps UP past the shed invariant during a planned (cheap) hour because boost is engaged', async () => {
    // Hour 0 is a cheap, allocator-booked (planned) hour.
    const { tank, lowerPriorityShed } = await runCycleAtHour(0);

    // A lower-priority device is shed — the shed invariant would normally apply.
    expect(lowerPriorityShed).toBe(true);

    // The smart task engaged boost for this planned hour.
    expect(tank.boostActive).toBe(true);
    expect(tank.temperatureBoostActive).toBe(true);

    // Boost bypassed the shed invariant: the tank steps up to `medium`, claiming
    // the headroom a shed lower-priority device would otherwise reserve
    // (restore_need = direct admit, swap_pending = claimed via swap) — and it is
    // NOT pinned by the shed invariant.
    expect(tank.desiredStepId).toBe('medium');
    expect(tank.reason.code).not.toBe(PLAN_REASON_CODES.shedInvariant);
    expect([PLAN_REASON_CODES.restoreNeed, PLAN_REASON_CODES.swapPending])
      .toContain(tank.reason.code);
  });

  it('is held at its lowest step during a released (expensive) hour because boost is NOT engaged', async () => {
    // Hour 1 is an expensive hour; the allocator booked the load into cheaper
    // hours, so the smart task releases this hour and engages no boost.
    const { tank, lowerPriorityShed } = await runCycleAtHour(1);

    // Identical capacity pressure: the same lower-priority device is still shed.
    expect(lowerPriorityShed).toBe(true);

    // No boost this hour — the only lever that changed versus the planned hour.
    expect(tank.boostActive ?? false).toBe(false);
    expect(tank.temperatureBoostActive ?? false).toBe(false);

    // Without boost the shed invariant pins the tank at its lowest step: it does
    // NOT escalate, and the reason is explicitly the shed invariant.
    expect(tank.desiredStepId).not.toBe('medium');
    expect(tank.reason.code).toBe(PLAN_REASON_CODES.shedInvariant);
  });
});
