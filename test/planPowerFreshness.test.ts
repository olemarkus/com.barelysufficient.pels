import CapacityGuard from '../lib/core/capacityGuard';
import { PlanBuilder } from '../lib/plan/planBuilder';
import { buildPlanContext } from '../lib/plan/planContext';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../lib/plan/planPowerFreshness';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanInputDevice } from '../lib/plan/planTypes';

const buildDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'dev',
  name: 'Device',
  targets: [],
  currentOn: true,
  controllable: true,
  expectedPowerKw: 1.2,
  ...overrides,
});

describe('power sample freshness policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses real computed headroom for fresh samples', () => {
    const capacityGuard = new CapacityGuard({ limitKw: 6, softMarginKw: 0 });
    capacityGuard.reportTotalPower(3.2);

    const context = buildPlanContext({
      devices: [],
      capacityGuard,
      capacitySettings: { limitKw: 6, marginKw: 0.2 },
      powerTracker: { lastTimestamp: Date.now() - (POWER_SAMPLE_STALE_THRESHOLD_MS - 1) },
      softLimit: 5,
      capacitySoftLimit: 5,
      dailySoftLimit: null,
      softLimitSource: 'capacity',
      desiredForMode: {},
      hourlyBudgetExhausted: false,
    });

    expect(context.powerKnown).toBe(true);
    expect(context.hasLivePowerSample).toBe(true);
    expect(context.powerFreshnessState).toBe('fresh');
    expect(context.headroomRaw).toBeCloseTo(1.8, 6);
    expect(context.headroom).toBeCloseTo(1.8, 6);
  });

  it('uses stale-hold fallback headroom 0 for short gaps and startup with no sample', () => {
    const staleCapacityGuard = new CapacityGuard({ limitKw: 6, softMarginKw: 0 });
    staleCapacityGuard.reportTotalPower(4.4);
    const staleHoldContext = buildPlanContext({
      devices: [],
      capacityGuard: staleCapacityGuard,
      capacitySettings: { limitKw: 6, marginKw: 0.2 },
      powerTracker: { lastTimestamp: Date.now() - (2 * 60 * 1000) },
      softLimit: 5,
      capacitySoftLimit: 5,
      dailySoftLimit: null,
      softLimitSource: 'capacity',
      desiredForMode: {},
      hourlyBudgetExhausted: false,
    });

    expect(staleHoldContext.powerKnown).toBe(false);
    expect(staleHoldContext.hasLivePowerSample).toBe(false);
    expect(staleHoldContext.powerFreshnessState).toBe('stale_hold');
    expect(staleHoldContext.total).toBe(4.4);
    expect(staleHoldContext.powerSampleAgeMs).toBe(2 * 60 * 1000);
    expect(staleHoldContext.headroomRaw).toBe(0);
    expect(staleHoldContext.headroom).toBe(0);

    const startupContext = buildPlanContext({
      devices: [],
      capacityGuard: undefined,
      capacitySettings: { limitKw: 6, marginKw: 0.2 },
      powerTracker: {},
      softLimit: 5,
      capacitySoftLimit: 5,
      dailySoftLimit: null,
      softLimitSource: 'capacity',
      desiredForMode: {},
      hourlyBudgetExhausted: false,
    });

    expect(startupContext.powerFreshnessState).toBe('stale_hold');
    expect(startupContext.powerSampleAgeMs).toBeNull();
    expect(startupContext.headroomRaw).toBe(0);
    expect(startupContext.headroom).toBe(0);
  });

  it('uses fail-closed fallback headroom -1 once stale timeout is reached', () => {
    const context = buildPlanContext({
      devices: [],
      capacityGuard: undefined,
      capacitySettings: { limitKw: 6, marginKw: 0.2 },
      powerTracker: { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS },
      softLimit: 5,
      capacitySoftLimit: 5,
      dailySoftLimit: null,
      softLimitSource: 'capacity',
      desiredForMode: {},
      hourlyBudgetExhausted: false,
    });

    expect(context.powerFreshnessState).toBe('stale_fail_closed');
    expect(context.headroomRaw).toBe(-1);
    expect(context.headroom).toBe(-1);
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
  }): PlanBuilder {
    return new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => params.capacityGuard,
      getCapacitySettings: () => ({ limitKw: 6, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => params.tracker,
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      structuredLog: params.structuredLog as never,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, createPlanEngineState());
  }

  it('does not proactively shed solely because power data is in stale-hold', async () => {
    const capacityGuard = new CapacityGuard({ limitKw: 6, softMarginKw: 0.2 });
    capacityGuard.reportTotalPower(5.8);
    const builder = buildBuilder({
      tracker: { lastTimestamp: Date.now() - (2 * 60 * 1000) },
      capacityGuard,
    });

    const plan = await builder.buildDevicePlanSnapshot([buildDevice()]);

    expect(plan.meta.powerFreshnessState).toBe('stale_hold');
    expect(plan.meta.powerKnown).toBe(false);
    expect(plan.meta.headroomKw).toBe(0);
    expect(plan.devices[0]?.plannedState).toBe('keep');
  });

  it('logs stale-hold only on transition, not on every rebuild', async () => {
    const capacityGuard = new CapacityGuard({ limitKw: 6, softMarginKw: 0.2 });
    capacityGuard.reportTotalPower(5.8);
    const structuredLog = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const builder = buildBuilder({
      tracker: { lastTimestamp: Date.now() - (2 * 60 * 1000) },
      capacityGuard,
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

  it('allows fail-closed shedding and clears once a fresh sample returns', async () => {
    const tracker = { lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS };
    const capacityGuard = new CapacityGuard({ limitKw: 6, softMarginKw: 0.2 });
    capacityGuard.reportTotalPower(4.9);
    const structuredLog = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const builder = buildBuilder({
      tracker,
      capacityGuard,
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
    capacityGuard.reportTotalPower(2);

    const recoveredPlan = await builder.buildDevicePlanSnapshot([buildDevice()]);
    expect(recoveredPlan.meta.powerFreshnessState).toBe('fresh');
    expect(recoveredPlan.meta.headroomKw).toBeCloseTo(3.8, 6);
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_sample_stale_fail_closed_cleared',
    }));
  });
});
