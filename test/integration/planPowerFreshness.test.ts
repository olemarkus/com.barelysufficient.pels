import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { resolvePowerCycleReading } from '../../lib/power/powerCycleReading';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { buildPlanContext } from '../../lib/plan/planContext';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../lib/power/sampleFreshness';
import { createPlanEngineState } from '../../lib/plan/planState';
import { recordActivationAttemptStart } from '../../lib/plan/admission';
import type { PlanInputDevice, BinaryControlDiscriminantProbe } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { withFixtureResidualKw } from '../utils/planTestUtils';
import { PriceLevel } from '../../lib/price/priceLevels';

const emptyPendingStore = createPendingBinaryCommandStore({});

// The producer resolves the reading; `buildPlanContext` receives answers. Tests
// state the two real inputs — what the meter read and when it last sampled.
// (In production a silent-past-timeout build only happens as the escalation's
// one fail-closed pass — every other silent rebuild is blocked by the composed
// gate; driving the builder directly here exercises exactly that pass.)
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

  const contextFor = (params: {
    powerTracker: { lastTimestamp?: number; lastPowerW?: number };
    devices?: PlanInputDevice[];
    softLimit?: number;
    capacitySoftLimit?: number;
    dailySoftLimit?: number | null;
    budgetPaceKw?: number | null;
    projectedExemptKw?: number | null;
    softLimitSource?: 'capacity' | 'daily';
    hourlyBudgetExhausted?: boolean;
  }) => buildPlanContext({
    devices: params.devices ?? [],
    power: readingFor(params.powerTracker),
    capacitySettings: { limitKw: 6, marginKw: 0.2 },
    powerTracker: params.powerTracker,
    softLimit: params.softLimit ?? 5,
    capacitySoftLimit: params.capacitySoftLimit ?? 5,
    dailySoftLimit: params.dailySoftLimit ?? null,
    budgetPaceKw: params.budgetPaceKw ?? null,
    projectedExemptKw: params.projectedExemptKw ?? null,
    softLimitSource: params.softLimitSource ?? 'capacity',
    modeTargetCFor: (d) => d.currentTarget,
    hourlyBudgetExhausted: params.hourlyBudgetExhausted ?? false,
    currentHourPriceLevel: PriceLevel.UNKNOWN,
  });

  it('uses real computed headroom for fresh samples', () => {
    const context = contextFor({
      powerTracker: { lastTimestamp: Date.now() - (POWER_SAMPLE_STALE_THRESHOLD_MS - 1), lastPowerW: 3.2 * 1000 },
    });

    expect(context.powerIsMeasured).toBe(true);
    expect(context.headroomRaw).toBeCloseTo(1.8, 6);
    expect(context.headroom).toBeCloseTo(1.8, 6);
  });

  // Owner ruling 2026-08-31: a short gap is a no-op, not a hold — the last
  // good value carries forward AS MEASURED until the 10-minute silence mark.
  it('carries a minutes-old reading forward as measured; a build with no sample at all fails loud', () => {
    const carriedContext = contextFor({
      powerTracker: { lastTimestamp: Date.now() - (2 * 60 * 1000), lastPowerW: 4.4 * 1000 },
    });

    expect(carriedContext.powerIsMeasured).toBe(true);
    expect(carriedContext.headroomRaw).toBeCloseTo(0.6, 6);
    expect(carriedContext.headroom).toBeCloseTo(0.6, 6);

    // Startup with NO sample is the measurement gate's case, not a context
    // state: a build with an unsampled tracker is a gate violation and fails
    // loud instead of synthesizing a held headroom.
    expect(() => contextFor({ powerTracker: {} })).toThrow(/measurement gate/);
  });

  it('uses fail-closed fallback headroom -1 once stale timeout is reached', () => {
    const context = contextFor({
      powerTracker: { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 4_400 },
    });

    expect(context.powerIsMeasured).toBe(false);
    expect(context.headroomRaw).toBe(-1);
    expect(context.headroom).toBe(-1);
  });

  // Per-axis restore-admission inputs share the binding axis's policy (measured:
  // real difference; held: 0; fail-closed: -1) and the exhausted-hour force, so
  // fail-closed and exhausted hours block every restore on every axis —
  // including budget-exempt candidates on the capacity axis.
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
      const context = contextFor({
        ...perAxis,
        devices: [exemptRunningDevice],
        powerTracker: { lastTimestamp: Date.now() - 1000, lastPowerW: 1.85 * 1000 },
      });

      expect(context.capacityHeadroomKw).toBeCloseTo(10 - 1.85, 6);
      // budget pace (0.9) + measured exempt (1.25) - total (1.85)
      expect(context.budgetHeadroomKw).toBeCloseTo(0.3, 6);
    });

    it('has no budget axis without a resolved daily pace', () => {
      const context = contextFor({
        ...perAxis,
        dailySoftLimit: null,
        budgetPaceKw: null,
        softLimitSource: 'capacity',
        powerTracker: { lastTimestamp: Date.now() - 1000, lastPowerW: 1.85 * 1000 },
      });

      expect(context.budgetHeadroomKw).toBeNull();
    });

    it('synthesizes -1 on both axes once the silence passes the shed timeout', () => {
      const failClosed = contextFor({
        ...perAxis,
        powerTracker: { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 1_850 },
      });
      expect(failClosed.capacityHeadroomKw).toBe(-1);
      expect(failClosed.budgetHeadroomKw).toBe(-1);
    });

    // The ~0 read has to be MEASURED now: the force used to fire off the raw
    // cached total, which survives a dropout.
    it('forces both axes to -1 in an exhausted hour with a ~0 meter', () => {
      const context = contextFor({
        ...perAxis,
        softLimit: 0,
        hourlyBudgetExhausted: true,
        powerTracker: { lastTimestamp: Date.now() - 1000, lastPowerW: 0 * 1000 },
      });

      expect(context.headroom).toBe(-1);
      expect(context.capacityHeadroomKw).toBe(-1);
      expect(context.budgetHeadroomKw).toBe(-1);
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

  it('sheds on the fail-closed pass and clears once a fresh sample returns', async () => {
    const tracker: { lastTimestamp: number; lastPowerW?: number } = {
      lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
      lastPowerW: 2_000,
    };
    const builder = buildBuilder({ tracker });

    const failClosedPlan = await builder.buildDevicePlanSnapshot([buildDevice()]);
    expect(failClosedPlan.meta.headroomKw).toBe(-1);
    expect(failClosedPlan.devices[0]?.plannedState).toBe('shed');

    tracker.lastTimestamp = Date.now();
    tracker.lastPowerW = 2 * 1000;

    const recoveredPlan = await builder.buildDevicePlanSnapshot([buildDevice()]);
    // A real difference again, not the synthesized -1. The exact figure moves
    // with the dynamic soft limit, which the 10 minutes spent reaching
    // fail-closed necessarily advanced.
    expect(recoveredPlan.meta.headroomKw).toBeGreaterThan(0);
  });
});
