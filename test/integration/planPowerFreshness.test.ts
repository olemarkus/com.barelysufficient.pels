import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { resolvePowerCycleReading } from '../../lib/power/powerCycleReading';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { resolveMeasuredPower, type MeasuredPower, type PlanLimits } from '../../lib/plan/planContext';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../lib/power/sampleFreshness';
import { createPlanEngineState } from '../../lib/plan/planState';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import { recordActivationAttemptStart } from '../../lib/plan/admission';
import type { PlanInputDevice, BinaryControlDiscriminantProbe } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { withFixtureResidualKw, expectMeasuredMeta } from '../utils/planTestUtils';
import { PriceLevel } from '../../lib/price/priceLevels';

const emptyPendingStore = createPendingBinaryCommandStore({});

// The producer resolves the reading. Tests state the two real inputs — what
// the meter read and when it last sampled — and receive either a measured
// reading (from which `resolveMeasuredPower` derives every axis) or the
// silent-meter variant, which carries no headroom at all. (In production a
// silent-past-timeout build only happens as the escalation's one fail-closed
// pass — every other silent rebuild is blocked by the composed gate; driving
// the builder directly below exercises exactly that pass.)
const readingFor = (
  powerTracker: { lastTimestamp?: number; lastPowerW?: number },
) => resolvePowerCycleReading({
  powerTracker,
  nowMs: Date.now(),
});

const buildDevice = (
  overrides: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe = {},
): PlanInputDevice => withBinaryDiscriminant(withFixtureResidualKw({
  id: 'dev',
  name: 'Device',
  targets: [],
  // Shed candidacy gates on writability (`isCanSetControl`); a real binary
  // device resolves a control capability, so model that here.
  binaryCapabilityId: 'onoff',
  binaryControl: { on: true },
  currentOn: true,
  controllable: true,
  expectedPowerKw: 1.2,
  ...overrides,
})) as PlanInputDevice;

