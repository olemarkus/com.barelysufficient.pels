/**
 * The shed grace across the power-limit modes, driven through the plan build.
 *
 * The grace defers a shed while the deficit may be a restore PELS itself is
 * driving (an activation attempt is open), and prices the wait against the
 * capacity period's remaining allowance (`resolveShedGraceMs`). Two ways the
 * independent grid import limit (PR #2668) broke that:
 *
 * - With Capacity limit off the build used to stamp a remaining allowance of
 *   0 kWh — "the period is spent" — so a restore-caused overshoot of the daily
 *   pace got no grace at all. The remaining allowance is now stamped as the
 *   fact it is (period tracking continues), and the decisions gate on Capacity
 *   limit being on: the grace is unpriced (its bounded maximum), and a tracked
 *   period that is spent sheds, holds and labels nothing.
 * - A grid breach sheds without the grace, but left the soft-deficit clock
 *   untouched, so a capacity deficit right after the breach inherited the clock
 *   started before it and could skip its grace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import { recordActivationAttemptStart } from '../../lib/plan/admission';
import { SHED_GRACE_MAX_MS } from '../../lib/plan/planConstants';
import { PriceLevel } from '../../lib/price/priceLevels';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DevicePlan, PlanInputDevice } from '../../lib/plan/planTypes';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';

const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 9, 5, 12, 10, 0);
const HOUR_KEY = new Date(Date.UTC(2026, 9, 5, 12, 0, 0)).toISOString();

/** A binding daily budget: 1.1 kWh this hour, so 1.32 kW of budget pace at 12:10. */
const dailyBudgetSnapshot = (): DailyBudgetUiPayload => {
  const dayStart = Date.UTC(2026, 9, 5, 0, 0, 0);
  const hours = 24;
  const plannedKWh = Array.from({ length: hours }, () => 1.1);
  const zeros = Array.from({ length: hours }, () => 0);
  const day: DailyBudgetDayPayload = {
    dateKey: '2026-10-05',
    timeZone: 'UTC',
    nowUtc: new Date(START_MS).toISOString(),
    dayStartUtc: new Date(dayStart).toISOString(),
    currentBucketIndex: 12,
    budget: { enabled: true, dailyBudgetKWh: 26.4, priceShapingEnabled: false },
    state: {
      usedNowKWh: 13.2,
      allowedNowKWh: 14.3,
      remainingKWh: 13.2,
      deviationKWh: 0,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: false,
    },
    buckets: {
      startUtc: Array.from({ length: hours }, (_, i) => new Date(dayStart + i * HOUR_MS).toISOString()),
      startLocalLabels: Array.from({ length: hours }, (_, i) => String(i).padStart(2, '0')),
      plannedWeight: Array.from({ length: hours }, () => 1),
      plannedKWh,
      plannedUncontrolledKWh: zeros.slice(),
      plannedControlledKWh: plannedKWh.slice(),
      actualKWh: zeros.slice(),
      actualControlledKWh: zeros.slice(),
      actualUncontrolledKWh: zeros.slice(),
      allowedCumKWh: plannedKWh.map((_, i) => 1.1 * (i + 1)),
      price: Array.from({ length: hours }, () => 30),
    },
  };
  return { todayKey: '2026-10-05', days: { '2026-10-05': day } };
};

type Scenario = {
  settings: PowerLimitSettings;
  dailyBudget: boolean;
  /** The capacity pace override, kW, or `null` to pace from the limit and the hour's usage. */
  capacityPaceKw: number | null;
  hourUsedKWh: number;
};

