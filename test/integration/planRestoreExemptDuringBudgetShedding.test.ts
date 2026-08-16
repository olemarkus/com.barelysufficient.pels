/**
 * Budget-exempt restore lane during budget-driven shedding
 * (`notes/safe-pace-two-constraints.md` § "Proposed model").
 *
 * Prod 2026-08-03 replay: a boosted budget-exempt EV charger sat pinned at its
 * lowest step with ~3 kW of free hard-cap headroom because background
 * (non-exempt) draw alone exceeded the exhausted daily-budget pace —
 * `sheddingActive` stayed latched on the binding axis and the whole restore
 * pass was skipped, so the per-axis ledger (exempt → capacity) was never
 * consulted. The lane (`shouldPlanBudgetExemptRestores` +
 * `applyBudgetExemptRestorePass`) admits exempt candidates against the
 * capacity axis in exactly that regime; non-exempt devices keep the ordinary
 * stay-off / stay-at-level marking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { applyRestorePlan } from '../../lib/plan/restore';
import type { PlanContext } from '../../lib/plan/planContext';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';
import { createPlanEngineState } from '../../lib/plan/planState';
import CapacityGuard from '../../lib/power/capacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { type PlanInputDevice, withBinaryDiscriminant } from '../../lib/plan/planTypes';
import type { DailyBudgetUiPayload, DailyBudgetDayPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';

const buildContextFields = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  devices: [],
  desiredForMode: {},
  total: 2,
  softLimit: 1.2,
  capacitySoftLimit: 7,
  dailySoftLimit: 1.2,
  softLimitSource: 'daily',
  budgetKWh: 5,
  usedKWh: 2,
  minutesRemaining: 40,
  headroomRaw: -0.8,
  headroom: -0.8,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel: { cheap: false, expensive: false },
  planningTotalKw: 2,
  powerFreshnessState: 'fresh',
  ...overrides,
} as PlanContext);

const buildContext = (overrides: Partial<PlanContext> = {}): PlanContext => {
  const base = buildContextFields(overrides);
  return {
    ...base,
    capacityHeadroomKw: overrides.capacityHeadroomKw ?? 5,
    budgetHeadroomKw: overrides.budgetHeadroomKw ?? -0.8,
  };
};

// Restore candidates enter the pass as plannedState 'keep' observed off (the
// shed pass leaves exempt devices alone under a daily-source overshoot);
// rejection is what flips them to 'shed'.
const offExemptHeater = (overrides: Parameters<typeof buildPlanDevice>[0] = {}) => buildPlanDevice({
  id: 'exempt-heater',
  name: 'Water Heater',
  priority: 2,
  currentState: 'off',
  plannedState: 'keep',
  boostActive: false,
  controllable: true,
  expectedPowerKw: 1,
  budgetExempt: true,
  ...overrides,
});

const offThermostat = () => buildPlanDevice({
  id: 'thermostat',
  name: 'Thermostat',
  priority: 5,
  currentState: 'off',
  plannedState: 'shed',
  boostActive: false,
  reason: { code: PLAN_REASON_CODES.dailyBudget },
  controllable: true,
  expectedPowerKw: 1,
});

const runLane = (params: {
  devices: ReturnType<typeof buildPlanDevice>[];
  context?: Partial<PlanContext>;
  state?: ReturnType<typeof createPlanEngineState>;
}) => {
  const state = params.state ?? createPlanEngineState();
  return applyRestorePlan({
    planDevices: params.devices,
    context: buildContext(params.context),
    state,
    sheddingActive: true,
    deps: {
      powerTracker: { lastTimestamp: Date.now() } as PowerTrackerState,
      getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
      logDebug: vi.fn(),
    },
  });
};

describe('budget-exempt restore lane during budget-driven shedding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T08:55:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits an off exempt device on the capacity axis while the latch holds; non-exempt stays budget-held', () => {
    const result = runLane({ devices: [offExemptHeater(), offThermostat()] });
    const heater = result.planDevices.find((d) => d.id === 'exempt-heater');
    const thermostat = result.planDevices.find((d) => d.id === 'thermostat');
    // A real admission, not just "left untouched": only the admit path records
    // the device in restoredThisCycle.
    expect(result.restoredThisCycle.has('exempt-heater')).toBe(true);
    expect(heater?.plannedState).not.toBe('shed');
    expect(thermostat?.plannedState).toBe('shed');
    expect(thermostat?.reason?.code).toBe(PLAN_REASON_CODES.dailyBudget);
  });

  it('rejects an exempt candidate inside the lane when the capacity axis cannot cover its need', () => {
    const result = runLane({
      devices: [offExemptHeater(), offThermostat()],
      context: { capacityHeadroomKw: 0.3 },
    });
    const heater = result.planDevices.find((d) => d.id === 'exempt-heater');
    expect(result.restoredThisCycle.has('exempt-heater')).toBe(false);
    expect(heater?.plannedState).toBe('shed');
  });

  it('steps up a boosted exempt stepper while the latch holds; a non-exempt stepper stays at its level', () => {
    const result = runLane({
      devices: [
        steppedPlanDevice({
          id: 'exempt-charger',
          name: 'EV Charger',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          boostActive: true,
          selectedStepId: 'low',
          desiredStepId: 'low',
          budgetExempt: true,
        }),
        steppedPlanDevice({
          id: 'plain-stepper',
          name: 'Heater',
          priority: 3,
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          selectedStepId: 'low',
          desiredStepId: 'low',
        }),
        offThermostat(),
      ],
    });
    const charger = result.planDevices.find((d) => d.id === 'exempt-charger');
    const plain = result.planDevices.find((d) => d.id === 'plain-stepper');
    expect(charger?.desiredStepId).toBe('medium');
    expect(charger?.reason?.code).toBe(PLAN_REASON_CODES.restoreNeed);
    expect(plain?.desiredStepId).toBe('low');
  });

  it('holds exempt candidates when the capacity axis is breached too', () => {
    const result = runLane({
      devices: [offExemptHeater(), offThermostat()],
      context: { capacityHeadroomKw: -0.5 },
    });
    const heater = result.planDevices.find((d) => d.id === 'exempt-heater');
    expect(heater?.plannedState).toBe('shed');
  });

  it('holds exempt candidates when the binding limit is capacity-derived (hysteresis-band latch)', () => {
    const result = runLane({
      devices: [offExemptHeater(), offThermostat()],
      context: { softLimitSource: 'capacity', capacitySoftLimit: 2.2, headroomRaw: 0.2, headroom: 0.2 },
    });
    const heater = result.planDevices.find((d) => d.id === 'exempt-heater');
    expect(heater?.plannedState).toBe('shed');
  });

  it('admits exactly one exempt candidate per cycle (no batch continuation)', () => {
    const result = runLane({
      devices: [
        offExemptHeater(),
        offExemptHeater({ id: 'exempt-second', name: 'Second Heater', priority: 3 }),
      ],
      context: { capacityHeadroomKw: 10 },
    });
    expect([...result.restoredThisCycle]).toEqual(['exempt-heater']);
    const admitted = result.planDevices.filter((d) => d.plannedState !== 'shed');
    expect(admitted.map((d) => d.id)).toEqual(['exempt-heater']);
  });

  it('stays one-at-a-time in the hysteresis band, where the ordinary batch builder would enable continuation', () => {
    // Latch held while binding headroom is back above zero (below the clear
    // threshold) with a fresh meter: every enabling conjunct of
    // buildRestoreBatchState holds, so ONLY the lane's explicitly-disabled
    // batch state keeps this to one admission.
    const result = runLane({
      devices: [
        offExemptHeater(),
        offExemptHeater({ id: 'exempt-second', name: 'Second Heater', priority: 3 }),
      ],
      context: {
        headroomRaw: 0.3,
        headroom: 0.3,
        capacityHeadroomKw: 10,
        budgetHeadroomKw: 10,
      },
    });
    expect([...result.restoredThisCycle]).toEqual(['exempt-heater']);
  });

  it('holds exempt candidates during the shed cooldown', () => {
    const state = createPlanEngineState();
    Object.assign(state, { lastInstabilityMs: Date.now() - 20 * 1000 });
    const result = runLane({ devices: [offExemptHeater(), offThermostat()], state });
    const heater = result.planDevices.find((d) => d.id === 'exempt-heater');
    expect(heater?.plannedState).toBe('shed');
  });
});

// Full plan build with the latch HELD: background (non-exempt) draw alone
// exceeds the daily pace the whole time, so binding headroom never reaches the
// shedding clear threshold — the regime the lane exists for. Fixture cloned
// from planRestorePerAxisAdmission.test.ts, which deliberately clears the
// latch before asserting; this spec keeps it latched.
const HOUR_MS = 60 * 60 * 1000;
const HEATER_ID = 'dev_exempt_heater';
const THERMOSTAT_ID = 'dev_thermostat';
const DAY_START_UTC = Date.UTC(2026, 4, 10, 0, 0, 0);
const SECOND_BUILD_AT_MS = DAY_START_UTC + 10 * 60 * 1000;
// First post-shed cycle records the recovery marker and sits in a fresh 60 s
// shed cooldown; admissions surface one cycle later.
const THIRD_BUILD_AT_MS = SECOND_BUILD_AT_MS + 3 * 60 * 1000;
const BACKGROUND_KW = 3.0;

const emptyPendingStore = createPendingBinaryCommandStore({});

const buildDay = (): DailyBudgetDayPayload => {
  const hours = 24;
  const startUtc: string[] = [];
  const startLocalLabels: string[] = [];
  const plannedKWh: number[] = [];
  const plannedWeight: number[] = [];
  const allowedCumKWh: number[] = [];
  const actualKWh: number[] = [];
  for (let i = 0; i < hours; i += 1) {
    startUtc.push(new Date(DAY_START_UTC + i * HOUR_MS).toISOString());
    startLocalLabels.push(String(i).padStart(2, '0'));
    plannedKWh.push(1.1);
    plannedWeight.push(1);
    actualKWh.push(0);
    allowedCumKWh.push(1.1 * (i + 1));
  }
  return {
    dateKey: '2026-05-10',
    timeZone: 'UTC',
    nowUtc: new Date(DAY_START_UTC).toISOString(),
    dayStartUtc: new Date(DAY_START_UTC).toISOString(),
    currentBucketIndex: 0,
    budget: { enabled: true, dailyBudgetKWh: 26.4, priceShapingEnabled: false },
    state: {
      usedNowKWh: 0,
      allowedNowKWh: 1.1,
      remainingKWh: 25.3,
      deviationKWh: 0,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: false,
    },
    buckets: {
      startUtc,
      startLocalLabels,
      plannedWeight,
      plannedKWh,
      plannedUncontrolledKWh: Array.from({ length: hours }, () => 0),
      plannedControlledKWh: plannedKWh.slice(),
      actualKWh,
      actualControlledKWh: Array.from({ length: hours }, () => 0),
      actualUncontrolledKWh: Array.from({ length: hours }, () => 0),
      allowedCumKWh,
      price: Array.from({ length: hours }, () => 30),
    },
  };
};

const buildDailyBudgetSnapshot = (): DailyBudgetUiPayload => ({
  todayKey: '2026-05-10',
  days: { '2026-05-10': buildDay() },
});

const buildHeaterInput = (params: { on: boolean; exempt: boolean }): PlanInputDevice => withBinaryDiscriminant({
  available: true,
  id: HEATER_ID,
  name: 'Water Heater',
  targets: [],
  commandableNow: true,
  boostSupported: false,
  boostRequested: false,
  hasStandingDemand: true,
  confirmedNotDrawing: false,
  controllable: true,
  binaryCapabilityId: 'onoff',
  binaryControl: { on: params.on },
  currentOn: params.on,
  currentDrawKw: params.on ? 1.25 : 0,
  residualKw: { shed: params.on ? 1.25 : 0 },
  expectedPowerKw: 1.25, expectedPowerSource: 'default',
  budgetExempt: params.exempt,
  lastFreshDataMs: Date.now(),
}) as PlanInputDevice;

const buildThermostatInput = (on: boolean): PlanInputDevice => withBinaryDiscriminant({
  available: true,
  id: THERMOSTAT_ID,
  name: 'Thermostat',
  targets: [],
  commandableNow: true,
  boostSupported: false,
  boostRequested: false,
  hasStandingDemand: true,
  confirmedNotDrawing: false,
  controllable: true,
  binaryCapabilityId: 'onoff',
  binaryControl: { on },
  currentOn: on,
  currentDrawKw: on ? 1.0 : 0,
  residualKw: { shed: on ? 1.0 : 0 },
  expectedPowerKw: 1.0, expectedPowerSource: 'default',
  lastFreshDataMs: Date.now(),
}) as PlanInputDevice;

const buildBuilder = (params: {
  capacityGuard: CapacityGuard;
  tracker: { lastTimestamp: number; lastPowerW?: number };
}): PlanBuilder => new PlanBuilder({
  getCapacityGuard: () => params.capacityGuard,
  setCapacityInShortfall: vi.fn(),
  getCapacitySettings: () => ({ limitKw: 100, marginKw: 0 }),
  getOperatingMode: () => 'Home',
  getModeDeviceTargets: () => ({}),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
  getPowerTracker: () => params.tracker,
  getDailyBudgetSnapshot: () => buildDailyBudgetSnapshot(),
  getPriorityForDevice: (deviceId: string) => (deviceId === THERMOSTAT_ID ? 1 : 100),
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  log: vi.fn(),
  logDebug: vi.fn(),
  pendingBinaryCommandStore: emptyPendingStore,
}, createPlanEngineState());

describe('exempt restore lane through the full plan build with the latch held', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY_START_UTC));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits the exempt device on the capacity axis while shedding stays latched on the budget axis', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    const tracker: { lastTimestamp: number; lastPowerW?: number } = { lastTimestamp: DAY_START_UTC };
    const builder = buildBuilder({ capacityGuard, tracker });

    // Cycle 1: both devices running plus background, far over the ~1.1 kW
    // pace: both get shed and the shedding latch engages.
    tracker.lastPowerW = (BACKGROUND_KW + 2.25) * 1000;
    const first = await builder.buildDevicePlanSnapshot([
      buildHeaterInput({ on: true, exempt: false }),
      buildThermostatInput(true),
    ]);
    expect(first.devices.map((d) => d.plannedState)).toEqual(['shed', 'shed']);
    expect(capacityGuard.isSheddingActive()).toBe(true);

    // Cycles 2-3: both off, heater exempt again, but the 3.0 kW background
    // alone stays above the pace (+ the heater's 1.25 kW exempt add-back), so
    // the latch never clears.
    vi.setSystemTime(new Date(SECOND_BUILD_AT_MS));
    tracker.lastTimestamp = SECOND_BUILD_AT_MS;
    tracker.lastPowerW = BACKGROUND_KW * 1000;
    await builder.buildDevicePlanSnapshot([
      buildHeaterInput({ on: false, exempt: true }),
      buildThermostatInput(false),
    ]);

    vi.setSystemTime(new Date(THIRD_BUILD_AT_MS));
    tracker.lastTimestamp = THIRD_BUILD_AT_MS;
    tracker.lastPowerW = BACKGROUND_KW * 1000;
    const third = await builder.buildDevicePlanSnapshot([
      buildHeaterInput({ on: false, exempt: true }),
      buildThermostatInput(false),
    ]);

    const heater = third.devices.find((d) => d.id === HEATER_ID);
    const thermostat = third.devices.find((d) => d.id === THERMOSTAT_ID);
    expect(third.meta.softLimitSource).toBe('daily');
    // The regime under test: the latch is still held when admissions run.
    expect(capacityGuard.isSheddingActive()).toBe(true);

    // The exempt heater admits against capacity (~100 kW limit) through the
    // restricted lane, even though the whole full pass is latch-blocked.
    expect(heater?.plannedState).not.toBe('shed');

    // The non-exempt thermostat stays budget-held.
    expect(thermostat?.plannedState).toBe('shed');
    expect(thermostat?.reason.code).toBe(PLAN_REASON_CODES.dailyBudget);
  });
});
