// Planner-layer cover for home-battery storage relief: the battery spends
// stored energy against the deficit BEFORE shedding selection, and without a
// usable battery the shed is exactly what it is today. Drives the real
// `PlanBuilder` end to end; only its outward seams are fixtures.
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import type { DevicePlan, PlanInputDevice } from '../../lib/plan/planTypes';
import type {
  ObservedStorageInput,
  StoragePlanInputKind,
} from '../../packages/planner-types/src/planInputDevice';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import { hasStorageDecision, type StorageDecision } from '../../lib/planContract/storageDecision';
import {
  STORAGE_IDLE_RELEASE_MS,
  STORAGE_INPUT_MISSING_RELEASE_MS,
  STORAGE_RELIEF_SETTLE_WINDOW_MS,
  STORAGE_SURPLUS_RELEASE_DWELL_MS,
} from '../../lib/plan/battery/storageRelief';
import { DELIVERY_CEILING_TTL_MS } from '../../lib/battery/batteryVerification';
import { SURPLUS_ABSORB_SETTLE_MS } from '../../lib/plan/admission/surplusAbsorb';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { PriceLevel } from '../../lib/price/priceLevels';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import type { PowerTrackerState } from '../../lib/power/tracker';

const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 9, 5, 12, 10, 0);
const HOUR_KEY = new Date(Date.UTC(2026, 9, 5, 12, 0, 0)).toISOString();

const heater = (on = true, kw = 2, id = 'heater'): PlanInputDevice => buildPlanInputDevice({
  id,
  name: id,
  controllable: true,
  binaryControl: { on },
  currentDrawKw: on ? kw : 0,
  expectedPowerKw: kw,
});

const battery = (overrides: Partial<ObservedStorageInput> = {}): PlanInputDevice & StoragePlanInputKind => ({
  ...buildPlanInputDevice({
    id: 'battery',
    name: 'Battery',
    observeOnly: true,
    commandAuthority: false,
    binaryControllable: false,
    currentDrawKw: 0,
  }),
  storage: {
    reading: 'observed',
    range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false,
    stepW: 5,
    signedPowerW: 0,
    claimHeld: false,
    admissible: true,
    verdict: 'unverified',
    deliveryCeilingW: 2500,
    chargeCeilingW: 2500,
    ...overrides,
  },
});

/** The pump is opted into "Run on solar surplus"; nothing else is. */
const SURPLUS_SETTINGS = {
  pump: { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true, surplusDelta: 0 },
  tank: { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true, surplusDelta: 0 },
};

/** A Connected 300-like water heater on "Match solar surplus": Off / Low / Medium / Max, at `stepId`. */
const steppedTank = (stepId: string, drawKw: number): PlanInputDevice => buildPlanInputDevice({
  id: 'tank',
  name: 'tank',
  controllable: true,
  currentOn: true,
  commandableNow: true,
  surplusTracking: true,
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'medium', planningPowerW: 1750 },
      { id: 'max', planningPowerW: 3000 },
    ],
  },
  selectedStepId: stepId,
  reportedStepId: stepId,
  currentDrawKw: drawKw,
  expectedPowerKw: 3,
} as Parameters<typeof buildPlanInputDevice>[0]);

/** An on/off load that runs only on solar surplus (the producer's `surplusOnly` posture), 1 kW unless said. */
const pump = (on: boolean, kw = 1, drawKw = kw): PlanInputDevice => buildPlanInputDevice({
  id: 'pump',
  name: 'pump',
  controllable: true,
  binaryControl: { on },
  currentDrawKw: on ? drawKw : 0,
  expectedPowerKw: kw,
  surplusOnly: true,
});

/** A binding daily budget: 1.1 kWh an hour against a 100 kW capacity limit. */
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
  /** The capacity pace override, kW, or `null` to pace from the limit and the hour's usage. */
  paceKw: number | null;
  limitKw?: number;
  dailyBudget?: boolean;
  hourUsedKWh?: number;
};