const buildHarness = (scenario: Scenario) => {
  const state = createPlanEngineState();
  const tracker: PowerTrackerState = {
    lastTimestamp: START_MS,
    lastPowerW: 0,
    buckets: { [HOUR_KEY]: scenario.hourUsedKWh },
  };
  const builder = new PlanBuilder({
    leaveOffOnRelease: () => 'released',
    getInferredSurplusKw: () => 0,
    getCapacityDryRun: () => false,
    setCapacityInShortfall: vi.fn(),
    capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => scenario.settings,
    resolveTemperatureSetpoints: fixtureTemperatureSetpoints({
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getPriceOptimizationSettings: () => ({}),
      getShedBehavior: () => ({ action: 'turn_off' }),
    }),
    getPriceOptimizationSettings: () => ({}),
    getPowerTracker: () => tracker,
    getDailyBudgetSnapshot: () => (scenario.dailyBudget ? dailyBudgetSnapshot() : null),
    getDynamicSoftLimitOverride: () => scenario.capacityPaceKw,
    getShedBehavior: () => ({ action: 'turn_off' }),
    log: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
    decorateDeferredObjectives: decorateWithoutDeferredObjectives,
  }, state);
  /** One build on a new whole-home reading, `afterMs` after the start. */
  const build = async (houseW: number, devices: PlanInputDevice[], afterMs: number): Promise<DevicePlan> => {
    vi.setSystemTime(new Date(START_MS + afterMs));
    tracker.lastTimestamp = START_MS + afterMs;
    tracker.lastPowerW = houseW;
    return builder.buildDevicePlanSnapshot(devices);
  };
  return { build, state };
};

const load = (id: string, priority: number, on = true) => buildPlanInputDevice({
  id,
  name: id,
  priority,
  targets: [],
  currentDrawKw: on ? 1 : 0,
  expectedPowerKw: 1,
  binaryControl: { on },
});

const plannedState = (plan: DevicePlan, id: string): string | undefined => (
  plan.devices.find((device) => device.id === id)?.plannedState
);

