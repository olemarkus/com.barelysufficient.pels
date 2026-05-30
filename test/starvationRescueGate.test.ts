import CapacityGuard from '../lib/power/capacityGuard';
import { PlanBuilder } from '../lib/plan/planBuilder';
import { createPlanEngineState } from '../lib/plan/planState';
import { PLAN_REASON_CODES } from '../packages/shared-domain/src/planReasonSemantics';
import type { PowerTrackerState } from '../lib/power/tracker';
import type { DevicePlanDevice, PlanInputDevice } from '../lib/plan/planTypes';
import type { DailyBudgetUiPayload, DailyBudgetDayPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import {
  DeferredObjectiveDecorationController,
  type DeferredObjectiveSettingsV1,
  type DeferredObjectiveRescuePermissions,
} from '../lib/objectives/deferredObjectives';

// GATE TRACE (PR3 step 0): prove that a smart task carrying `rescue.exemptFromBudget`
// on a CAP-ON (controllable=true), daily-budget-starved temperature device actually
// RELIEVES the budget starvation — i.e. PELS stops shedding the device for the daily
// budget so it is served. The exemption bypasses daily-budget admission, NOT capacity
// (see notes reference_deferred_objective_admission_gate). Both halves are asserted here.

const HOUR_MS = 60 * 60 * 1000;
const DEVICE_ID = 'dev_water_heater';
const TARGET_C = 53;
const KWH_PER_DEGREE = 1.5;

const DAY_START_UTC = Date.UTC(2026, 4, 10, 0, 0, 0);
const DEADLINE_AT_MS = Date.UTC(2026, 4, 10, 6, 0, 0);

// A binding daily budget: a tiny per-hour energy allowance forces the daily soft limit
// below the (large) capacity soft limit, so softLimitSource === 'daily' and any shed of
// the managed device is attributed to the daily budget rather than capacity.
// `hoursInDay` defaults to a normal 24-hour day; a DST spring-forward day is 23
// and a fall-back day is 25. Parametrised so the gate can prove the exemption
// clears budget starvation on a long/short DST day too (days are not always 24h).
const buildDay = (hoursInDay = 24): DailyBudgetDayPayload => {
  const startUtc: string[] = [];
  const startLocalLabels: string[] = [];
  const plannedKWh: number[] = [];
  const plannedWeight: number[] = [];
  const allowedCumKWh: number[] = [];
  const actualKWh: number[] = [];
  for (let i = 0; i < hoursInDay; i += 1) {
    startUtc.push(new Date(DAY_START_UTC + i * HOUR_MS).toISOString());
    startLocalLabels.push(String(i).padStart(2, '0'));
    plannedKWh.push(0.05);
    plannedWeight.push(1);
    actualKWh.push(0);
    allowedCumKWh.push(0.05 * (i + 1));
  }
  return {
    dateKey: '2026-05-10',
    timeZone: 'UTC',
    nowUtc: new Date(DAY_START_UTC).toISOString(),
    dayStartUtc: new Date(DAY_START_UTC).toISOString(),
    currentBucketIndex: 0,
    budget: { enabled: true, dailyBudgetKWh: 1.2, priceShapingEnabled: true },
    state: {
      usedNowKWh: 0,
      allowedNowKWh: 0.05,
      remainingKWh: 1.15,
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
      price: Array.from({ length: hoursInDay }, () => 30),
    },
  };
};

const buildDailyBudgetSnapshot = (hoursInDay = 24): DailyBudgetUiPayload => ({
  todayKey: '2026-05-10',
  days: { '2026-05-10': buildDay(hoursInDay) },
});

const buildPowerTracker = (nowMs: number): PowerTrackerState => ({
  lastTimestamp: nowMs,
  objectiveProfiles: {
    [DEVICE_ID]: {
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

// Cap-ON managed temperature device, currently running (so it is a shed candidate).
const buildDevice = (nowMs: number): PlanInputDevice => ({
  id: DEVICE_ID,
  name: 'Water Heater',
  controllable: true, // capacity-based control is ON — the budget-starvation scenario
  controlModel: 'stepped_load',
  hasBinaryControl: true,
  steppedLoadProfile: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1500 },
    ],
  },
  selectedStepId: 'low',
  currentOn: true,
  currentTemperature: 50,
  lastFreshDataMs: nowMs,
  observationStale: false,
  measuredPowerKw: 1.5,
  expectedPowerKw: 1.5,
  planningPowerKw: 1.5,
  targets: [{ id: 'target_temperature', value: TARGET_C, unit: '°C', min: 30, max: 75, step: 1 }],
});

const buildSettings = (rescue?: DeferredObjectiveRescuePermissions): DeferredObjectiveSettingsV1 => ({
  version: 1,
  objectivesByDeviceId: {
    [DEVICE_ID]: {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: TARGET_C,
      deadlineAtMs: DEADLINE_AT_MS,
      ...(rescue ? { rescue } : {}),
    },
  },
});

const buildBuilder = (rescue?: DeferredObjectiveRescuePermissions, hoursInDay = 24) => {
  // Large capacity limit, zero margin — capacity never binds, so the daily budget is the
  // only soft constraint and any shed is a daily-budget shed.
  const capacityGuard = new CapacityGuard({ limitKw: 100, softMarginKw: 0 });
  capacityGuard.reportTotalPower(1.5);
  const deferredController = new DeferredObjectiveDecorationController({
    getDeferredObjectiveSettings: () => buildSettings(rescue),
    getTimeZone: () => 'UTC',
    getPowerTracker: () => buildPowerTracker(DAY_START_UTC),
    getPriceOptimizationEnabled: () => true,
    getHardCapKw: () => 100,
  });
  return new PlanBuilder({
    homey: { settings: { set: vi.fn() } } as never,
    getCapacityGuard: () => capacityGuard,
    getCapacitySettings: () => ({ limitKw: 100, marginKw: 0 }),
    getOperatingMode: () => 'Home',
    getModeDeviceTargets: () => ({}),
    getPriceOptimizationEnabled: () => true,
    getPriceOptimizationSettings: () => ({}),
    isCurrentHourCheap: () => false,
    isCurrentHourExpensive: () => false,
    getPowerTracker: () => buildPowerTracker(DAY_START_UTC),
    getDailyBudgetSnapshot: () => buildDailyBudgetSnapshot(hoursInDay),
    decorateDeferredObjectives: (input) => deferredController.decorate(input),
    getPriorityForDevice: () => 1,
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    log: vi.fn(),
    logDebug: vi.fn(),
  }, createPlanEngineState());
};

const findDevice = (devices: DevicePlanDevice[]): DevicePlanDevice => {
  const device = devices.find((d) => d.id === DEVICE_ID);
  if (!device) throw new Error(`expected device ${DEVICE_ID} in plan snapshot`);
  return device;
};

describe('starvation-rescue gate: exemptFromBudget clears daily-budget starvation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY_START_UTC));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('without exemption, a cap-on device is shed for the daily budget (budget starvation cause)', async () => {
    const builder = buildBuilder();
    const snapshot = await builder.buildDevicePlanSnapshot([buildDevice(DAY_START_UTC)]);
    const device = findDevice(snapshot.devices);

    expect(device.plannedState).toBe('shed');
    expect(device.reason.code).toBe(PLAN_REASON_CODES.dailyBudget);
    expect(device.budgetExempt).not.toBe(true);
  });

  it('with rescue.exemptFromBudget=always, the same cap-on device is NOT shed for the daily budget', async () => {
    const builder = buildBuilder({ exemptFromBudget: 'always' });
    const snapshot = await builder.buildDevicePlanSnapshot([buildDevice(DAY_START_UTC)]);
    const device = findDevice(snapshot.devices);

    // The exemption lifts the daily-budget hold: the device is kept (served), not shed for budget.
    expect(device.plannedState).not.toBe('shed');
    expect(device.reason.code).not.toBe(PLAN_REASON_CODES.dailyBudget);
    expect(device.budgetExempt).toBe(true);
  });

  // DST: a day is not always 24 hours. On a fall-back (25-hour) day the budget
  // snapshot carries 25 hourly buckets; the exemption must still clear budget
  // starvation, proving the gate relies on the snapshot's day-bucket shape rather
  // than assuming a fixed 24-hour day.
  it('on a 25-hour DST day, the exemption still clears daily-budget starvation', async () => {
    const builder = buildBuilder({ exemptFromBudget: 'always' }, 25);
    const snapshot = await builder.buildDevicePlanSnapshot([buildDevice(DAY_START_UTC)]);
    const device = findDevice(snapshot.devices);

    expect(device.plannedState).not.toBe('shed');
    expect(device.reason.code).not.toBe(PLAN_REASON_CODES.dailyBudget);
    expect(device.budgetExempt).toBe(true);
  });

  it('on a 23-hour DST day, a non-exempt device is still shed for the daily budget', async () => {
    const builder = buildBuilder(undefined, 23);
    const snapshot = await builder.buildDevicePlanSnapshot([buildDevice(DAY_START_UTC)]);
    const device = findDevice(snapshot.devices);

    expect(device.plannedState).toBe('shed');
    expect(device.reason.code).toBe(PLAN_REASON_CODES.dailyBudget);
  });
});