describe('power sample freshness policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const limitsFor = (params: {
    softLimit?: number;
    capacitySoftLimit?: number;
    dailySoftLimit?: number | null;
    budgetPaceKw?: number | null;
    projectedExemptKw?: number | null;
    softLimitSource?: 'capacity' | 'daily';
  }): PlanLimits => ({
    softLimit: params.softLimit ?? 5,
    capacitySoftLimit: params.capacitySoftLimit ?? 5,
    dailySoftLimit: params.dailySoftLimit ?? null,
    budgetPaceKw: params.budgetPaceKw ?? null,
    projectedExemptKw: params.projectedExemptKw ?? null,
    softLimitSource: params.softLimitSource ?? 'capacity',
  });

  /** The measured cycle's numbers, or `null` when the reading is the silent variant. */
  const powerFor = (params: {
    powerTracker: { lastTimestamp?: number; lastPowerW?: number };
    devices?: PlanInputDevice[];
  } & Parameters<typeof limitsFor>[0]): MeasuredPower | null => {
    const reading = readingFor(params.powerTracker);
    if (!reading.isMeasured) return null;
    return resolveMeasuredPower(reading, limitsFor(params), params.devices ?? []);
  };

  it('uses real computed headroom for fresh samples', () => {
    const power = powerFor({
      powerTracker: { lastTimestamp: Date.now() - (POWER_SAMPLE_STALE_THRESHOLD_MS - 1), lastPowerW: 3.2 * 1000 },
    });

    expect(power?.headroomKw).toBeCloseTo(1.8, 6);
    expect(power?.drawKw).toBeCloseTo(3.2, 6);
  });

  // Owner ruling 2026-08-31: a short gap is a no-op, not a hold — the last
  // good value carries forward AS MEASURED until the 10-minute silence mark.
  it('carries a minutes-old reading forward as measured; a build with no sample at all fails loud', () => {
    const carried = powerFor({
      powerTracker: { lastTimestamp: Date.now() - (2 * 60 * 1000), lastPowerW: 4.4 * 1000 },
    });

    expect(carried?.headroomKw).toBeCloseTo(0.6, 6);

    // Startup with NO sample is the measurement gate's case, not a reading
    // state: a build with an unsampled tracker is a gate violation and fails
    // loud instead of synthesizing a held headroom.
    expect(() => readingFor({})).toThrow(/measurement gate/);
  });

  it('answers the silent-meter variant once the stale timeout is reached — no headroom exists to read', () => {
    // This used to force a sentinel -1 headroom that every consumer then did
    // arithmetic on (owner ruling 2026-09-02). The silent variant carries no
    // headroom; the planner takes an explicit directive instead.
    const reading = readingFor({
      lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 4_400,
    });

    expect(reading.isMeasured).toBe(false);
    expect(reading).not.toHaveProperty('headroomKw');
    expect(powerFor({ powerTracker: { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 4_400 } })).toBeNull();
  });

  // Per-axis restore-admission inputs are resolved from the same measured
  // reading as the binding axis. The exhausted hour is no longer a force on
  // these numbers: it is a flag the restore gates read
  // (`shouldPlanRestores`, `shouldPlanBudgetExemptRestores`).
  describe('per-axis admission headroom resolution', () => {
    const exemptRunningDevice = buildDevice({
      id: 'exempt-heater',
      budgetExempt: true,
      currentDrawKw: 1.25,
    });
    const perAxis = {
      softLimit: 2.2,
      capacitySoftLimit: 10,
      dailySoftLimit: 2.2,
      budgetPaceKw: 0.9,
      softLimitSource: 'daily' as const,
    };

    it('resolves both axes from fresh power, with the MEASURED exempt sum on the budget axis', () => {
      const power = powerFor({
        ...perAxis,
        devices: [exemptRunningDevice],
        powerTracker: { lastTimestamp: Date.now() - 1000, lastPowerW: 1.85 * 1000 },
      });

      expect(power?.capacityHeadroomKw).toBeCloseTo(10 - 1.85, 6);
      // budget pace (0.9) + measured exempt (1.25) - total (1.85)
      expect(power?.budgetHeadroomKw).toBeCloseTo(0.3, 6);
      expect(power?.capacityBreached).toBe(false);
      // Daily binding + capacity not breached: a headroom hold is budget-releasable.
      expect(power?.budgetReleasableHeadroomHold).toBe(true);
    });

    it('has no budget axis without a resolved daily pace', () => {
      const power = powerFor({
        ...perAxis,
        dailySoftLimit: null,
        budgetPaceKw: null,
        softLimitSource: 'capacity',
        powerTracker: { lastTimestamp: Date.now() - 1000, lastPowerW: 1.85 * 1000 },
      });

      expect(power?.budgetHeadroomKw).toBeNull();
      expect(power?.budgetReleasableHeadroomHold).toBe(false);
    });

    it('reports a capacity breach from the measured draw, which closes the budget release', () => {
      const power = powerFor({
        ...perAxis,
        powerTracker: { lastTimestamp: Date.now() - 1000, lastPowerW: 10.5 * 1000 },
      });

      expect(power?.capacityBreached).toBe(true);
      expect(power?.budgetReleasableHeadroomHold).toBe(false);
    });
  });
});

