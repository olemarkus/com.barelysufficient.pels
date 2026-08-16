import CapacityGuard from '../../lib/power/capacityGuard';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import {
  PLAN_REASON_CODES,
  resolveRestoreShortfallKw,
} from '../../packages/shared-domain/src/planReasonSemantics';
import {
  type PlanInputDevice,
  withBinaryDiscriminant,
} from '../../lib/plan/planTypes';
import type { DailyBudgetUiPayload, DailyBudgetDayPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';

const emptyPendingStore = createPendingBinaryCommandStore({});

// Full-builder wiring regression for the `insufficientHeadroom` → `dailyBudget`
// re-attribution (prod 2026-08-01). The isolated `normalizeShedReasons` tests in
// planReasons.test.ts pass explicit flags, so they cannot catch the one line that
// wires `context.budgetReleasableHeadroomHold` through the materialization stage —
// if that line is dropped, the feature silently reverts while every isolated test
// stays green. This spec drives `PlanBuilder.buildDevicePlanSnapshot` end to end:
// shed a device in cycle 1, reject its restore on headroom in cycle 2, and assert
// the finalized reason names the constraint that actually binds.

const HOUR_MS = 60 * 60 * 1000;
const DEVICE_ID = 'dev_heater';
const DAY_START_UTC = Date.UTC(2026, 4, 10, 0, 0, 0);
const SECOND_BUILD_AT_MS = DAY_START_UTC + 10 * 60 * 1000;
// The first cycle after a shed episode records the recovery marker and sits in a
// fresh 60 s shed cooldown (`getShedCooldownState` keys on the most recent of
// instability/recovery), so the headroom rejection only surfaces one cycle later.
const THIRD_BUILD_AT_MS = SECOND_BUILD_AT_MS + 3 * 60 * 1000;

// A binding daily budget: 1.1 kWh per hourly bucket keeps the daily pace (~1.1-1.4 kW)
// below the (large) capacity soft limit, so softLimitSource === 'daily', while
// leaving positive headroom in cycle 2 (no shortfall guard) — matching the prod
// shape where restores were rejected on reserves, not on a breach.
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

const buildDevice = (on: boolean): PlanInputDevice => withBinaryDiscriminant({
  available: true,
  id: DEVICE_ID,
  name: 'Heater',
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
  currentDrawKw: on ? 1.5 : 0,
  residualKw: { shed: on ? 1.5 : 0 },
  expectedPowerKw: 1.2, expectedPowerSource: 'default',
  lastFreshDataMs: Date.now(),
}) as PlanInputDevice;

const buildBuilder = (params: {
  capacityGuard: CapacityGuard;
  limitKw: number;
  tracker: { lastTimestamp: number; lastPowerW?: number };
  dailyBudget: boolean;
}): PlanBuilder => new PlanBuilder({
  setCapacityInShortfall: vi.fn(),
  getCapacityGuard: () => params.capacityGuard,
  getCapacitySettings: () => ({ limitKw: params.limitKw, marginKw: 0 }),
  getOperatingMode: () => 'Home',
  getModeDeviceTargets: () => ({}),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
  getPowerTracker: () => params.tracker,
  getDailyBudgetSnapshot: () => (params.dailyBudget ? buildDailyBudgetSnapshot() : null),
  getPriorityForDevice: () => 100,
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  log: vi.fn(),
  logDebug: vi.fn(),
  pendingBinaryCommandStore: emptyPendingStore,
}, createPlanEngineState());

// Shed in cycle 1 (device on, draw over the binding pace), then advance past the
// shed/restore cooldowns and reject the restore in cycle 2 (device off, background
// draw leaves less available power than the restore need + reserves).
const runShedThenBlockedRestore = async (params: {
  limitKw: number;
  dailyBudget: boolean;
}) => {
  const capacityGuard = createTestCapacityGuard({ homeId: 'main', limitKw: params.limitKw, softMarginKw: 0 });
  const tracker: { lastTimestamp: number; lastPowerW?: number } = { lastTimestamp: DAY_START_UTC };
  const builder = buildBuilder({ capacityGuard, limitKw: params.limitKw, tracker, dailyBudget: params.dailyBudget });

  tracker.lastPowerW = 1.5 * 1000;
  const first = await builder.buildDevicePlanSnapshot([buildDevice(true)]);

  vi.setSystemTime(new Date(SECOND_BUILD_AT_MS));
  tracker.lastTimestamp = SECOND_BUILD_AT_MS;
  tracker.lastPowerW = 0.35 * 1000;
  await builder.buildDevicePlanSnapshot([buildDevice(false)]);

  vi.setSystemTime(new Date(THIRD_BUILD_AT_MS));
  tracker.lastTimestamp = THIRD_BUILD_AT_MS;
  tracker.lastPowerW = 0.35 * 1000;
  const third = await builder.buildDevicePlanSnapshot([buildDevice(false)]);

  const firstDevice = first.devices.find((d) => d.id === DEVICE_ID);
  const thirdDevice = third.devices.find((d) => d.id === DEVICE_ID);
  if (!firstDevice || !thirdDevice) throw new Error('expected the device in both plan snapshots');
  return { first, third, firstDevice, thirdDevice };
};

describe('budget-bound restore holds through the full plan build', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY_START_UTC));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finalizes a daily-bound blocked restore as dailyBudget, not insufficientHeadroom', async () => {
    const { first, third, firstDevice, thirdDevice } = await runShedThenBlockedRestore({
      limitKw: 100,
      dailyBudget: true,
    });

    expect(firstDevice.plannedState).toBe('shed');
    expect(first.meta.softLimitSource).toBe('daily');

    expect(third.meta.softLimitSource).toBe('daily');
    expect(third.meta.powerNowKw).not.toBeNull();
    expect(thirdDevice.plannedState).toBe('shed');
    expect(thirdDevice.reason.code).toBe(PLAN_REASON_CODES.dailyBudget);

    // The fold re-LABELS the hold; it must not drop its numbers. The card states
    // what this device needs (the hero names the binding ceiling once), so the
    // admission shortfall has to survive re-attribution — before 2026-08-02 it
    // was discarded here and the card had nothing to say.
    const shortfallKw = (thirdDevice.reason as { shortfallKw?: number | null }).shortfallKw;
    expect(shortfallKw).not.toBeNull();
    expect(shortfallKw).toBeGreaterThan(0);
    // Display-rounded at the producer, so the stored value cannot churn the
    // overview signature between cycles that render the same number.
    expect(shortfallKw).toBeCloseTo(Math.round((shortfallKw ?? 0) * 10) / 10, 10);
    expect(resolveRestoreShortfallKw(thirdDevice.reason)).toBe(shortfallKw);
  });

  it('keeps a capacity-bound blocked restore on the numeric headroom reason', async () => {
    const { third, firstDevice, thirdDevice } = await runShedThenBlockedRestore({
      limitKw: 1,
      dailyBudget: false,
    });

    expect(firstDevice.plannedState).toBe('shed');
    expect(third.meta.softLimitSource).toBe('capacity');
    expect(thirdDevice.plannedState).toBe('shed');
    expect(thirdDevice.reason.code).toBe(PLAN_REASON_CODES.insufficientHeadroom);
  });
});
