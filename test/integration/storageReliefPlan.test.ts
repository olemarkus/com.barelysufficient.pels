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
} from '../../lib/plan/battery/storageRelief';
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
    stepW: 5,
    signedPowerW: 0,
    claimHeld: false,
    admissible: true,
    verdict: 'unverified',
    deliveryCeilingW: 2500,
    ...overrides,
  },
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
      getPriceOptimizationSettings: () => ({}),
      getShedBehavior: () => ({ action: 'turn_off' }),
    }),
    getPriceOptimizationSettings: () => ({}),
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
      storage: { reading: 'missing', claimHeld: true, admissible: true },
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