describe('planner behavior under stale power freshness states', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildBuilder(params: {
    tracker: { lastTimestamp?: number; lastPowerW?: number };
    structuredLog?: { info?: ReturnType<typeof vi.fn>; warn?: ReturnType<typeof vi.fn> };
    state?: ReturnType<typeof createPlanEngineState>;
  }): PlanBuilder {
    return new PlanBuilder({
      getInferredSurplusKw: () => 0,
      getCapacityDryRun: () => false,
      setCapacityInShortfall: vi.fn(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => ({ limitKw: 6, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getPowerTracker: () => params.tracker,
      getDailyBudgetSnapshot: () => null,
      getShedBehavior: () => ({ action: 'turn_off' }),
      structuredLog: params.structuredLog as never,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, params.state ?? createPlanEngineState());
  }

  it('fails loud when a build runs with no total at all — a gate violation, never a fabricated plan', async () => {
    // A timestamp with no latched watts is a state production ingest cannot
    // write (both land on the same sample); reaching a build with it means the
    // measurement gate was bypassed. The resolver throws rather than planning
    // on a number nobody measured, and the rebuild path reports it as a
    // failed build (`rebuildPlanFromCache` resolves `{ failed: true }`).
    const builder = buildBuilder({
      tracker: { lastTimestamp: Date.now() - (2 * 60 * 1000) },
    });

    await expect(builder.buildDevicePlanSnapshot([buildDevice()]))
      .rejects.toThrow(/measurement gate/);
  });

  // The shed grace buys time only when a deficit might be a restore PELS itself
  // is driving AND power is observable. Blind mode is the one place waiting is
  // never right, so an open activation attempt must not soften the escalation's
  // fail-closed pass. A first cut of the grace gated every deficit and delayed
  // exactly this.
  it('grants no shed grace on the fail-closed pass, even with a restore in flight', async () => {
    const tracker = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 2_000 };
    const state = createPlanEngineState();
    recordActivationAttemptStart({
      state,
      deviceId: 'dev1',
      source: 'pels_restore',
      nowTs: Date.now(),
    });

    const builder = buildBuilder({ tracker, state });
    const plan = await builder.buildDevicePlanSnapshot([buildDevice()]);

    expect(plan.devices[0]?.plannedState).toBe('shed');
  });

  it('sheds on the fail-closed pass, publishes no headroom for it, and clears once a fresh sample returns', async () => {
    const tracker: { lastTimestamp: number; lastPowerW?: number } = {
      lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
      lastPowerW: 2_000,
    };
    const builder = buildBuilder({ tracker });

    const failClosedPlan = await builder.buildDevicePlanSnapshot([buildDevice()]);
    // The unmeasured build carries the signal and NO derived figure: no
    // headroom, no managed/background split, nothing a consumer could do
    // arithmetic on (owner ruling 2026-09-02).
    expect(failClosedPlan.meta.powerIsMeasured).toBe(false);
    expect(failClosedPlan.meta).not.toHaveProperty('headroomKw');
    expect(failClosedPlan.meta).not.toHaveProperty('controlledKw');
    expect(failClosedPlan.meta).not.toHaveProperty('hardCapHeadroomKw');
    expect(failClosedPlan.devices[0]?.plannedState).toBe('shed');

    tracker.lastTimestamp = Date.now();
    tracker.lastPowerW = 2 * 1000;

    const recoveredPlan = await builder.buildDevicePlanSnapshot([buildDevice()]);
    // A real difference again. The exact figure moves with the dynamic soft
    // limit, which the 10 minutes spent reaching fail-closed necessarily advanced.
    expect(expectMeasuredMeta(recoveredPlan.meta).headroomKw).toBeGreaterThan(0);
  });

  // The silent-meter pass is a DIRECTIVE — shed every candidate to its floor —
  // not a sentinel headroom the ordinary pipeline sizes a slice against. With
  // the old `-1` it shed "about 1 kW" of devices, a policy nobody chose; three
  // 1.2 kW candidates would have lost one.
  it('sheds every candidate on the silent-meter pass, not a one-kilowatt slice', async () => {
    const tracker = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 2_000 };
    const structuredLog = { info: vi.fn(), warn: vi.fn() };
    const state = createPlanEngineState();
    const builder = buildBuilder({ tracker, state, structuredLog });
    const devices = [
      buildDevice({ id: 'a', name: 'A', priority: 1, currentDrawKw: 1.2 }),
      buildDevice({ id: 'b', name: 'B', priority: 2, currentDrawKw: 1.2 }),
      buildDevice({ id: 'c', name: 'C', priority: 3, currentDrawKw: 1.2 }),
    ];

    const plan = await builder.buildDevicePlanSnapshot(devices);

    expect(plan.devices.map((dev) => dev.plannedState)).toEqual(['shed', 'shed', 'shed']);
    expect(plan.meta.powerIsMeasured).toBe(false);
    // The shedding latch engages and the instability clock stamps, exactly as
    // a measured shed would, so the first measured cycle after the meter
    // returns re-decides before any restore lane runs.
    expect(state.sheddingActive).toBe(true);
    expect(state.lastInstabilityMs).toBe(Date.now());
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_silent_meter_pass',
      shedDeviceCount: 3,
      candidateDeviceCount: 3,
    }));
    // No overshoot was "entered": the pass never prices a deficit.
    expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'overshoot_entered' }));
  });

  it('sheds a budget-exempt device too on the silent-meter pass — the exemption is from the budget, not from a silent meter', async () => {
    // Under a daily pace an exempt device is spared by ordinary shedding
    // (`allowedByLimitPolicy`). The pass is a capacity fail-closed: the house
    // may be over its cap for all anyone knows (Codex review on PR #2286).
    const tracker = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 2_000 };
    const state = createPlanEngineState();
    const builder = new PlanBuilder({
      getInferredSurplusKw: () => 0,
      getCapacityDryRun: () => false,
      setCapacityInShortfall: vi.fn(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => ({ limitKw: 6, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getPowerTracker: () => tracker,
      // A daily budget that binds: 0.3 kWh planned for this hour under a 6 kW cap.
      getDailyBudgetSnapshot: () => ({
        todayKey: '2026-04-18',
        days: {
          '2026-04-18': {
            dateKey: '2026-04-18',
            timeZone: 'UTC',
            nowUtc: new Date().toISOString(),
            dayStartUtc: '2026-04-18T00:00:00.000Z',
            currentBucketIndex: 0,
            budget: { enabled: true, dailyBudgetKWh: 6, priceShapingEnabled: false },
            state: {
              usedNowKWh: 3, allowedNowKWh: 1, remainingKWh: 3, deviationKWh: 2,
              exceeded: false, frozen: false, confidence: 1, priceShapingActive: false,
            },
            buckets: {
              startUtc: ['2026-04-18T10:00:00.000Z', '2026-04-18T11:00:00.000Z'],
              startLocalLabels: ['10', '11'],
              plannedWeight: [0.5, 0.5],
              plannedKWh: [0.3, 0.5],
              plannedUncontrolledKWh: [0, 0],
              plannedControlledKWh: [0.3, 0.5],
              actualKWh: [0, 0],
              actualControlledKWh: [0, 0],
              actualUncontrolledKWh: [0, 0],
              allowedCumKWh: [0.3, 0.8],
            },
          },
        },
      }) as never,
      getShedBehavior: () => ({ action: 'turn_off' }),
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, state);

    const plan = await builder.buildDevicePlanSnapshot([
      buildDevice({ id: 'exempt', name: 'Exempt', budgetExempt: true, currentDrawKw: 1.2 }),
      buildDevice({ id: 'plain', name: 'Plain', currentDrawKw: 1.2 }),
    ]);

    expect(plan.meta.powerIsMeasured).toBe(false);
    expect(plan.meta.softLimitSource).toBe('daily');
    expect(plan.devices.find((dev) => dev.id === 'exempt')?.plannedState).toBe('shed');
    expect(plan.devices.find((dev) => dev.id === 'plain')?.plannedState).toBe('shed');
  });

  it('keeps a thermostat at its shed setpoint on the silent-meter pass instead of raising it to the mode target', async () => {
    // A thermostat already at its floor is not a shedding candidate (nothing
    // left to shed), and a `keep` would materialize the mode's 21 °C — a
    // load-adding write the pass has no measurement to admit (Codex and
    // CodeRabbit reviews on PR #2286).
    const tracker = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 2_000 };
    const state = createPlanEngineState();
    const builder = new PlanBuilder({
      getInferredSurplusKw: () => 0,
      getCapacityDryRun: () => false,
      setCapacityInShortfall: vi.fn(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => ({ limitKw: 6, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({ Home: { thermo: 21 } }),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getPowerTracker: () => tracker,
      getDailyBudgetSnapshot: () => null,
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 16 }),
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, state);

    const plan = await builder.buildDevicePlanSnapshot([
      buildDevice({
        id: 'thermo',
        name: 'Thermostat',
        deviceType: 'temperature',
        currentTemperature: 16,
        currentTarget: 16,
        currentDrawKw: 0,
        targets: [{ id: 'target_temperature', value: 16, unit: 'C' }],
      } as Partial<PlanInputDevice>),
    ]);

    const thermo = plan.devices.find((dev) => dev.id === 'thermo');
    expect(thermo?.plannedState).toBe('shed');
    expect(isTemperaturePlanDevice(thermo!) ? thermo.plannedTarget : undefined).toBe(16);
  });

  it('names a reason for a smart task\'s forced shed on the silent-meter pass, so the plan finalizes cleanly', async () => {
    // A forced shed rides in through the hold merge with no reason of its
    // own; the measured pipeline's reason normalization would name it, and
    // the pass runs none — an unnamed shed is an invalid state/reason pair
    // (Codex review on PR #2286).
    const tracker = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 2_000 };
    const structuredLog = { info: vi.fn(), warn: vi.fn() };
    const builder = new PlanBuilder({
      getInferredSurplusKw: () => 0,
      getCapacityDryRun: () => false,
      setCapacityInShortfall: vi.fn(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => ({ limitKw: 6, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getPowerTracker: () => tracker,
      getDailyBudgetSnapshot: () => null,
      getShedBehavior: () => ({ action: 'turn_off' }),
      decorateDeferredObjectives: (input) => ({
        admittedDevices: input.devices,
        forceShedSet: new Set<string>(['idle-task']),
        deferredAvoidDeviceIds: new Set<string>(),
        deferredReleaseIntentByDeviceId: {},
        admittedDeviceIds: new Set<string>(),
      }),
      structuredLog: structuredLog as never,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, createPlanEngineState());

    const plan = await builder.buildDevicePlanSnapshot([
      // Cap-off for the cycle but admitted as controllable, the shape the
      // smart-task decoration hands the planner for a forced shed.
      buildDevice({ id: 'idle-task', name: 'Idle task', currentOn: false, binaryControl: { on: false }, currentDrawKw: 0 }),
    ]);

    const device = plan.devices.find((dev) => dev.id === 'idle-task');
    expect(device?.plannedState).toBe('shed');
    expect(device?.reason?.code).not.toBe('keep');
    expect(structuredLog.warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'plan_reason_pair_invalid' }));
  });

  it('carries a smart task release on the silent-meter pass but never a binary_restore', async () => {
    const tracker = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 2_000 };
    const state = createPlanEngineState();
    const builder = new PlanBuilder({
      getInferredSurplusKw: () => 0,
      getCapacityDryRun: () => false,
      setCapacityInShortfall: vi.fn(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => ({ limitKw: 6, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getPowerTracker: () => tracker,
      getDailyBudgetSnapshot: () => null,
      getShedBehavior: () => ({ action: 'turn_off' }),
      decorateDeferredObjectives: (input) => ({
        admittedDevices: input.devices,
        forceShedSet: new Set<string>(),
        deferredAvoidDeviceIds: new Set<string>(),
        // A negative release rides the plan; the one positive intent needs a
        // measured cycle and this is not one.
        deferredReleaseIntentByDeviceId: { release: 'binary_release', resume: 'binary_restore' },
        admittedDeviceIds: new Set<string>(),
      }),
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, state);

    const plan = await builder.buildDevicePlanSnapshot([
      buildDevice({ id: 'release', name: 'Release', controllable: false }),
      buildDevice({ id: 'resume', name: 'Resume', controllable: false, currentOn: false, binaryControl: { on: false } }),
    ]);

    expect(plan.devices.find((dev) => dev.id === 'release')?.deferredReleaseIntent).toBe('binary_release');
    expect(plan.devices.find((dev) => dev.id === 'resume')?.deferredReleaseIntent).toBeUndefined();
  });
});