describe('shed grace by power-limit mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The tracked period is spent (12 kWh of a 10 kWh hour), which with Capacity
  // limit on buys no grace at all — the shape the old stamped 0 forced on every
  // capacity-off home. The 12 kWh spend the daily bucket's 1.1 kWh too, so the
  // daily pace is 0 and the whole draw is its deficit.
  describe('Capacity limit off, daily budget binding', () => {
    const scenario: Scenario = {
      settings: { capacityEnabled: false, gridImportLimitKw: null, limitKw: 10, marginKw: 0, periodMinutes: 60 },
      dailyBudget: true,
      capacityPaceKw: null,
      hourUsedKWh: 12,
    };

    it('grants a restore transient the unpriced grace, the period still tracked', async () => {
      const { build, state } = buildHarness(scenario);
      // The charger was resumed 10 s ago and may still be ramping.
      recordActivationAttemptStart(state, 'charger', 'pels_restore', START_MS - 10_000);
      const devices = [load('charger', 1), load('heater', 2)];

      // 2.5 kW against the spent daily pace: a real deficit, well above the deadband.
      const first = await build(2500, devices, 0);
      // The period is still a fact, and a spent one — but no limit spends it.
      expect(state.hourlyRemainingKWh).toBe(0);
      expect(state.hourlyBudgetExhausted).toBe(true);
      expect(first.meta.hourlyBudgetExhausted).toBe(false);
      expect(first.meta.capacitySoftLimitKw).toBeNull();
      expect(first.meta.softLimitSource).toBe('daily');
      expect(plannedState(first, 'charger')).toBe('keep');
      expect(plannedState(first, 'heater')).toBe('keep');

      // Still inside the grace: nothing is limited for the transient.
      const inside = await build(2500, devices, SHED_GRACE_MAX_MS - 10_000);
      expect(inside.devices.every((device) => device.plannedState === 'keep')).toBe(true);

      // The bounded maximum is a bound: once it is spent the deficit is shed.
      const after = await build(2500, devices, SHED_GRACE_MAX_MS);
      expect(after.devices.some((device) => device.plannedState === 'shed')).toBe(true);
    });

    it('still sheds a deficit at once when no restore of its own is in flight', async () => {
      const { build, state } = buildHarness(scenario);
      const plan = await build(2500, [load('charger', 1), load('heater', 2)], 0);
      expect(state.hourlyRemainingKWh).toBe(0);
      // Shed for the daily pace, never as a spent capacity period.
      expect(plan.devices.some((device) => device.plannedState === 'shed')).toBe(true);
      expect(plan.devices.every((device) => device.reason.code !== 'hourly_budget')).toBe(true);
    });
  });

  // The spent period is a fact about the period, tracked with Capacity limit
  // off too; only a cycle with a capacity pace acts on it. Off — here with no
  // other limit either — the spent period sheds nothing, latches nothing, and
  // publishes no spent period, exactly as before the facts were stamped.
  it('Capacity limit off: a spent tracked period sheds, holds and labels nothing', async () => {
    const { build, state } = buildHarness({
      settings: { capacityEnabled: false, gridImportLimitKw: null, limitKw: 10, marginKw: 0, periodMinutes: 60 },
      dailyBudget: false,
      capacityPaceKw: null,
      hourUsedKWh: 12,
    });
    const plan = await build(1000, [load('heater', 1), load('lamp', 2, false)], 0);
    expect(state.hourlyBudgetExhausted).toBe(true);
    expect(state.hourlyRemainingKWh).toBe(0);
    expect(plan.meta.hourlyBudgetExhausted).toBe(false);
    expect(plannedState(plan, 'heater')).toBe('keep');
    expect(plan.devices.every((device) => device.reason.code !== 'hourly_budget')).toBe(true);
    expect(state.sheddingActive).toBe(false);
  });

  it('Capacity limit on: the same spent period sheds everything and publishes it', async () => {
    const { build, state } = buildHarness({
      settings: { capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0, periodMinutes: 60 },
      dailyBudget: false,
      capacityPaceKw: null,
      hourUsedKWh: 12,
    });
    const plan = await build(1000, [load('heater', 1), load('lamp', 2, false)], 0);
    expect(state.hourlyBudgetExhausted).toBe(true);
    expect(plan.meta.hourlyBudgetExhausted).toBe(true);
    expect(plannedState(plan, 'heater')).toBe('shed');
    expect(plan.devices.find((device) => device.id === 'heater')?.reason.code).toBe('hourly_budget');
  });

  // Capacity limit on keeps pricing the wait against the period it has left:
  // 0.05 kWh of a 10 kWh hour at a 2.44 kW deficit buys about 1.5 s, not the cap.
  it('Capacity limit on: still prices the grace from the remaining period allowance', async () => {
    const { build, state } = buildHarness({
      settings: { capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0, periodMinutes: 60 },
      dailyBudget: false,
      capacityPaceKw: null,
      hourUsedKWh: 9.95,
    });
    recordActivationAttemptStart(state, 'charger', 'pels_restore', START_MS - 10_000);
    const devices = [load('charger', 1), load('heater', 2)];

    const first = await build(2500, devices, 0);
    expect(state.hourlyRemainingKWh).toBeCloseTo(0.05, 9);
    expect(first.meta.softLimitSource).toBe('capacity');
    expect(first.devices.every((device) => device.plannedState === 'keep')).toBe(true);

    const after = await build(2500, devices, 2_000);
    expect(after.devices.some((device) => device.plannedState === 'shed')).toBe(true);
  });

  it('a grid breach ends the soft-deficit clock, so a capacity deficit after it gets its own grace', async () => {
    const { build, state } = buildHarness({
      // A 3.5 kW capacity pace under a 3.8 kW grid target (4 kW limit).
      settings: { capacityEnabled: true, gridImportLimitKw: 4, limitKw: 10, marginKw: 0, periodMinutes: 60 },
      dailyBudget: false,
      capacityPaceKw: 3.5,
      hourUsedKWh: 0,
    });
    recordActivationAttemptStart(state, 'charger', 'pels_restore', START_MS - 10_000);

    // A capacity deficit (0.2 kW) while the charger may still be ramping: in grace.
    const first = await build(3700, [load('charger', 1), load('heater', 2)], 0);
    expect(first.devices.every((device) => device.plannedState === 'keep')).toBe(true);

    // Over the grid target: shed at once, without the grace — one device covers it.
    const breach = await build(4000, [load('charger', 1), load('heater', 2)], 30_000);
    expect(breach.devices.some((device) => device.reason.code === 'grid_import')).toBe(true);
    const shedIds = breach.devices.filter((device) => device.plannedState === 'shed').map((device) => device.id);
    const stillOn = ['charger', 'heater'].filter((id) => !shedIds.includes(id));
    expect(stillOn).not.toEqual([]);

    // Back under the grid target, over the capacity pace again, 70 s after the
    // first deficit: past the grace that deficit had, but this is a new soft
    // deficit and the charger's restore is still in flight, so nothing more is
    // limited yet.
    const after = await build(3700, [
      ...stillOn.map((id) => load(id, id === 'charger' ? 1 : 2)),
      ...shedIds.map((id) => load(id, id === 'charger' ? 1 : 2, false)),
    ], 70_000);
    for (const id of stillOn) expect(plannedState(after, id)).toBe('keep');
  });
});
