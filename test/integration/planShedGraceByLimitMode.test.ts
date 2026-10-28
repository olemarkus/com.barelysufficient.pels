import { NO_INVERTER_PLANNER } from '../../lib/ports/inverterControl';
/** Period-funded pressure persistence across capacity, daily and grid control. */
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
import { withCapacityPace } from '../helpers/capacityPaceFixture';
import { testLogger } from '../utils/testLogger';

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
    hasStartedDrawingSince: () => false,
    structuredLog: testLogger,
    leaveOffOnRelease: () => 'released',
    getInferredSurplusKw: () => 0,
  inverterCurtailment: NO_INVERTER_PLANNER,
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
    getPowerTracker: () => (scenario.capacityPaceKw === null
      ? tracker
      : withCapacityPace(tracker, scenario.settings, scenario.capacityPaceKw)),
    getDailyBudgetSnapshot: () => (scenario.dailyBudget ? dailyBudgetSnapshot() : null),
    getShedBehavior: () => ({ action: 'turn_off' }),
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
  const warm = async (): Promise<void> => {
    const periodStartMs = Math.floor(START_MS / 3_600_000) * 3_600_000;
    for (const atMs of [periodStartMs - 20_000, periodStartMs - 10_000, periodStartMs, START_MS - 10_000]) {
      await build(0, [], atMs - START_MS);
    }
  };
  return { build, state, warm };
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
      const { build, state, warm } = buildHarness(scenario);
      await warm();
      // The charger was resumed 10 s ago and may still be ramping.
      recordActivationAttemptStart(state, 'charger', START_MS - 10_000);
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

    it('gives daily-only pressure the dwell even with no restore in flight', async () => {
      const { build, state, warm } = buildHarness(scenario);
      await warm();
      const plan = await build(2500, [load('charger', 1), load('heater', 2)], 0);
      expect(state.hourlyRemainingKWh).toBe(0);
      expect(plan.devices.every((device) => device.plannedState === 'keep')).toBe(true);
      expect(plan.devices.every((device) => device.reason.code !== 'hourly_budget')).toBe(true);
      const after = await build(2500, [load('charger', 1), load('heater', 2)], SHED_GRACE_MAX_MS);
      expect(after.devices.some((device) => device.plannedState === 'shed')).toBe(true);
    });
  });

  it('waits for ordinary daily pressure but acts on a projected actual-cap breach', async () => {
    const { build, warm } = buildHarness({
      settings: { capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      dailyBudget: true,
      capacityPaceKw: 5,
      hourUsedKWh: 0,
    });
    await warm();
    const devices = [load('charger', 1), load('heater', 2)];
    const first = await build(2500, devices, 0);
    expect(first.meta.softLimitSource).toBe('daily');
    expect(first.devices.every((device) => device.plannedState === 'keep')).toBe(true);
    const capacityBreach = await build(8500, devices, 10_000);
    expect(capacityBreach.devices.some((device) => device.plannedState === 'shed')).toBe(true);
  });

  it('keeps devices running when a short daily-only background spike clears', async () => {
    const { build, warm } = buildHarness({
      settings: { capacityEnabled: true, gridImportLimitKw: 10, limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      dailyBudget: true,
      capacityPaceKw: 5,
      hourUsedKWh: 0,
    });
    await warm();
    const devices = [load('heater', 1)];
    const first = await build(2500, devices, 0);
    expect(first.devices[0]?.plannedState).toBe('keep');
    const cleared = await build(1000, devices, 20_000);
    expect(cleared.devices[0]?.plannedState).toBe('keep');
  });

  it('holds an already limited device through daily grace and bypasses it for a new grid breach', async () => {
    const { build, warm } = buildHarness({
      settings: { capacityEnabled: true, gridImportLimitKw: 4, limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      dailyBudget: true,
      capacityPaceKw: 5,
      hourUsedKWh: 0,
    });
    await warm();
    const devices = [load('charger', 1), load('heater', 2, false)];
    const first = await build(2500, devices, 0);
    expect(plannedState(first, 'heater')).toBe('shed');
    expect(plannedState(first, 'charger')).toBe('keep');
    const gridBreach = await build(4000, devices, 10_000);
    expect(gridBreach.devices.find((device) => device.id === 'charger')).toMatchObject({
      plannedState: 'shed', reason: { code: 'grid_import' },
    });
  });

  // The spent period is a fact about the period, tracked with Capacity limit
  // off too; only a cycle with a capacity pace acts on it. Off — here with no
  // other limit either — the spent period sheds nothing, latches nothing, and
  // publishes no spent period, exactly as before the facts were stamped.
  it('Capacity limit off: a spent tracked period sheds, holds and labels nothing', async () => {
    const { build, state, warm } = buildHarness({
      settings: { capacityEnabled: false, gridImportLimitKw: null, limitKw: 10, marginKw: 0, periodMinutes: 60 },
      dailyBudget: false,
      capacityPaceKw: null,
      hourUsedKWh: 12,
    });
    await warm();
    const plan = await build(1000, [load('heater', 1), load('lamp', 2, false)], 0);
    expect(state.hourlyBudgetExhausted).toBe(true);
    expect(state.hourlyRemainingKWh).toBe(0);
    expect(plan.meta.hourlyBudgetExhausted).toBe(false);
    expect(plannedState(plan, 'heater')).toBe('keep');
    expect(plan.devices.every((device) => device.reason.code !== 'hourly_budget')).toBe(true);
    expect(state.sheddingActive).toBe(false);
  });

  it('Capacity limit on: the same spent period sheds everything and publishes it', async () => {
    const { build, state, warm } = buildHarness({
      settings: { capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0, periodMinutes: 60 },
      dailyBudget: false,
      capacityPaceKw: null,
      hourUsedKWh: 12,
    });
    await warm();
    const plan = await build(1000, [load('heater', 1), load('lamp', 2, false)], 0);
    expect(state.hourlyBudgetExhausted).toBe(true);
    expect(plan.meta.hourlyBudgetExhausted).toBe(true);
    expect(plannedState(plan, 'heater')).toBe('shed');
    expect(plan.devices.find((device) => device.id === 'heater')?.reason.code).toBe('hourly_budget');
  });

  it('does not buy capacity grace from a recent restore when no configured margin remains', async () => {
    const { build, state, warm } = buildHarness({
      settings: { capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0, periodMinutes: 60 },
      dailyBudget: false,
      capacityPaceKw: null,
      hourUsedKWh: 9.95,
    });
    await warm();
    recordActivationAttemptStart(state, 'charger', START_MS - 10_000);
    const first = await build(2500, [load('charger', 1), load('heater', 2)], 0);
    expect(state.hourlyRemainingKWh).toBeCloseTo(0.05, 9);
    expect(first.meta.softLimitSource).toBe('capacity');
    expect(first.devices.some((device) => device.plannedState === 'shed')).toBe(true);
  });

  it('a grid breach ends the soft-deficit clock, so a capacity deficit after it gets its own grace', async () => {
    const { build, state, warm } = buildHarness({
      // A 3.5 kW capacity pace under a 3.8 kW grid target (4 kW limit).
      settings: { capacityEnabled: true, gridImportLimitKw: 4, limitKw: 10, marginKw: 0.2, periodMinutes: 60 },
      dailyBudget: false,
      capacityPaceKw: 3.5,
      hourUsedKWh: 0,
    });
    await warm();
    recordActivationAttemptStart(state, 'charger', START_MS - 10_000);

    // A capacity deficit (0.06 kW) while the charger may still be ramping: in grace.
    const first = await build(3560, [load('charger', 1), load('heater', 2)], 0);
    expect(first.devices.every((device) => device.plannedState === 'keep')).toBe(true);

    // Over the grid target: shed at once, without the grace — one device covers it.
    const breach = await build(4000, [load('charger', 1), load('heater', 2)], 30_000);
    expect(breach.devices.some((device) => device.reason.code === 'grid_import')).toBe(true);
    const shedIds = breach.devices.filter((device) => device.plannedState === 'shed').map((device) => device.id);
    const stillOn = ['charger', 'heater'].filter((id) => !shedIds.includes(id));
    expect(stillOn).not.toEqual([]);

    // Back under the grid target, over the capacity pace again, 70 s after the
    // first deficit: past the grace that deficit had, but this is a new soft
    // deficit with remaining margin allowance, so no additional device is
    // limited yet. Activation attribution is not the permission to wait.
    const after = await build(3560, [
      ...stillOn.map((id) => load(id, id === 'charger' ? 1 : 2)),
      ...shedIds.map((id) => load(id, id === 'charger' ? 1 : 2, false)),
    ], 70_000);
    for (const id of stillOn) expect(plannedState(after, id)).toBe('keep');
  });
});