const buildHarness = (scenario: Scenario) => {
  const state = createPlanEngineState();
  const tracker: PowerTrackerState = {
    lastTimestamp: START_MS,
    lastPowerW: 0,
    ...(scenario.hourUsedKWh !== undefined ? { buckets: { [HOUR_KEY]: scenario.hourUsedKWh } } : {}),
  };
  const builder = new PlanBuilder({
    leaveOffOnRelease: () => 'released',
    getInferredSurplusKw: () => 0,
    getCapacityDryRun: () => false,
    setCapacityInShortfall: vi.fn(),
    capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => ({ limitKw: scenario.limitKw ?? 10, marginKw: 0, periodMinutes: 60 }),
    resolveTemperatureSetpoints: fixtureTemperatureSetpoints({
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getPriceOptimizationSettings: () => SURPLUS_SETTINGS,
      getShedBehavior: () => ({ action: 'turn_off' }),
    }),
    getPriceOptimizationSettings: () => SURPLUS_SETTINGS,
    getPowerTracker: () => tracker,
    getDailyBudgetSnapshot: () => (scenario.dailyBudget === true ? dailyBudgetSnapshot() : null),
    getDynamicSoftLimitOverride: () => scenario.paceKw,
    getShedBehavior: () => ({ action: 'turn_off' }),
    log: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
    decorateDeferredObjectives: decorateWithoutDeferredObjectives,
  }, state);
  /** One build on a new whole-home reading, `afterMs` after the start. */
  const build = async (houseW: number, devices: PlanInputDevice[], afterMs = 0): Promise<DevicePlan> => {
    vi.setSystemTime(new Date(START_MS + afterMs));
    tracker.lastTimestamp = START_MS + afterMs;
    tracker.lastPowerW = houseW;
    return builder.buildDevicePlanSnapshot(devices);
  };
  return { build, state };
};

const plannedState = (plan: DevicePlan, id: string): string | undefined => (
  plan.devices.find((device) => device.id === id)?.plannedState
);

const storageDecision = (plan: DevicePlan): StorageDecision | undefined => {
  const device = plan.devices.find((entry) => entry.id === 'battery');
  return device !== undefined && hasStorageDecision(device) ? device.storageDecision : undefined;
};

