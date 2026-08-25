import { resolveLastTotalPowerKw } from '../../lib/power/lastTotalPower';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PowerFreshnessMonitor } from '../../lib/power/powerCycleReading';
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

const emptyPendingStore = createPendingBinaryCommandStore({});

// The producer resolves the reading; `buildPlanContext` receives answers. Tests
// state the two real inputs — what the meter read and when it last sampled.
const readingFor = (
  powerTracker: { lastTimestamp?: number; lastPowerW?: number },
) => {
  // Already watching: the producer will not escalate to fail-closed on its FIRST
  // look (a restart reloads an aged timestamp, and escalating on it would shed
  // the house blind at boot). These cases are about the LADDER, not the grace —
  // the grace has its own tests in `test/unit/powerCycleReading.test.ts`.
  const monitor = new PowerFreshnessMonitor();
  monitor.observe({
    powerTracker: {},
    totalKw: null,
    nowMs: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  });
  return monitor.observe({
    powerTracker,
    totalKw: resolveLastTotalPowerKw(powerTracker),
    nowMs: Date.now(),
  });
};

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
    currentHourPriceLevel: { cheap: false, expensive: false },
  });

  it('uses real computed headroom for fresh samples', () => {
    const context = contextFor({
      powerTracker: { lastTimestamp: Date.now() - (POWER_SAMPLE_STALE_THRESHOLD_MS - 1), lastPowerW: 3.2 * 1000 },
    });

    expect(context.powerIsMeasured).toBe(true);
    expect(context.headroomRaw).toBeCloseTo(1.8, 6);
    expect(context.headroom).toBeCloseTo(1.8, 6);
  });

  // The cached total (4.4) is deliberately NOT spent: an unmeasured cycle holds
  // at 0 rather than reading a figure the meter has stopped confirming.
  it('uses stale-hold fallback headroom 0 for short gaps and startup with no sample', () => {
    const staleHoldContext = contextFor({
      powerTracker: { lastTimestamp: Date.now() - (2 * 60 * 1000), lastPowerW: 4.4 * 1000 },
    });

    expect(staleHoldContext.powerIsMeasured).toBe(false);
    expect(staleHoldContext.headroomRaw).toBe(0);
    expect(staleHoldContext.headroom).toBe(0);

    const startupContext = contextFor({ powerTracker: {} });

    expect(startupContext.powerIsMeasured).toBe(false);
    expect(startupContext.headroomRaw).toBe(0);
    expect(startupContext.headroom).toBe(0);
  });

  it('uses fail-closed fallback headroom -1 once stale timeout is reached', () => {
    const context = contextFor({
      powerTracker: { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS },
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

    it('synthesizes 0 on both axes in stale-hold and -1 once fail-closed', () => {
      const staleHold = contextFor({
        ...perAxis,
        powerTracker: { lastTimestamp: Date.now() - (2 * 60 * 1000), lastPowerW: 1.85 * 1000 },
      });
      expect(staleHold.capacityHeadroomKw).toBe(0);
      expect(staleHold.budgetHeadroomKw).toBe(0);

      const failClosed = contextFor({
        ...perAxis,
        powerTracker: { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS },
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

  /**
   * Drive a builder to a genuine fail-closed: one real sample, then silence past
   * the shed timeout. A builder cannot escalate on its FIRST look any more — the
   * producer holds until it has watched for the timeout itself, because
   * `lastTimestamp` survives a restart and escalating on it would shed the whole
   * house blind at boot.
   */
  async function driveToFailClosed(
    builder: PlanBuilder,
    sampleNow: (nowMs: number) => void,
    devices: PlanInputDevice[],
  ) {
    sampleNow(Date.now());
    await builder.buildDevicePlanSnapshot(devices);
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    return builder.buildDevicePlanSnapshot(devices);
  }

  function buildBuilder(params: {
    tracker: { lastTimestamp?: number; lastPowerW?: number };
    structuredLog?: { info?: ReturnType<typeof vi.fn>; warn?: ReturnType<typeof vi.fn> };
    state?: ReturnType<typeof createPlanEngineState>;
  }): PlanBuilder {
    return new PlanBuilder({
      getCapacityDryRun: () => false,
      setCapacityInShortfall: vi.fn(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => ({ limitKw: 6, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => params.tracker,
      getDailyBudgetSnapshot: () => null,
      getShedBehavior: () => ({ action: 'turn_off' }),
      structuredLog: params.structuredLog as never,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, params.state ?? createPlanEngineState());
  }

  it('does not proactively shed solely because power data is in stale-hold', async () => {
    const builder = buildBuilder({
      tracker: { lastTimestamp: Date.now() - (2 * 60 * 1000) },
    });

    const plan = await builder.buildDevicePlanSnapshot([buildDevice()]);

    expect(plan.meta.powerFreshnessState).toBe('stale_hold');
    expect(plan.meta.powerNowKw).toBeNull();
    expect(plan.meta.headroomKw).toBe(0);
    expect(plan.devices[0]?.plannedState).toBe('keep');
  });

  it('logs stale-hold only on transition, not on every rebuild', async () => {
    const structuredLog = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const builder = buildBuilder({
      tracker: { lastTimestamp: Date.now() - (2 * 60 * 1000) },
      structuredLog,
    });

    await builder.buildDevicePlanSnapshot([buildDevice()]);
    await builder.buildDevicePlanSnapshot([buildDevice()]);

    expect(structuredLog.warn).toHaveBeenCalledTimes(1);
    expect(structuredLog.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_sample_stale_hold_entered',
      syntheticHeadroomKw: 0,
    }));
  });

  // The shed grace buys time only when a deficit might be a restore PELS itself
  // is driving AND power is observable. Blind mode is the one place waiting is
  // never right, so an open activation attempt must not soften a fail-closed
  // shed. A first cut of the grace gated every deficit and delayed exactly this.
  it('grants no shed grace while power is stale, even with a restore in flight', async () => {
    const tracker: { lastTimestamp: number; lastPowerW?: number } = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS };
    const state = createPlanEngineState();
    recordActivationAttemptStart({
      state,
      deviceId: 'dev1',
      source: 'pels_restore',
      nowTs: Date.now(),
    });

    const builder = buildBuilder({ tracker, state });
    const plan = await driveToFailClosed(builder, (ms) => { tracker.lastTimestamp = ms; }, [buildDevice()]);

    expect(plan.meta.powerFreshnessState).toBe('stale_fail_closed');
    expect(plan.devices[0]?.plannedState).toBe('shed');
  });

  it('allows fail-closed shedding and clears once a fresh sample returns', async () => {
    const tracker: { lastTimestamp: number; lastPowerW?: number } = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS };
    const structuredLog = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const builder = buildBuilder({
      tracker,
      structuredLog,
    });

    const failClosedPlan = await driveToFailClosed(builder, (ms) => { tracker.lastTimestamp = ms; }, [buildDevice()]);
    expect(failClosedPlan.meta.powerFreshnessState).toBe('stale_fail_closed');
    expect(failClosedPlan.meta.headroomKw).toBe(-1);
    expect(failClosedPlan.devices[0]?.plannedState).toBe('shed');
    expect(structuredLog.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_sample_stale_fail_closed_entered',
      syntheticHeadroomKw: -1,
    }));

    tracker.lastTimestamp = Date.now();
    tracker.lastPowerW = 2 * 1000;

    const recoveredPlan = await builder.buildDevicePlanSnapshot([buildDevice()]);
    expect(recoveredPlan.meta.powerFreshnessState).toBe('fresh');
    // A real difference again, not the synthesized -1. The exact figure moves
    // with the dynamic soft limit, which the 10 minutes spent reaching
    // fail-closed necessarily advanced.
    expect(recoveredPlan.meta.headroomKw).toBeGreaterThan(0);
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_sample_stale_fail_closed_cleared',
    }));
  });
});
