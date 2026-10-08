// Planner-layer cover for the home battery as a ranked limiting candidate
// (owner ruling, 2026-10-06): its charge is capped and then it discharges at
// its own place in the priority order, it is handed back by the restore lane
// in that order, and without a usable battery the shed is exactly what it is
// today. Drives the real `PlanBuilder` end to end; only its outward seams are
// fixtures.
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
  STORAGE_INPUT_MISSING_RELEASE_MS,
  STORAGE_SURPLUS_RELEASE_DWELL_MS,
} from '../../lib/plan/battery/storageRelief';
import { STORAGE_RELIEF_SETTLE_WINDOW_MS } from '../../lib/plan/battery/storageLadder';
import { DELIVERY_CEILING_TTL_MS } from '../../lib/battery/batteryVerification';
import { SURPLUS_ABSORB_SETTLE_MS } from '../../lib/plan/admission/surplusAbsorb';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { PriceLevel } from '../../lib/price/priceLevels';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { Logger } from '../../lib/logging/logger';
import type { StorageLeverState } from '../../lib/plan/planState';

const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 9, 5, 12, 10, 0);
const HOUR_KEY = new Date(Date.UTC(2026, 9, 5, 12, 0, 0)).toISOString();

const heater = (on = true, kw = 2, id = 'heater', priority = 1): PlanInputDevice => buildPlanInputDevice({
  id,
  name: id,
  controllable: true,
  binaryControl: { on },
  currentDrawKw: on ? kw : 0,
  expectedPowerKw: kw,
  priority,
});

/** Last in the priority order by default: it is limited first. */
const BATTERY_LAST = 10;

const battery = (
  overrides: Partial<ObservedStorageInput> = {},
  placement: { priority?: number; managed?: boolean } = {},
): PlanInputDevice & StoragePlanInputKind => ({
  ...buildPlanInputDevice({
    id: 'battery',
    name: 'Battery',
    isBatteryOrSolar: true,
    commandAuthority: false,
    managed: placement.managed ?? true,
    binaryControllable: false,
    currentDrawKw: 0,
    priority: placement.priority ?? BATTERY_LAST,
  }),
  storage: {
    reading: 'observed',
    range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false,
    signedPowerW: 0,
    claimHeld: false,
    admissible: true,
    verdict: 'unverified',
    deliveryCeilingW: 2500,
    chargeCeilingW: 2500,
    powerLimitControl: true,
    ...overrides,
  },
});

/** A Managed battery PELS can only watch (no setpoint surface): its signed power, nothing to drive. */
const watchedBattery = (signedPowerW: number): PlanInputDevice & StoragePlanInputKind => ({
  ...buildPlanInputDevice({
    id: 'battery',
    name: 'Battery',
    isBatteryOrSolar: true,
    commandAuthority: false,
    managed: true,
    binaryControllable: false,
    currentDrawKw: Math.max(0, signedPowerW) / 1000,
    priority: BATTERY_LAST,
  }),
  storage: { reading: 'watched', signedPowerW },
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

/** A water heater stepped Off / Low / Medium / Max, running at Max, ranked first. */
const tankAtMax = (): PlanInputDevice => buildPlanInputDevice({
  id: 'tank',
  name: 'tank',
  controllable: true,
  currentOn: true,
  commandableNow: true,
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'medium', planningPowerW: 1750 },
      { id: 'max', planningPowerW: 3000 },
    ],
  },
  selectedStepId: 'max',
  reportedStepId: 'max',
  currentDrawKw: 3,
  expectedPowerKw: 3,
  priority: 1,
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
  capacityEnabled?: boolean;
  gridImportLimitKw?: number | null;
  dailyBudget?: boolean;
  hourUsedKWh?: number;
};

const buildHarness = (scenario: Scenario) => {
  const state = createPlanEngineState();
  const info = vi.fn();
  /** The storage term shedding counted, kW, as the last build logged it (0 when it logged none). */
  const lastShedTermKw = (): number => {
    const calls = info.mock.calls.map(([event]) => event as { event?: string; netCreditKw?: number });
    const last = calls.filter((event) => event.event === 'storage_relief_shed_term').at(-1);
    return last?.netCreditKw ?? 0;
  };
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
    getCapacitySettings: () => ({
      capacityEnabled: scenario.capacityEnabled ?? true, gridImportLimitKw: scenario.gridImportLimitKw ?? null,
      limitKw: scenario.limitKw ?? 10, marginKw: 0, periodMinutes: 60,
    }),
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
    structuredLog: { info } as unknown as Logger,
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
    decorateDeferredObjectives: decorateWithoutDeferredObjectives,
  }, state);
  /** One build on a new whole-home reading, `afterMs` after the start. */
  const build = async (houseW: number, devices: PlanInputDevice[], afterMs = 0): Promise<DevicePlan> => {
    vi.setSystemTime(new Date(START_MS + afterMs));
    tracker.lastTimestamp = START_MS + afterMs;
    tracker.lastPowerW = houseW;
    info.mockClear();
    return builder.buildDevicePlanSnapshot(devices);
  };
  return { build, state, lastShedTermKw };
};

const plannedState = (plan: DevicePlan, id: string): string | undefined => (
  plan.devices.find((device) => device.id === id)?.plannedState
);

const storageDecision = (plan: DevicePlan): StorageDecision | undefined => {
  const device = plan.devices.find((entry) => entry.id === 'battery');
  return device !== undefined && hasStorageDecision(device) ? device.storageDecision : undefined;
};

