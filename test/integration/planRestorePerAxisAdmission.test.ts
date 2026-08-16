import CapacityGuard from '../../lib/power/capacityGuard';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  type PlanInputDevice,
  withBinaryDiscriminant,
} from '../../lib/plan/planTypes';
import type { DailyBudgetUiPayload, DailyBudgetDayPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';

const emptyPendingStore = createPendingBinaryCommandStore({});

// Per-axis restore admission through the full plan build
// (notes/safe-pace-two-constraints.md § "Proposed model", admission-scoped).
// Prod 2026-08-01 replay: a budget-exempt water heater's own 1.25 kW projection
// inflated the binding pace, a NON-exempt thermostat was admitted out of that
// reservation (and then drew 0 W), while the heater itself could never clear
// admission against the binding pace. With the per-axis ledger the non-exempt
// candidate is capped by the MEASURED-exempt budget axis (no spending the off
// heater's projection) and the exempt candidate admits against capacity.

const HOUR_MS = 60 * 60 * 1000;
const HEATER_ID = 'dev_exempt_heater';
const THERMOSTAT_ID = 'dev_thermostat';
const DAY_START_UTC = Date.UTC(2026, 4, 10, 0, 0, 0);
const SECOND_BUILD_AT_MS = DAY_START_UTC + 10 * 60 * 1000;
// First post-shed cycle records the recovery marker and sits in a fresh 60 s
// shed cooldown; admissions surface one cycle later.
const THIRD_BUILD_AT_MS = SECOND_BUILD_AT_MS + 3 * 60 * 1000;

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

const buildHeater = (params: { on: boolean; exempt: boolean }): PlanInputDevice => withBinaryDiscriminant({
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

const buildThermostat = (on: boolean): PlanInputDevice => withBinaryDiscriminant({
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
  // Thermostat outranks the heater so the restore pass evaluates it FIRST:
  // the theft assertion needs the non-exempt candidate rejected on its own
  // axis before the exempt candidate admits (mirrors prod, where the
  // non-exempt device was admitted out of the reservation first).
  getPriorityForDevice: (deviceId: string) => (deviceId === THERMOSTAT_ID ? 1 : 100),
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  log: vi.fn(),
  logDebug: vi.fn(),
  pendingBinaryCommandStore: emptyPendingStore,
}, createPlanEngineState());

describe('per-axis restore admission through the full plan build', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY_START_UTC));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits the exempt device on the capacity axis while the non-exempt device stays budget-held', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    const tracker: { lastTimestamp: number; lastPowerW?: number } = { lastTimestamp: DAY_START_UTC };
    const builder = buildBuilder({ capacityGuard, tracker });

    // Cycle 1: both devices running (heater not yet exempt — the prod heater was
    // shed during a window where its smart task lost plannability), 3.35 kW
    // total against a ~1.1 kW pace: both get shed.
    tracker.lastPowerW = 3.35 * 1000;
    const first = await builder.buildDevicePlanSnapshot([
      buildHeater({ on: true, exempt: false }),
      buildThermostat(true),
    ]);
    expect(first.devices.map((d) => d.plannedState)).toEqual(['shed', 'shed']);

    // Cycle 2 (recovery marker + shed cooldown), cycle 3 (admissions run):
    // both off, 0.35 kW background, heater exempt again.
    vi.setSystemTime(new Date(SECOND_BUILD_AT_MS));
    tracker.lastTimestamp = SECOND_BUILD_AT_MS;
    tracker.lastPowerW = 0.35 * 1000;
    await builder.buildDevicePlanSnapshot([
      buildHeater({ on: false, exempt: true }),
      buildThermostat(false),
    ]);

    vi.setSystemTime(new Date(THIRD_BUILD_AT_MS));
    tracker.lastTimestamp = THIRD_BUILD_AT_MS;
    tracker.lastPowerW = 0.35 * 1000;
    const third = await builder.buildDevicePlanSnapshot([
      buildHeater({ on: false, exempt: true }),
      buildThermostat(false),
    ]);

    const heater = third.devices.find((d) => d.id === HEATER_ID);
    const thermostat = third.devices.find((d) => d.id === THERMOSTAT_ID);
    expect(third.meta.softLimitSource).toBe('daily');

    // The non-exempt thermostat must NOT spend the off heater's projected
    // reservation: its budget axis is pace (~1.4 kW) + measured exempt (0)
    // − background (0.35), well short of its 1.2 kW need + reserves — even
    // though the BINDING pace (pace + 1.25 kW projection) would have admitted
    // it before the per-axis ledger.
    expect(thermostat?.plannedState).toBe('shed');
    expect(thermostat?.reason.code).toBe(PLAN_REASON_CODES.dailyBudget);

    // The exempt heater admits against capacity (~100 kW limit): the deadlock
    // where its own reservation could never cover need + reserves is gone.
    expect(heater?.plannedState).not.toBe('shed');
  });
});