describe('storage relief in the plan build', () => {
  it('preserves an expired battery hand-back when the Main plan is empty', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    await build(4200, [heater(), battery()]);
    const missing = await build(2000, [], 1000);
    expect(missing.storageReleases).toEqual([]);
    const expired = await build(2000, [], 1000 + STORAGE_INPUT_MISSING_RELEASE_MS);
    expect(expired.devices).toEqual([]);
    expect(expired.storageReleases).toEqual([{ deviceId: 'battery', reason: 'not_admissible' }]);
  });

  it('does not shed for discharge while a hand-back is deferred', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const plan = await build(2500, [heater(), battery({
      signedPowerW: -1500, claimHeld: true, admissible: false, handBackDeferred: true,
    })]);
    expect(plannedState(plan, 'heater')).toBe('keep');
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START_MS));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('covers the deficit with the battery and sheds nothing', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const plan = await build(4200, [heater(), battery()]);

    // The 1.2 kW deficit, plus half the 200 W deadband as the increase's hysteresis.
    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -1300, stepW: 5 });
    expect(plannedState(plan, 'heater')).toBe('keep');
  });

  it('sheds the heater once a battery that never moved stops being credited', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    await build(4200, [heater(), battery()]);
    const lapsed = await build(4200, [heater(), battery()], STORAGE_RELIEF_SETTLE_WINDOW_MS);

    expect(plannedState(lapsed, 'heater')).toBe('shed');
  });

  it.each([
    ['without a battery', [] as PlanInputDevice[]],
    ['with a flat battery', [battery({ deliveryCeilingW: 0 })]],
    ['with a battery that is not responding', [battery({ verdict: 'not_responding' })]],
    ['with a battery the owner opted out', [battery({ admissible: false })]],
    ['with an inverted-sign battery', [battery({ verdict: 'sign_inverted' })]],
  ])('sheds exactly as today %s', async (_label, batteries) => {
    const { build } = buildHarness({ paceKw: 3 });
    const plan = await build(4200, [heater(), ...batteries]);

    expect(plannedState(plan, 'heater')).toBe('shed');
    const decision = storageDecision(plan);
    expect(decision === undefined || decision.kind === 'release').toBe(true);
  });

  it('relieves the daily-budget pace when it binds', async () => {
    const { build } = buildHarness({ paceKw: null, limitKw: 100, dailyBudget: true });
    const plan = await build(2500, [heater(), battery()]);

    expect(plan.meta.softLimitSource).toBe('daily');
    expect(storageDecision(plan)).toMatchObject({ kind: 'setpoint' });
    expect(plannedState(plan, 'heater')).toBe('keep');
  });

  it('relieves an exhausted hour: only the import it deliberately leaves is shed, not everything', async () => {
    const { build, state } = buildHarness({ paceKw: null, limitKw: 5, hourUsedKWh: 6 });
    const devices = [heater(true, 1.9), heater(true, 0.3, 'lamp'), battery()];
    const plan = await build(2200, devices);

    expect(state.hourlyBudgetExhausted).toBe(true);
    // The whole draw but half the deadband, so relief never tips into export.
    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -2100, stepW: 5 });
    expect([plannedState(plan, 'heater'), plannedState(plan, 'lamp')].filter((s) => s === 'shed')).toHaveLength(1);
  });

  it('still sheds everything in an exhausted hour without a battery', async () => {
    const { build } = buildHarness({ paceKw: null, limitKw: 5, hourUsedKWh: 6 });
    const plan = await build(2200, [heater(true, 1.9), heater(true, 0.3, 'lamp')]);

    expect(plannedState(plan, 'heater')).toBe('shed');
    expect(plannedState(plan, 'lamp')).toBe('shed');
  });

  it('never restores a device into headroom the battery\'s discharge made', async () => {
    const run = async (withBattery: boolean): Promise<DevicePlan> => {
      const { build } = buildHarness({ paceKw: 4 });
      // A deficit claims the battery; the lamp is off.
      await build(5600, [heater(false, 0.5, 'lamp'), ...(withBattery ? [battery()] : [])]);
      // Minutes on, the background has dropped and the battery delivers: the
      // meter shows two kilowatts of room the lamp would fit in. (The first
      // cycle after the episode sits in the shed cooldown; the next decides.)
      const later = [
        heater(false, 0.5, 'lamp'),
        ...(withBattery ? [battery({ signedPowerW: -1700, claimHeld: true })] : []),
      ];
      await build(2000, later, 6 * 60_000);
      return build(2000, later, 9 * 60_000);
    };

    const control = await run(false);
    expect(plannedState(control, 'lamp')).toBe('keep');
    expect(plannedState(await run(true), 'lamp')).not.toBe('keep');
  });

  it('sheds in the cycle that hands back a discharging battery', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    await build(4200, [heater(), battery()]);
    // The battery delivered and the house sits at its pace; then the owner opts it out.
    const optedOut = battery({ signedPowerW: -1300, claimHeld: true, admissible: false });
    const plan = await build(2900, [heater(), optedOut], 2 * 60_000);

    expect(storageDecision(plan)).toEqual({ kind: 'release', reason: 'not_admissible' });
    expect(plannedState(plan, 'heater')).toBe('shed');
  });

  it('keeps an unread hold uncredited, then hands it back and sheds in that cycle', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    await build(4200, [heater(), battery()]);
    // The battery delivered, then stopped reporting: no power reading, still held.
    const unread: PlanInputDevice & StoragePlanInputKind = {
      ...buildPlanInputDevice({
        id: 'battery', name: 'Battery', observeOnly: true, commandAuthority: false, binaryControllable: false, unmetered: true,
      }),
      storage: { reading: 'missing', handBackDeferred: false, claimHeld: true, admissible: true },
    };
    const kept = await build(2900, [heater(), unread], 60_000);
    expect(storageDecision(kept)).toEqual({ kind: 'setpoint', setpointW: -1300, stepW: 5 });
    expect(plannedState(kept, 'heater')).toBe('keep');

    const released = await build(2900, [heater(), unread], 60_000 + STORAGE_INPUT_MISSING_RELEASE_MS);
    expect(storageDecision(released)).toEqual({ kind: 'release', reason: 'input_missing' });
    expect(plannedState(released, 'heater')).toBe('shed');
  });

  it('holds a steady setpoint and sheds nothing under ±50–200 W of noise', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    let plan = await build(4200, [heater(), battery()]);
    const noiseW = [150, -120, 80, -200, 60, -50, 190, -90, 120, -160, 70, -60];
    const setpoints: number[] = [];
    let atMs = 40_000;
    for (const delta of noiseW) {
      const decision = storageDecision(plan);
      const setpointW = decision?.kind === 'setpoint' ? decision.setpointW : 0;
      // The battery follows its setpoint; the house moves with the noise.
      plan = await build(4200 + delta + setpointW, [heater(), battery({ signedPowerW: setpointW, claimHeld: true })], atMs);
      const next = storageDecision(plan);
      if (next?.kind === 'setpoint') setpoints.push(next.setpointW);
      expect(plannedState(plan, 'heater')).toBe('keep');
      atMs += 10_000;
    }
    const changes = setpoints.filter((value, index) => index > 0 && value !== setpoints[index - 1]).length;
    expect(changes).toBeLessThanOrEqual(3);
  });

  it('steps down on headroom and hands the battery back after ten idle minutes', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    await build(4200, [heater(), battery()]);
    // The battery delivered; the heater then stops on its own and the house
    // drops well under the pace.
    const delivered = battery({ signedPowerW: -1200, claimHeld: true });
    const stepped = await build(1000, [heater(false), delivered], 2 * 60_000);
    expect(storageDecision(stepped)).toEqual({ kind: 'setpoint', setpointW: 0, stepW: 5 });

    const idle = battery({ signedPowerW: 0, claimHeld: true });
    const holding = await build(2200, [heater(false), idle], 2 * 60_000 + STORAGE_IDLE_RELEASE_MS - 1_000);
    expect(storageDecision(holding)).toMatchObject({ kind: 'setpoint', setpointW: 0 });

    const released = await build(2200, [heater(false), idle], 2 * 60_000 + STORAGE_IDLE_RELEASE_MS);
    expect(storageDecision(released)).toEqual({ kind: 'release', reason: 'idle' });
  });
});