describe('storage relief in the plan build', () => {
  it('caps battery charging on the first grid-only breach despite a recent restore', async () => {
    const { build, state } = buildHarness({ paceKw: null, capacityEnabled: false, gridImportLimitKw: 3.3 });
    state.actuation.markRestore('battery', START_MS - 1000);
    const plan = await build(3500, [heater(), battery({ signedPowerW: 1500 })]);
    expect(storageDecision(plan)).toMatchObject({ kind: 'setpoint' });
    const decision = storageDecision(plan);
    if (decision?.kind !== 'setpoint') throw new Error('expected a battery charge limit');
    expect(decision.setpointW).toBeLessThan(1500);
    expect(plannedState(plan, 'heater')).toBe('keep');
    expect(plan.meta.capacitySoftLimitKw).toBeNull();
  });

  it('withholds battery discharge from grid-only restoration and bounds hand-back charging', async () => {
    const { build } = buildHarness({ paceKw: null, capacityEnabled: false, gridImportLimitKw: 3.3 });
    await build(4300, [heater(false, 0.5, 'lamp'), battery()]);
    const delivered = [heater(false, 0.5, 'lamp'), battery({ signedPowerW: -1200, claimHeld: true })];
    await build(2500, delivered, 6 * 60_000);
    const waiting = await build(2500, delivered, 9 * 60_000);
    expect(plannedState(waiting, 'lamp')).not.toBe('keep');
    expect(storageDecision(waiting)?.kind).toBe('setpoint');
    const idle = battery({ signedPowerW: 0, claimHeld: true });
    const insufficient = await build(1000, [idle], 12 * 60_000);
    expect(storageDecision(insufficient)?.kind).toBe('setpoint');
    const released = await build(0, [idle], 15 * 60_000);
    expect(storageDecision(released)).toEqual({ kind: 'release', reason: 'restored' });
  });

  it('hands a limit-held battery back when both physical constraints are off', async () => {
    const { build, state } = buildHarness({ paceKw: null, capacityEnabled: false });
    state.storageLeverByDevice = { battery: {
      setpointW: -1500, purpose: 'limit', increaseDecidedAtMs: START_MS - 600_000,
      creditBaseW: 0, lastDecreaseAtMs: START_MS - 600_000, chargeRaisedAtMs: START_MS - 600_000,
      lastNeedAtMs: START_MS - 600_000, preClaimSignedW: 0, ownModeChargeW: 2500, stepW: 5,
      reading: { kind: 'read' },
    } };
    const plan = await build(5000, [battery({ signedPowerW: -1500, claimHeld: true })]);
    expect(storageDecision(plan)).toEqual({ kind: 'release', reason: 'restored' });
    expect(plan.meta.softLimitKw).toBeNull();
  });

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

  it('last in the order (the default), covers the deficit with the battery and sheds nothing', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const plan = await build(4200, [heater(), battery()]);

    // The 1.2 kW deficit, plus half the 200 W deadband as the increase's hysteresis.
    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -1300, stepW: 5 });
    expect(plannedState(plan, 'heater')).toBe('keep');
    // Never a shed: the executor sees only its storage decision.
    expect(plan.devices.find((device) => device.id === 'battery')?.plannedState).not.toBe('shed');
  });

  it('first in the order, limits the devices below it first and discharges only for what they leave', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    // A 3 kW deficit: the 2 kW heater ranked below it goes first, the battery covers the rest.
    const plan = await build(6000, [heater(true, 2, 'heater', 5), battery({}, { priority: 1 })]);

    expect(plannedState(plan, 'heater')).toBe('shed');
    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -1100, stepW: 5 });
  });

  it('first in the order, is not touched while the devices below it cover the deficit', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const plan = await build(4200, [heater(true, 2, 'heater', 5), battery({ signedPowerW: 1500 }, { priority: 1 })]);

    expect(plannedState(plan, 'heater')).toBe('shed');
    expect(storageDecision(plan)).toBeUndefined();
  });

  it('caps part of a charging battery\'s charge for a deficit its charge covers', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const plan = await build(3800, [heater(), battery({ signedPowerW: 2000 })]);

    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: 1100, stepW: 5 });
    expect(plannedState(plan, 'heater')).toBe('keep');
    const card = plan.devices.find((device) => device.id === 'battery');
    expect(card?.storageHold).toEqual({ kind: 'charge_limit', heldBackKw: 0.9 });
  });

  it('caps a charging battery\'s charge and discharges in one cycle for a deficit beyond it', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const plan = await build(5200, [heater(), battery({ signedPowerW: 1000 })]);

    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -1300, stepW: 5 });
    expect(plannedState(plan, 'heater')).toBe('keep');
  });

  it('sheds the heater once a battery that never moved stops being credited, and never credits it again', async () => {
    const { build, lastShedTermKw } = buildHarness({ paceKw: 3 });
    await build(4200, [heater(), battery()]);
    const lapsed = await build(4200, [heater(), battery()], STORAGE_RELIEF_SETTLE_WINDOW_MS);
    expect(plannedState(lapsed, 'heater')).toBe('shed');
    // Held where it was, not asked deeper: one write, not one per reading.
    expect(storageDecision(lapsed)).toEqual({ kind: 'setpoint', setpointW: -1300, stepW: 5 });

    // Asked again unbanked, it opens no new credit window.
    const after = await build(4200, [heater(), battery()], STORAGE_RELIEF_SETTLE_WINDOW_MS + 5_000);
    expect(plannedState(after, 'heater')).toBe('shed');
    expect(lastShedTermKw()).toBe(0);
    expect(storageDecision(after)).toEqual({ kind: 'setpoint', setpointW: -1300, stepW: 5 });
  });

  it('limits a battery ranked last during the shed grace, while the devices wait it out', async () => {
    const { build, state } = buildHarness({ paceKw: 3 });
    // A restore PELS made a moment ago may still be ramping: devices get the grace.
    state.activationAttemptByDevice.heater = {
      startedMs: START_MS - 10_000, source: 'pels_restore', cleanWholeHomeSampleSeen: false,
    };
    const plan = await build(4200, [heater(), battery()]);

    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -1300, stepW: 5 });
    expect(plannedState(plan, 'heater')).toBe('keep');
  });

  it.each([
    ['', false],
    [' during the shed grace', true],
  ])('limits a battery ranked last before stepping down a tank whose upper rung covers the deficit%s', async (_label, grace) => {
    const { build, state } = buildHarness({ paceKw: 3 });
    if (grace) {
      state.activationAttemptByDevice.tank = {
        startedMs: START_MS - 10_000, source: 'pels_restore', cleanWholeHomeSampleSeen: false,
      };
    }
    // Max to Medium (1.25 kW) would cover the 1.2 kW deficit, but the tank ranks above the battery.
    const plan = await build(4200, [tankAtMax(), battery()]);

    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -1300, stepW: 5 });
    expect(plannedState(plan, 'tank')).toBe('keep');
    expect(plan.devices.find((device) => device.id === 'tank')?.desiredStepId).not.toBe('medium');
  });

  it('decides a grace cycle with a battery that has nothing to give exactly as without one', async () => {
    const shed = async (withBattery: boolean) => {
      const harness = buildHarness({ paceKw: 3 });
      harness.state.activationAttemptByDevice.heater = {
        startedMs: START_MS - 10_000, source: 'pels_restore', cleanWholeHomeSampleSeen: false,
      };
      // Flat: drivable, but its ladder releases nothing.
      const plan = await harness.build(4200, [heater(), ...(withBattery ? [battery({ deliveryCeilingW: 0 })] : [])]);
      return {
        heater: plan.devices.find((device) => device.id === 'heater'),
        latch: harness.state.shedPlanLatch,
        sheddingActive: harness.state.sheddingActive,
        lastShedPlanMeasurementTs: harness.state.lastShedPlanMeasurementTs,
        restoreBackoff: JSON.stringify(harness.state.restoreBackoff),
        overshoot: JSON.stringify(harness.state.overshoot),
      };
    };
    expect(await shed(true)).toEqual(await shed(false));
  });

  it('hands back promptly a battery that was discharging in its own mode, so restores below it are not starved', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const devices = (lampOn: boolean, batteryW: number, claimHeld: boolean) => [
      battery({ signedPowerW: batteryW, claimHeld }, { priority: 1 }), heater(lampOn, 0.5, 'lamp', 5),
    ];
    // Its own mode discharges 2 kW; the house still goes over by 1 kW. The lamp
    // ranked below goes first, then the battery discharges beyond its own mode
    // (to its 2.5 kW range).
    const first = await build(4000, devices(true, -2000, false));
    expect(plannedState(first, 'lamp')).toBe('shed');
    expect(storageDecision(first)).toEqual({ kind: 'setpoint', setpointW: -2500, stepW: 5 });

    // The house falls under the pace: the discharge steps down, never below its
    // own mode's, and the battery goes back to its own mode at once.
    let plan = await build(2200, devices(false, -2500, true), 6 * 60_000);
    let atMs = 6 * 60_000;
    while (storageDecision(plan)?.kind === 'setpoint' && atMs < 12 * 60_000) {
      const decision = storageDecision(plan);
      const heldW = decision?.kind === 'setpoint' ? decision.setpointW : 0;
      expect(heldW).toBeLessThanOrEqual(-2000);
      atMs += 60_000;
      plan = await build(2200 - (heldW + 2500), devices(false, heldW, true), atMs);
    }
    expect(storageDecision(plan)).toEqual({ kind: 'release', reason: 'idle' });

    // In its own mode it covers the house again, and the lamp resumes.
    let lampPlan = plan;
    for (let step = 1; step <= 6 && plannedState(lampPlan, 'lamp') !== 'keep'; step += 1) {
      lampPlan = await build(1600, devices(false, -2000, false), atMs + step * 60_000);
    }
    expect(plannedState(lampPlan, 'lamp')).toBe('keep');
  });

  it('limits nothing during the shed grace when a device ranks below the battery', async () => {
    const { build, state } = buildHarness({ paceKw: 3 });
    state.activationAttemptByDevice.heater = {
      startedMs: START_MS - 10_000, source: 'pels_restore', cleanWholeHomeSampleSeen: false,
    };
    const plan = await build(4200, [heater(true, 2, 'heater', 5), battery({}, { priority: 1 })]);

    expect(storageDecision(plan)).toBeUndefined();
    expect(plannedState(plan, 'heater')).toBe('keep');
  });

  it('sizes the hand-back of a battery idle at the claim on its charge ceiling, and caps it first when its own mode charges', async () => {
    const { build } = buildHarness({ paceKw: 5 });
    await build(6000, [heater(), battery()]);
    // The discharge steps down; with the heater on there is no room for a
    // 2.5 kW charge yet.
    await build(3900, [heater(), battery({ signedPowerW: -1100, claimHeld: true })], 2 * 60_000);
    const waiting = await build(4000, [heater(), battery({ signedPowerW: 0, claimHeld: true })], 6 * 60_000);
    expect(storageDecision(waiting)).toMatchObject({ kind: 'setpoint', setpointW: 0 });

    const handedBack = await build(2000, [heater(), battery({ signedPowerW: 0, claimHeld: true })], 9 * 60_000);
    expect(storageDecision(handedBack)).toEqual({ kind: 'release', reason: 'restored' });

    // Its own mode charges 2.5 kW and the house goes over: the battery's charge
    // is capped before the heater ranked above it is touched.
    const charging = await build(5600, [heater(), battery({ signedPowerW: 2500 })], 9 * 60_000 + 10_000);
    const decision = storageDecision(charging);
    expect(decision?.kind === 'setpoint' && decision.setpointW > 0 && decision.setpointW < 2500).toBe(true);
    expect(plannedState(charging, 'heater')).toBe('keep');
  });

  it('answers an exhausted hour in priority order when the battery covers only part of it', async () => {
    const { build } = buildHarness({ paceKw: null, limitKw: 5, hourUsedKWh: 6 });
    const plan = await build(1800, [
      heater(true, 1.9), heater(true, 0.5, 'pump', 2), heater(true, 0.3, 'lamp', 3), battery({ deliveryCeilingW: 1000 }),
    ]);

    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -1000, stepW: 5 });
    expect(plannedState(plan, 'lamp')).toBe('shed');
    expect(plannedState(plan, 'pump')).toBe('shed');
    expect(plannedState(plan, 'heater')).toBe('keep');
  });

  it('answers an exhausted hour in priority order with the battery already at its ceiling', async () => {
    const { build, state } = buildHarness({ paceKw: null, limitKw: 5, hourUsedKWh: 6 });
    const atCeiling: StorageLeverState = {
      setpointW: -1000, purpose: 'limit', increaseDecidedAtMs: START_MS - 60_000, creditBaseW: 0,
      lastDecreaseAtMs: START_MS - 60_000, chargeRaisedAtMs: START_MS - 60_000, lastNeedAtMs: START_MS - 60_000,
      preClaimSignedW: 0, ownModeChargeW: 2500, stepW: 5, reading: { kind: 'read' },
    };
    state.storageLeverByDevice = { battery: atCeiling };
    const plan = await build(600, [
      heater(true, 1.9), heater(true, 0.5, 'pump', 2), heater(true, 0.3, 'lamp', 3),
      battery({ signedPowerW: -1000, claimHeld: true, deliveryCeilingW: 1000 }),
    ]);

    // It offers nothing more, and that is no reason to shed everything.
    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -1000, stepW: 5 });
    expect(plannedState(plan, 'lamp')).toBe('shed');
    expect(plannedState(plan, 'pump')).toBe('shed');
    expect(plannedState(plan, 'heater')).toBe('keep');
  });

  it('holds back restores ranked below a battery hand-back that waits for room', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const devices = (lampOn: boolean, batteryW: number) => [
      heater(true, 2, 'heater', 1), battery({ signedPowerW: batteryW, claimHeld: batteryW !== 0 }, { priority: 2 }),
      heater(lampOn, 0.5, 'lamp', 3),
    ];
    // The lamp ranked below the battery goes first; the battery covers the rest.
    const first = await build(6000, devices(true, 0));
    expect(plannedState(first, 'lamp')).toBe('shed');
    expect(storageDecision(first)).toMatchObject({ kind: 'setpoint' });

    // Two kilowatts of room: the lamp would fit, the battery's own-mode charge
    // (its ceiling, 2.5 kW) would not. The lamp waits behind the battery.
    await build(1000, devices(false, 0), 6 * 60_000);
    const waiting = await build(1000, devices(false, 0), 9 * 60_000);
    expect(storageDecision(waiting)).toMatchObject({ kind: 'setpoint' });
    expect(plannedState(waiting, 'lamp')).toBe('shed');
    expect(waiting.devices.find((device) => device.id === 'lamp')?.reason)
      .toEqual({ code: PLAN_REASON_CODES.waitingForOtherDevices });
  });

  it.each([
    ['without a battery', [] as PlanInputDevice[]],
    ['with a flat battery', [battery({ deliveryCeilingW: 0 })]],
    ['with a battery that is not responding', [battery({ verdict: 'not_responding' })]],
    ['with a battery the owner opted out', [battery({ admissible: false })]],
    ['with an inverted-sign battery', [battery({ verdict: 'sign_inverted' })]],
    ['with a battery whose Power-limit control is off', [battery({ powerLimitControl: false })]],
    ['with a battery whose Managed is off', [battery({ admissible: false }, { managed: false })]],
    ['with a battery whose hand-back is deferred', [battery({ handBackDeferred: true })]],
  ])('sheds exactly as today %s', async (_label, batteries) => {
    const { build } = buildHarness({ paceKw: 3 });
    const plan = await build(4200, [heater(), ...batteries]);

    expect(plannedState(plan, 'heater')).toBe('shed');
    const decision = storageDecision(plan);
    expect(decision === undefined || decision.kind === 'release').toBe(true);
  });

  it('builds a byte-identical shed without a battery and beside one PELS may not limit', async () => {
    const shedOnly = (plan: DevicePlan): string => JSON.stringify({
      meta: plan.meta,
      devices: plan.devices.filter((device) => device.id !== 'battery'),
      storageReleases: plan.storageReleases,
    });
    const without = buildHarness({ paceKw: 3 });
    const beside = buildHarness({ paceKw: 3 });
    const plain = await without.build(4200, [heater(), heater(true, 0.5, 'lamp', 2)]);
    const withBattery = await beside.build(
      4200, [heater(), heater(true, 0.5, 'lamp', 2), battery({ powerLimitControl: false })],
    );

    expect(shedOnly(withBattery)).toBe(shedOnly(plain));
    expect(without.state.storageLeverByDevice).toEqual({});
    expect(beside.state.storageLeverByDevice).toEqual({});
    expect(without.state.shedPlanLatch).toEqual(beside.state.shedPlanLatch);
  });

  it('asks a re-probing battery but sheds the next device as without it', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const plan = await build(4200, [heater(), battery({ verdict: 'reprobing' })]);

    expect(storageDecision(plan)).toMatchObject({ kind: 'setpoint' });
    expect(plannedState(plan, 'heater')).toBe('shed');
  });

  it('limits the battery for the daily-budget pace when it binds: its grid charge counts like any load', async () => {
    const { build } = buildHarness({ paceKw: null, limitKw: 100, dailyBudget: true });
    const plan = await build(2500, [heater(), battery({ signedPowerW: 1000 })]);

    expect(plan.meta.softLimitSource).toBe('daily');
    expect(storageDecision(plan)).toMatchObject({ kind: 'setpoint' });
    expect(plannedState(plan, 'heater')).toBe('keep');
  });

  it('answers an exhausted hour in priority order: the battery covers it and nothing is shed', async () => {
    const { build, state } = buildHarness({ paceKw: null, limitKw: 5, hourUsedKWh: 6 });
    const devices = [heater(true, 1.9), heater(true, 0.3, 'lamp', 2), battery()];
    const plan = await build(2200, devices);

    expect(state.hourlyBudgetExhausted).toBe(true);
    // The whole draw but half the deadband, so the limit never tips into export.
    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: -2100, stepW: 5 });
    expect(plannedState(plan, 'heater')).toBe('keep');
    expect(plannedState(plan, 'lamp')).toBe('keep');
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

  it('hands a limited battery back at once, and sheds, when the owner turns Power-limit control off', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    await build(4200, [heater(), battery()]);
    const limitOff = battery({ signedPowerW: -1300, claimHeld: true, powerLimitControl: false });
    const plan = await build(2900, [heater(), limitOff], 2 * 60_000);

    expect(storageDecision(plan)).toEqual({ kind: 'release', reason: 'limit_off' });
    expect(plannedState(plan, 'heater')).toBe('shed');
  });

  it('keeps an unread hold uncredited, then hands it back and sheds in that cycle', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    await build(4200, [heater(), battery()]);
    // The battery delivered, then stopped reporting: no power reading, still held.
    const unread: PlanInputDevice & StoragePlanInputKind = {
      ...buildPlanInputDevice({
        id: 'battery', name: 'Battery', isBatteryOrSolar: true, commandAuthority: false, binaryControllable: false,
        unmetered: true, priority: BATTERY_LAST,
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

  it('steps a held discharge down on headroom, then hands the battery back through restore', async () => {
    const { build, state } = buildHarness({ paceKw: 3 });
    await build(4200, [heater(), battery()]);
    // The battery delivered; the heater then stops on its own and the house
    // drops a kilowatt under the pace: the discharge steps down past the
    // deadband, and the hold stays (restore may not spend its discharge).
    const delivered = battery({ signedPowerW: -1200, claimHeld: true });
    const stepped = await build(2000, [heater(false), delivered], 2 * 60_000);
    expect(storageDecision(stepped)).toEqual({ kind: 'setpoint', setpointW: -400, stepW: 5 });

    // It was idle when PELS claimed it, so its own mode may charge at its full
    // 2.5 kW once handed back: a kilowatt of room is not enough.
    const idle = battery({ signedPowerW: 0, claimHeld: true });
    const waiting = await build(1000, [heater(false), idle], 6 * 60_000);
    expect(storageDecision(waiting)).toMatchObject({ kind: 'setpoint', setpointW: 0 });

    // Room for its own mode again (the heater is gone): restore hands it back.
    // The restore clocks wait for the executor to report the hand-back made.
    const released = await build(0, [idle], 9 * 60_000);
    expect(storageDecision(released)).toEqual({ kind: 'release', reason: 'restored' });
    expect(state.storageLeverByDevice).toEqual({});
    expect(state.actuation.lastDeviceRestoreMs.battery).toBeUndefined();
  });

  it('sizes a capped charge\'s hand-back on the charge above the cap, and holds back nothing below it', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    const devices = (lampOn: boolean, batteryW: number, claimHeld: boolean) => [
      battery({ signedPowerW: batteryW, claimHeld }, { priority: 2 }), heater(lampOn, 0.5, 'lamp', 3),
    ];
    // Its own mode charges 2.5 kW and the house is 1.4 kW over: the lamp ranked
    // below it goes first, then the battery's charge is capped for the rest.
    const first = await build(4400, devices(true, 2500, false));
    expect(plannedState(first, 'lamp')).toBe('shed');
    expect(storageDecision(first)).toEqual({ kind: 'setpoint', setpointW: 1500, stepW: 5 });

    // Capped at 1.5 kW, which the meter already shows, with 1.5 kW of room:
    // handing it back adds only the 1 kW its own mode takes above the cap.
    await build(1500, devices(false, 1500, true), 6 * 60_000);
    const handedBack = await build(1500, devices(false, 1500, true), 9 * 60_000);
    expect(storageDecision(handedBack)).toEqual({ kind: 'release', reason: 'restored' });
    // It did not wait for room, so the lamp ranked below waits behind nothing.
    expect(handedBack.devices.find((device) => device.id === 'lamp')?.reason)
      .not.toEqual({ code: PLAN_REASON_CODES.waitingForOtherDevices });
  });

  it('hands back in priority order: a device ranked above the battery resumes first', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    // 4 kW of background and the 2 kW heater: the battery (last) discharges
    // its 2.5 kW, and the heater ranked above it is shed for the rest.
    const first = await build(6000, [heater(true, 2), battery()]);
    expect(storageDecision(first)).toEqual({ kind: 'setpoint', setpointW: -2500, stepW: 5 });
    expect(plannedState(first, 'heater')).toBe('shed');

    // The background drops: the battery steps down, and the heater resumes
    // first. (The first cycle after the episode sits in the shed cooldown.)
    const later = [heater(false, 2), battery({ signedPowerW: 0, claimHeld: true })];
    await build(500, later, 6 * 60_000);
    const resumed = await build(500, later, 9 * 60_000);
    expect(plannedState(resumed, 'heater')).toBe('keep');
    expect(storageDecision(resumed)).toMatchObject({ kind: 'setpoint' });

    // Nearly full, its own mode takes 0.5 kW back: room for that hands it back.
    const nearlyFull = battery({ signedPowerW: 0, claimHeld: true, chargeCeilingW: 500 });
    const handedBack = await build(2200, [heater(true, 2), nearlyFull], 15 * 60_000);
    expect(storageDecision(handedBack)).toEqual({ kind: 'release', reason: 'restored' });
  });

  it('hands back in priority order: the battery ranked above a device is handed back first', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    // The heater ranked below the battery goes first; the battery covers the 1 kW left.
    const first = await build(6000, [heater(true, 2, 'heater', 5), battery({}, { priority: 1 })]);
    expect(plannedState(first, 'heater')).toBe('shed');
    expect(storageDecision(first)).toEqual({ kind: 'setpoint', setpointW: -1100, stepW: 5 });

    const later = [heater(false, 2, 'heater', 5), battery({ signedPowerW: 0, claimHeld: true }, { priority: 1 })];
    await build(0, later, 6 * 60_000);
    const handedBack = await build(0, later, 9 * 60_000);
    expect(storageDecision(handedBack)).toEqual({ kind: 'release', reason: 'restored' });
    expect(plannedState(handedBack, 'heater')).not.toBe('keep');
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

  it('offers the devices nothing of a battery PELS can only watch, discharging 2 kW into the export', async () => {
    const watched = buildHarness({ paceKw: 10 });
    const solar = buildHarness({ paceKw: 10 });
    let watchedPlan: DevicePlan | undefined;
    let solarPlan: DevicePlan | undefined;
    for (let reading = 0; reading <= 30; reading += 1) {
      watchedPlan = await watched.build(-2000, [pump(false), watchedBattery(-2000)], reading * 10_000);
      // Nothing to decide for it: no hold, no claim, no summary.
      expect(storageDecision(watchedPlan)).toBeUndefined();
      expect(watchedPlan.devices.find((device) => device.id === 'battery')?.storageHold).toEqual({ kind: 'none' });
      solarPlan = await solar.build(-2000, [pump(false)], reading * 10_000);
    }
    // The meter reads the same 2 kW export: solar starts the pump, the battery's stored energy does not.
    expect(plannedState(watchedPlan!, 'pump')).toBe('shed');
    expect(watched.state.surplusEligibilityByDevice.pump).toBeUndefined();
    expect(watched.state.storageLeverByDevice).toEqual({});
    expect(plannedState(solarPlan!, 'pump')).toBe('keep');
  });

  it('turns a surplus device off when a battery PELS can only watch discharges to keep it running', async () => {
    const { build, state } = buildHarness({ paceKw: 10 });
    state.surplusEligibilityByDevice.pump = { eligible: true, sinceMs: START_MS };
    let shedAtMs = Number.POSITIVE_INFINITY;
    for (let atMs = 0; atMs <= 4 * 60_000 && shedAtMs === Number.POSITIVE_INFINITY; atMs += 10_000) {
      const plan = await build(0, [pump(true, 3), watchedBattery(-500)], atMs);
      if (plannedState(plan, 'pump') === 'shed') shedAtMs = atMs;
    }
    expect(shedAtMs).toBeLessThanOrEqual(SURPLUS_ABSORB_SETTLE_MS + 10_000);
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

  it('limits a charging battery for a deficit at its place in the order, the charge before any device', async () => {
    const { build } = buildHarness({ paceKw: 3 });
    await build(0, [pump(false), heater(), battery()]);
    // The house jumps to 4.2 kW while the battery still charges 1.9 kW of it:
    // its charge is capped by the 1.2 kW deficit and half its deadband.
    const plan = await build(4200, [pump(false), heater(), battery({ signedPowerW: 1900, claimHeld: true })], 10_000);
    expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: 600, stepW: 5 });
    expect(plannedState(plan, 'heater')).toBe('keep');
  });

  describe('by priority', () => {
    /** A second "Run on solar surplus" load, 1 kW, at this priority. */
    const dumpTank = (priority: number, on = false): PlanInputDevice => buildPlanInputDevice({
      id: 'tank',
      name: 'tank',
      controllable: true,
      binaryControl: { on },
      currentDrawKw: on ? 1 : 0,
      expectedPowerKw: 1,
      surplusOnly: true,
      priority,
    });
    const ranked = (device: PlanInputDevice, priority: number): PlanInputDevice => ({ ...device, priority });

    it('ranked above a waiting device, keeps its own mode\'s charge: no cap, and the device waits', async () => {
      const { build, state } = buildHarness({ paceKw: 10 });
      // 2 kW of solar, all of it stored by the battery's own mode: the meter reads 0.
      for (let reading = 0; reading < 30; reading += 1) {
        const plan = await build(0, [
          ranked(pump(false, 1.5), 5), battery({ signedPowerW: 2000 }, { priority: 1 }),
        ], reading * 10_000);
        expect(storageDecision(plan)).toBeUndefined();
        expect(plannedState(plan, 'pump')).toBe('shed');
      }
      expect(state.storageLeverByDevice).toEqual({});
      expect(state.surplusEligibilityByDevice.pump).toBeUndefined();
    });

    it.each([3, BATTERY_LAST])('ranked %s, below a waiting device, caps its charge so the device starts', async (priority) => {
      const { build } = buildHarness({ paceKw: 10 });
      const plan = await build(0, [ranked(pump(false, 1.5), 1), battery({ signedPowerW: 2000 }, { priority })]);
      expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: 400, stepW: 5 });

      const after = await run(build, { solarW: -2000, pumpKw: 1.5, fromMs: 0, readings: 30, batteryW: 400, pumpOn: false });
      expect(after.pumpOn).toBe(true);
      expect(after.batteryW).toBe(400);
    });

    it('between two devices, caps its charge for the one above it, never for the one below', async () => {
      // 1 kW exported past the 2 kW its own mode stores; a 1.5 kW pump ranks first and a 1 kW tank last.
      const between = buildHarness({ paceKw: 10 });
      const plan = await between.build(-1000, [
        pump(false, 1.5), battery({ signedPowerW: 2000 }, { priority: 5 }), dumpTank(9),
      ]);
      // The pump's 1.5 kW comes out of the battery's charge, less half its deadband; the tank gets nothing.
      expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: 1400, stepW: 5 });
      expect(between.state.surplusEligibilityByDevice.pump).toBeDefined();
      expect(between.state.surplusEligibilityByDevice.tank).toBeUndefined();

      // Last in the order, it is capped for both.
      const last = buildHarness({ paceKw: 10 });
      const lastPlan = await last.build(-1000, [
        pump(false, 1.5), battery({ signedPowerW: 2000 }, { priority: BATTERY_LAST }), dumpTank(9),
      ]);
      expect(storageDecision(lastPlan)).toEqual({ kind: 'setpoint', setpointW: 400, stepW: 5 });
      expect(last.state.surplusEligibilityByDevice.tank).toBeDefined();
    });

    it('with Power-limit control off, makes no claim: the devices are planned byte-identically to a home without it', async () => {
      // Owner ruling, 2026-10-06: PELS never takes it over, so its 2 kW of charge is household load.
      const shedOnly = (plan: DevicePlan): string => JSON.stringify({
        meta: plan.meta,
        devices: plan.devices.filter((device) => device.id !== 'battery'),
        storageReleases: plan.storageReleases,
      });
      const without = buildHarness({ paceKw: 10 });
      const beside = buildHarness({ paceKw: 10 });
      for (let reading = 0; reading < 12; reading += 1) {
        const plain = await without.build(0, [pump(false, 1.5)], reading * 10_000);
        const plan = await beside.build(0, [
          pump(false, 1.5), battery({ signedPowerW: 2000, powerLimitControl: false }),
        ], reading * 10_000);
        expect(storageDecision(plan)).toBeUndefined();
        expect(plan.devices.find((device) => device.id === 'battery')?.storageHold).toEqual({ kind: 'power_limit_off' });
        expect(shedOnly(plan)).toBe(shedOnly(plain));
      }
      expect(beside.state.storageLeverByDevice).toEqual({});
      expect(beside.state.surplusEligibilityByDevice).toEqual(without.state.surplusEligibilityByDevice);
    });

    it('hands a surplus hold back when the owner turns Power-limit control off', async () => {
      const { build, state } = buildHarness({ paceKw: 10 });
      const capped = await build(0, [pump(false, 1.5), battery({ signedPowerW: 2000 })]);
      expect(storageDecision(capped)).toEqual({ kind: 'setpoint', setpointW: 400, stepW: 5 });

      const off = await build(0, [
        pump(false, 1.5), battery({ signedPowerW: 400, claimHeld: true, powerLimitControl: false }),
      ], 10_000);
      expect(storageDecision(off)).toEqual({ kind: 'release', reason: 'limit_off' });
      expect(state.storageLeverByDevice).toEqual({});
    });

    it('with Managed off, makes no claim: its charge is household load', async () => {
      const { build, state } = buildHarness({ paceKw: 10 });
      for (let reading = 0; reading < 12; reading += 1) {
        const plan = await build(0, [
          pump(false, 1.5), battery({ signedPowerW: 2000, admissible: false }, { managed: false }),
        ], reading * 10_000);
        expect(storageDecision(plan)).toBeUndefined();
        expect(plannedState(plan, 'pump')).toBe('shed');
      }
      expect(state.surplusEligibilityByDevice.pump).toBeUndefined();
    });

    it('never offers its discharge to a device ranked below it either', async () => {
      const { build, state } = buildHarness({ paceKw: 10 });
      // Its own mode trades: it discharges 5 kW and the house exports all of it.
      for (let reading = 0; reading < 12; reading += 1) {
        const plan = await build(-5000, [
          ranked(pump(false), 5), battery({ signedPowerW: -5000 }, { priority: 1 }),
        ], reading * 10_000);
        expect(storageDecision(plan)).toBeUndefined();
        expect(plannedState(plan, 'pump')).toBe('shed');
      }
      expect(state.surplusEligibilityByDevice.pump).toBeUndefined();
    });


    /** A battery's hold, as the state carries it. */
    const hold = (overrides: Partial<StorageLeverState>): StorageLeverState => ({
      setpointW: 0, purpose: 'limit', increaseDecidedAtMs: START_MS - 10 * 60_000, creditBaseW: 0,
      lastDecreaseAtMs: START_MS - 10 * 60_000, chargeRaisedAtMs: START_MS - 10 * 60_000,
      lastNeedAtMs: START_MS, preClaimSignedW: 0, ownModeChargeW: 2500, stepW: 5, reading: { kind: 'read' },
      ...overrides,
    });
    /** Whether the allocator has a device settling toward, or engaged on, the surplus. */
    const claims = (state: ReturnType<typeof buildHarness>['state'], id: string): boolean => {
      const entry = state.surplusEligibilityByDevice[id];
      return entry?.eligible === true || entry?.pendingSinceMs !== undefined;
    };

    it('ranked above a dump load, keeps the export its own mode takes back while a limit hold waits for room', async () => {
      // A limit hold at 0 W the restore lane cannot hand back yet: its own mode
      // would charge 2.5 kW, and the pace leaves only 2.3 kW of room. 2 kW of solar returns.
      const { build, state } = buildHarness({ paceKw: 0.3 });
      state.storageLeverByDevice = { battery: hold({}) };
      for (let atMs = 0; atMs <= 4 * 60_000; atMs += 10_000) {
        const plan = await build(-2000, [
          ranked(pump(false), 5), battery({ signedPowerW: 0, claimHeld: true }, { priority: 1 }),
        ], atMs);
        expect(storageDecision(plan)).toEqual({ kind: 'setpoint', setpointW: 0, stepW: 5 });
        expect(plannedState(plan, 'pump')).toBe('shed');
        // The pump ranked below is offered none of it: the order agrees with the hand-back's.
        expect(claims(state, 'pump')).toBe(false);
      }
    });

    describe('between two devices, a raise funds no watt twice', () => {
      const SOLAR_W = 5200;
      const PUMP_W = 1500;
      /** The pump above runs on surplus; the battery was raised to 2.4 kW past its own mode's 2 kW. */
      const start = () => {
        const harness = buildHarness({ paceKw: 10 });
        harness.state.surplusEligibilityByDevice.pump = { eligible: true, sinceMs: START_MS - 10 * 60_000 };
        harness.state.storageLeverByDevice = {
          battery: hold({ setpointW: 2400, purpose: 'surplus', preClaimSignedW: 2000, ownModeChargeW: 2000 }),
        };
        return harness;
      };
      const roomy = { range: { minW: -5000, maxW: 5000, stepW: 5, excludeMinW: 0, excludeMaxW: 0 }, chargeCeilingW: 5000 };

      /**
       * Readings every 10 s for 100 s (inside the dwell). The battery reads
       * the setpoint it was asked for one reading late when `lagging`, as a
       * battery whose answer to a write has not arrived yet does.
       */
      const run = async (lagging: boolean) => {
        const { build, state } = start();
        let tankOn = false;
        let askedW = 2400;
        let observedW = 2400;
        const funded: number[] = [];
        for (let atMs = 0; atMs <= 100_000; atMs += 10_000) {
          const houseW = -SOLAR_W + observedW + PUMP_W + (tankOn ? 1000 : 0);
          const plan = await build(houseW, [
            pump(true, PUMP_W / 1000), battery({ ...roomy, signedPowerW: observedW, claimHeld: true }, { priority: 5 }),
            dumpTank(9, tankOn),
          ], atMs);
          const decision = storageDecision(plan);
          const nextW = decision?.kind === 'setpoint' ? decision.setpointW : askedW;
          // What this build funded: the battery's charge, the pump's draw, and the tank once it claims.
          funded.push(nextW + PUMP_W + (claims(state, 'tank') ? 1000 : 0));
          observedW = lagging ? askedW : nextW;
          askedW = nextW;
          tankOn = plannedState(plan, 'tank') === 'keep';
        }
        return { funded, askedW, tankOn };
      };

      it('holds the raise while the device below waits, within the solar', async () => {
        // 1.3 kW exported past the raise: the tank below claims 1 kW of it, so
        // the battery may raise only into the 0.3 kW left, too little to be a step.
        const { funded, askedW, tankOn } = await run(false);
        expect(Math.max(...funded)).toBeLessThanOrEqual(SOLAR_W);
        expect(askedW).toBe(2400);
        expect(tankOn).toBe(true);
      });

      it('stays within the solar while the battery\'s reading lags its last write', async () => {
        const { funded } = await run(true);
        expect(Math.max(...funded)).toBeLessThanOrEqual(SOLAR_W);
      });
    });

    it('hands a cap back after the dwell once the owner ranks the battery above the device it was for', async () => {
      const { build } = buildHarness({ paceKw: 10 });
      const first = await build(0, [pump(false, 1.5), battery({ signedPowerW: 2000 })]);
      expect(storageDecision(first)).toEqual({ kind: 'setpoint', setpointW: 400, stepW: 5 });

      // Ranked first now: it takes the solar first, and the pump below it waits.
      const decisions: Array<StorageDecision | undefined> = [];
      for (let atMs = 10_000; atMs <= STORAGE_SURPLUS_RELEASE_DWELL_MS + 10_000; atMs += 10_000) {
        const plan = await build(-1600, [
          ranked(pump(false, 1.5), 5), battery({ signedPowerW: 400, claimHeld: true }, { priority: 1 }),
        ], atMs);
        decisions.push(storageDecision(plan));
        expect(plannedState(plan, 'pump')).toBe('shed');
      }
      expect(decisions.slice(0, -2).every((decision) => decision?.kind === 'setpoint')).toBe(true);
      expect(decisions).toContainEqual({ kind: 'release', reason: 'surplus_dwell' });
    });
  });
});
