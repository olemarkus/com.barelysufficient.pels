import CapacityGuard from '../../lib/power/capacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { buildPlanContext } from '../../lib/plan/planContext';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../lib/plan/planPowerFreshness';
import { createPlanEngineState } from '../../lib/plan/planState';
import { recordActivationAttemptStart } from '../../lib/plan/admission';
import type { PlanInputDevice, BinaryControlDiscriminantProbe } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';

const emptyPendingStore = createPendingBinaryCommandStore({});

const buildDevice = (
  overrides: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe = {},
): PlanInputDevice => withBinaryDiscriminant({
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
}) as PlanInputDevice;

describe('power sample freshness policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses real computed headroom for fresh samples', () => {

    const context = buildPlanContext({
      devices: [],
      capacitySettings: { limitKw: 6, marginKw: 0.2 },
      powerTracker: { lastTimestamp: Date.now() - (POWER_SAMPLE_STALE_THRESHOLD_MS - 1), lastPowerW: 3.2 * 1000 },
      softLimit: 5,
      capacitySoftLimit: 5,
      dailySoftLimit: null,
      softLimitSource: 'capacity',
      desiredForMode: {},
      hourlyBudgetExhausted: false,
      currentHourPriceLevel: { cheap: false, expensive: false },
    });

    expect(context.planningTotalKw).not.toBeNull();
    expect(context.hasLivePowerSample).toBe(true);
    expect(context.powerFreshnessState).toBe('fresh');
    expect(context.headroomRaw).toBeCloseTo(1.8, 6);
    expect(context.headroom).toBeCloseTo(1.8, 6);
  });

  it('uses stale-hold fallback headroom 0 for short gaps and startup with no sample', () => {
    const staleHoldContext = buildPlanContext({
      devices: [],
      capacitySettings: { limitKw: 6, marginKw: 0.2 },
      powerTracker: { lastTimestamp: Date.now() - (2 * 60 * 1000), lastPowerW: 4.4 * 1000 },
      softLimit: 5,
      capacitySoftLimit: 5,
      dailySoftLimit: null,
      softLimitSource: 'capacity',
      desiredForMode: {},
      hourlyBudgetExhausted: false,
      currentHourPriceLevel: { cheap: false, expensive: false },
    });

    expect(staleHoldContext.planningTotalKw).toBeNull();
    expect(staleHoldContext.hasLivePowerSample).toBe(false);
    expect(staleHoldContext.powerFreshnessState).toBe('stale_hold');
    expect(staleHoldContext.total).toBe(4.4);
    expect(staleHoldContext.powerSampleAgeMs).toBe(2 * 60 * 1000);
    expect(staleHoldContext.headroomRaw).toBe(0);
    expect(staleHoldContext.headroom).toBe(0);

    const startupContext = buildPlanContext({
      devices: [],
      capacitySettings: { limitKw: 6, marginKw: 0.2 },
      powerTracker: { lastPowerW: 4.4 * 1000 },
      softLimit: 5,
      capacitySoftLimit: 5,
      dailySoftLimit: null,
      softLimitSource: 'capacity',
      desiredForMode: {},
      hourlyBudgetExhausted: false,
      currentHourPriceLevel: { cheap: false, expensive: false },
    });

    expect(startupContext.powerFreshnessState).toBe('stale_hold');
    expect(startupContext.powerSampleAgeMs).toBeNull();
    expect(startupContext.headroomRaw).toBe(0);
    expect(startupContext.headroom).toBe(0);
  });

  it('uses fail-closed fallback headroom -1 once stale timeout is reached', () => {
    const context = buildPlanContext({
      devices: [],
      capacitySettings: { limitKw: 6, marginKw: 0.2 },
      powerTracker: { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 4.4 * 1000 },
      softLimit: 5,
      capacitySoftLimit: 5,
      dailySoftLimit: null,
      softLimitSource: 'capacity',
      desiredForMode: {},
      hourlyBudgetExhausted: false,
      currentHourPriceLevel: { cheap: false, expensive: false },
    });

    expect(context.powerFreshnessState).toBe('stale_fail_closed');
    expect(context.headroomRaw).toBe(-1);
    expect(context.headroom).toBe(-1);
  });
});