describe('storage charge from surplus in the plan build', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START_MS));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The setpoint a battery that follows would now be at, W. */
  const setpointOf = (plan: DevicePlan): number => {
    const decision = storageDecision(plan);
    return decision?.kind === 'setpoint' ? decision.setpointW : 0;
  };

  /**
   * Readings every 10 s from `fromMs`: the pump and a following battery move to
   * what the plan decided. `solarW` is the house's net before them.
   */
  const run = async (
    build: (houseW: number, devices: PlanInputDevice[], afterMs: number) => Promise<DevicePlan>,
    params: {
      solarW: number; pumpKw: number; fromMs: number; readings: number; batteryW: number; pumpOn: boolean;
      pumpDrawKw?: number;
    },
  ) => {
    const pumpDrawKw = params.pumpDrawKw ?? params.pumpKw;
    let { batteryW, pumpOn } = params;
    let atMs = params.fromMs;
    let plan: DevicePlan | undefined;
    const decisions: Array<StorageDecision | undefined> = [];
    for (let reading = 0; reading < params.readings; reading += 1) {
      atMs += 10_000;
      const houseW = params.solarW + batteryW + (pumpOn ? pumpDrawKw * 1000 : 0);
      plan = await build(houseW, [
        pump(pumpOn, params.pumpKw, pumpDrawKw), battery({ signedPowerW: batteryW, claimHeld: batteryW !== 0 || pumpOn }),
      ], atMs);
      decisions.push(storageDecision(plan));
      pumpOn = plannedState(plan, 'pump') === 'keep';
      batteryW = setpointOf(plan);
    }
    return { pumpOn, batteryW, atMs, decisions };
  };

  it('gives a 1.5 kW water heater the solar the battery\'s own mode was storing, and caps the battery to the rest', async () => {
    const { build } = buildHarness({ paceKw: 10 });
    // 2 kW of solar to spare, all of it soaked up by the battery's own mode: the meter reads 0.
    const plan = await build(0, [pump(false, 1.5), battery({ signedPowerW: 2000 })]);
    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: 400, stepW: 5 });

    const after = await run(build, { solarW: -2000, pumpKw: 1.5, fromMs: 0, readings: 30, batteryW: 400, pumpOn: false });
    expect(after.pumpOn).toBe(true);
    expect(after.batteryW).toBe(400);
  });

  it('claims no battery for a running heat pump: its 1.2 kW is measured, not its expected 3 kW', async () => {
    const { build, state } = buildHarness({ paceKw: 10 });
    state.surplusEligibilityByDevice.pump = { eligible: true, sinceMs: START_MS - 10 * 60_000 };
    // 3 kW of solar: the heat pump draws 1.2 kW, the battery's own mode stores 1.8 kW.
    for (let reading = 0; reading < 6; reading += 1) {
      const plan = await build(0, [pump(true, 3, 1.2), battery({ signedPowerW: 1800 })], reading * 10_000);
      expect(storageDecision(plan)).toBeUndefined();
      expect(plannedState(plan, 'pump')).toBe('keep');
    }
  });

  it('lets a held battery store what a running device does not draw, so nothing is exported', async () => {
    const { build } = buildHarness({ paceKw: 10 });
    // 3 kW of solar, all stored by the battery's own mode, and a heat pump expected at 2.5 kW waiting.
    const first = await build(0, [pump(false, 2.5), battery({ signedPowerW: 3000 })]);
    expect(storageDecision(first)).toEqual({ kind: 'setpoint', setpointW: 400, stepW: 5 });

    // It starts, but draws only 1.2 kW: the battery takes back the rest (paced), not the export.
    const after = await run(build, {
      solarW: -3000, pumpKw: 2.5, pumpDrawKw: 1.2, fromMs: 0, readings: 60, batteryW: 400, pumpOn: false,
    });
    expect(after.pumpOn).toBe(true);
    expect(-3000 + after.batteryW + 1200).toBeGreaterThanOrEqual(-200);
  });

  it('turns a surplus device off when the battery\'s own mode discharges to keep it running, without claiming it', async () => {
    const { build, state } = buildHarness({ paceKw: 10 });
    // A 3 kW water heater engaged just now on 2.8 kW of solar and a 0.3 kW house:
    // the battery's own mode discharges the missing 0.5 kW, so the meter reads 0.
    state.surplusEligibilityByDevice.pump = { eligible: true, sinceMs: START_MS };
    let shedAtMs = Number.POSITIVE_INFINITY;
    for (let atMs = 0; atMs <= 4 * 60_000 && shedAtMs === Number.POSITIVE_INFINITY; atMs += 10_000) {
      const plan = await build(0, [pump(true, 3), battery({ signedPowerW: -500 })], atMs);
      expect(storageDecision(plan)).toBeUndefined();
      if (plannedState(plan, 'pump') === 'shed') shedAtMs = atMs;
    }
    // It yields after the settle window, as it would to visible import, not the five-minute dwell.
    expect(shedAtMs).toBeLessThanOrEqual(SURPLUS_ABSORB_SETTLE_MS + 10_000);
  });

  it('steps a surplus tracker at Max down at once when the battery\'s own mode discharges to keep it there', async () => {
    const { build, state } = buildHarness({ paceKw: 10 });
    // The SHS run: the tank climbed to Max (3 kW) on 2.8 kW of solar and a 0.3 kW
    // house; the battery's own mode discharges the missing 0.5 kW, so the meter reads 0.
    state.surplusEligibilityByDevice.tank = { eligible: true, sinceMs: START_MS - 10 * 60_000 };
    state.surplusTrackingByDevice.tank = { kind: 'rung', stepId: 'max', funded: true };
    const desiredStep = (plan: DevicePlan): unknown => plan.devices.find((device) => device.id === 'tank')?.desiredStepId;

    // The pool is 0 W exported + its own 3 kW - the 0.5 kW discharge = 2.5 kW:
    // Medium (1.75 kW) is the highest rung it buys with the reserve. Drops are not paced.
    const first = await build(0, [steppedTank('max', 3), battery({ signedPowerW: -500 })]);
    expect(desiredStep(first)).toBe('medium');
    expect(storageDecision(first)).toBeUndefined();

    // A tank slow to follow is asked for Medium every reading, never Max again.
    for (let atMs = 10_000; atMs <= 3 * 60_000; atMs += 10_000) {
      const plan = await build(0, [steppedTank('max', 3), battery({ signedPowerW: -500 })], atMs);
      expect(desiredStep(plan)).toBe('medium');
      expect(storageDecision(plan)).toBeUndefined();
    }
    // Once it follows, the battery's own mode stores the 0.75 kW left, and Medium holds.
    const settled = await build(0, [steppedTank('medium', 1.75), battery({ signedPowerW: 750 })], 3 * 60_000 + 10_000);
    expect(desiredStep(settled)).toBe('medium');
    expect(storageDecision(settled)).toBeUndefined();
  });

  it('offers the devices nothing of a battery exporting in the evening, and claims it for nothing', async () => {
    const { build } = buildHarness({ paceKw: 10 });
    // Its own mode trades: it discharges 5 kW and the house exports all of it.
    let plan = await build(-5000, [pump(false), battery({ signedPowerW: -5000 })]);
    for (let reading = 1; reading <= 12; reading += 1) {
      plan = await build(-5000, [pump(false), battery({ signedPowerW: -5000 })], reading * 10_000);
      expect(storageDecision(plan)).toBeUndefined();
    }
    expect(plannedState(plan, 'pump')).toBe('shed');
  });

  it('offers the devices nothing of a battery charging from the grid, and claims it for nothing', async () => {
    const { build } = buildHarness({ paceKw: 10 });
    // No export: the house imports 0.5 kW while the battery's own mode charges 2 kW.
    // Its charge would fund the pump if it were offered.
    let plan = await build(500, [pump(false), battery({ signedPowerW: 2000 })]);
    for (let reading = 1; reading <= 12; reading += 1) {
      plan = await build(500, [pump(false), battery({ signedPowerW: 2000 })], reading * 10_000);
      expect(storageDecision(plan)).toBeUndefined();
    }
    expect(plannedState(plan, 'pump')).toBe('shed');
  });

  it('claims no battery for a willing device the surplus could never fund', async () => {
    const { build } = buildHarness({ paceKw: 10 });
    // 1 kW exported, and 1 kW stored, can never run a 3 kW load: the battery's own mode may have it.
    const plan = await build(-1000, [pump(false, 3), battery({ signedPowerW: 1000 })]);
    expect(storageDecision(plan)).toBeUndefined();
  });

  it('claims no battery while no willing device wants the surplus', async () => {
    const { build } = buildHarness({ paceKw: 10 });
    const plan = await build(0, [heater(false), battery({ signedPowerW: 3000 })]);
    expect(storageDecision(plan)).toBeUndefined();
  });

  it('keeps a 2 kW device\'s cap on a 2 kW own-mode charge while the device draws', async () => {
    const { build } = buildHarness({ paceKw: 10 });
    // 2.4 kW of solar: the battery's own mode stores 2 kW, 0.4 kW is exported.
    const first = await build(-400, [pump(false, 2), battery({ signedPowerW: 2000 })]);
    expect(storageDecision(first)).toEqual({ kind: 'setpoint', setpointW: 300, stepW: 5 });

    const after = await run(build, { solarW: -2400, pumpKw: 2, fromMs: 0, readings: 60, batteryW: 300, pumpOn: false });
    expect(after.pumpOn).toBe(true);
    expect(after.decisions.every((decision) => decision?.kind === 'setpoint')).toBe(true);
    expect(after.batteryW).toBe(300);
  });

  it('hands a cap back within the dwell when a cloud ends the surplus, so its own mode covers the house', async () => {
    const { build } = buildHarness({ paceKw: 10 });
    await build(0, [pump(false, 1.5), battery({ signedPowerW: 2000 })]);
    const sunny = await run(build, { solarW: -2000, pumpKw: 1.5, fromMs: 0, readings: 30, batteryW: 400, pumpOn: false });
    expect(sunny.pumpOn).toBe(true);

    // The cloud: 300 W of house load and no solar.
    const cloudy = await run(build, {
      solarW: 300, pumpKw: 1.5, fromMs: sunny.atMs, readings: 2 + STORAGE_SURPLUS_RELEASE_DWELL_MS / 10_000,
      batteryW: sunny.batteryW, pumpOn: true,
    });
    expect(cloudy.decisions[0]).toMatchObject({ kind: 'setpoint', setpointW: 0 });
    expect(cloudy.decisions).toContainEqual({ kind: 'release', reason: 'surplus_dwell' });
  });

  it('hands a cap back within the dwell once the device it was for is satisfied', async () => {
    const { build, state } = buildHarness({ paceKw: 10 });
    await build(0, [pump(false, 1.5), battery({ signedPowerW: 2000 })]);
    state.surplusEligibilityByDevice.pump = { eligible: true, sinceMs: START_MS };
    // The tank reached its temperature: on, but drawing nothing.
    let plan: DevicePlan | undefined;
    // The cap was last needed when PELS claimed it, at the first reading.
    for (let atMs = 10_000; atMs <= STORAGE_SURPLUS_RELEASE_DWELL_MS; atMs += 10_000) {
      plan = await build(-1600, [pump(true, 1.5, 0), battery({ signedPowerW: 400, claimHeld: true })], atMs);
    }
    expect(plan === undefined ? undefined : storageDecision(plan)).toEqual({ kind: 'release', reason: 'surplus_dwell' });
  });

  it('hands a full battery back at once, and does not claim it again while it stays full', async () => {
    const { build } = buildHarness({ paceKw: 10 });
    await build(0, [pump(false, 1.5), battery({ signedPowerW: 2000 })]);
    const full = await build(-2000, [pump(false, 1.5), battery({ signedPowerW: 0, claimHeld: true, chargeCeilingW: 0 })], 10_000);
    expect(storageDecision(full)).toEqual({ kind: 'release', reason: 'full' });

    // Full, its own mode stores nothing: the export is the pump's, and the battery is left alone.
    for (const atMs of [20_000, DELIVERY_CEILING_TTL_MS + 20_000, 2 * DELIVERY_CEILING_TTL_MS + 20_000]) {
      const later = await build(-2000, [pump(false, 1.5), battery({ signedPowerW: 0 })], atMs);
      expect(storageDecision(later)).toBeUndefined();
    }
  });

  it('relieves a deficit instead of charging in the same build', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    await build(0, [pump(false), heater(), battery()]);
    // The house jumps to 4.2 kW while the battery still charges 1.9 kW of it.
    const plan = await build(4200, [pump(false), heater(), battery({ signedPowerW: 1900, claimHeld: true })], 10_000);
    const decision = storageDecision(plan);
    expect(decision?.kind === 'setpoint' && decision.setpointW <= 0).toBe(true);
    expect(plannedState(plan, 'heater')).toBe('keep');
  });
});