// Per-axis restore-admission inputs share the binding axis's freshness policy
// (fresh: real difference; stale_hold: 0; stale_fail_closed: -1) and the
// exhausted-hour force, so fail-closed and exhausted hours block every restore
// on every axis — including budget-exempt candidates on the capacity axis.
describe('per-axis admission headroom resolution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const exemptRunningDevice = buildDevice({
    id: 'exempt-heater',
    budgetExempt: true,
    currentDrawKw: 1.25,
  });

  const baseParams = {
    capacitySettings: { limitKw: 6, marginKw: 0.2 },
    desiredForMode: {},
    hourlyBudgetExhausted: false,
    currentHourPriceLevel: { cheap: false, expensive: false },
    softLimit: 2.2,
    capacitySoftLimit: 10,
    dailySoftLimit: 2.2,
    budgetPaceKw: 0.9,
    softLimitSource: 'daily' as const,
  };

  it('resolves both axes from fresh power, with the MEASURED exempt sum on the budget axis', () => {
    const context = buildPlanContext({
      ...baseParams,
      devices: [exemptRunningDevice],
      powerTracker: { lastTimestamp: Date.now() - 1000, lastPowerW: 1.85 * 1000 },
    });

    expect(context.capacityHeadroomKw).toBeCloseTo(10 - 1.85, 6);
    // budget pace (0.9) + measured exempt (1.25) - total (1.85)
    expect(context.budgetHeadroomKw).toBeCloseTo(0.3, 6);
  });

  it('has no budget axis without a resolved daily pace', () => {
    const context = buildPlanContext({
      ...baseParams,
      dailySoftLimit: null,
      budgetPaceKw: null,
      softLimitSource: 'capacity',
      devices: [],
      powerTracker: { lastTimestamp: Date.now() - 1000, lastPowerW: 1.85 * 1000 },
    });

    expect(context.budgetHeadroomKw).toBeNull();
  });

  it('synthesizes 0 on both axes in stale-hold and -1 once fail-closed', () => {
    const staleHold = buildPlanContext({
      ...baseParams,
      devices: [],
      powerTracker: { lastTimestamp: Date.now() - (2 * 60 * 1000), lastPowerW: 1.85 * 1000 },
    });
    expect(staleHold.powerFreshnessState).toBe('stale_hold');
    expect(staleHold.capacityHeadroomKw).toBe(0);
    expect(staleHold.budgetHeadroomKw).toBe(0);

    const failClosed = buildPlanContext({
      ...baseParams,
      devices: [],
      powerTracker: { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, lastPowerW: 1.85 * 1000 },
    });
    expect(failClosed.powerFreshnessState).toBe('stale_fail_closed');
    expect(failClosed.capacityHeadroomKw).toBe(-1);
    expect(failClosed.budgetHeadroomKw).toBe(-1);
  });

  it('forces both axes to -1 in an exhausted hour with a ~0 meter', () => {
    const context = buildPlanContext({
      ...baseParams,
      softLimit: 0,
      hourlyBudgetExhausted: true,
      currentHourPriceLevel: { cheap: false, expensive: false },
      devices: [],
      powerTracker: { lastTimestamp: Date.now() - 1000, lastPowerW: 0 * 1000 },
    });

    expect(context.headroom).toBe(-1);
    expect(context.capacityHeadroomKw).toBe(-1);
    expect(context.budgetHeadroomKw).toBe(-1);
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
    tracker: { lastTimestamp?: number };
    capacityGuard?: CapacityGuard;
    structuredLog?: { info?: ReturnType<typeof vi.fn>; warn?: ReturnType<typeof vi.fn> };
    state?: ReturnType<typeof createPlanEngineState>;
  }): PlanBuilder {
    return new PlanBuilder({
      getCapacityGuard: () => params.capacityGuard,
      setCapacityInShortfall: vi.fn(),
      getCapacitySettings: () => ({ limitKw: 6, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => params.tracker,
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
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
    const tracker = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS };
    const state = createPlanEngineState();
    recordActivationAttemptStart({
      state,
      deviceId: 'dev1',
      source: 'pels_restore',
      nowTs: Date.now(),
    });

    const builder = buildBuilder({ tracker, state });
    const plan = await builder.buildDevicePlanSnapshot([buildDevice()]);

    expect(plan.meta.powerFreshnessState).toBe('stale_fail_closed');
    expect(plan.devices[0]?.plannedState).toBe('shed');
  });

  it('allows fail-closed shedding and clears once a fresh sample returns', async () => {
    const tracker: { lastTimestamp: number; lastPowerW?: number } = {
      lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
      lastPowerW: 4.9 * 1000,
    };
    const structuredLog = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const builder = buildBuilder({
      tracker,
      structuredLog,
    });

    const failClosedPlan = await builder.buildDevicePlanSnapshot([buildDevice()]);
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
    expect(recoveredPlan.meta.headroomKw).toBeCloseTo(3.8, 6);
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_sample_stale_fail_closed_cleared',
    }));
  });
});
