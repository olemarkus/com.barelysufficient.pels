/**
 * The capacity pace has one writer. `PlanBuilder.stampCapacityPace` runs at the
 * top of a build and stamps `hourlyBudgetExhausted` / `hourlyRemainingKWh` for
 * the rest of that cycle to read; every other caller of the pace — the periodic
 * status log, a Flow `has_headroom` condition, the rebuild scheduler's threshold
 * input, the shortfall log line — goes through a read (`computeCapacityPace`, or
 * `computePhysicalPowerLimit` with the grid target folded in), which
 * returns the build's number and writes nothing.
 *
 * It matters because the build's own reads of those two fields are not all in
 * one turn of the event loop: the shed decision reads them before the guard's
 * awaited shortfall path, and the reason and meta passes that label that
 * decision read them after. A foreign caller that stamped could land in that
 * window and hand the labels a different hour than the decision saw.
 */
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { type PlanEngineState } from '../../lib/plan/planState';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { getHourBucketKey } from '../../lib/utils/hourBuckets';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { planBuilderWiring } from '../helpers/planBuilderWiring';
import { configuredHardCap } from '../helpers/configuredHardCap';
import { createHeldCapacityLimitRead } from '../../lib/power/heldCapacityLimit';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';

/** 5 kWh of hourly allowance, so a 6 kWh bucket is a spent hour and 1 kWh is not. */
const buildPaceBuilder = (params: {
  state: PlanEngineState;
  getPowerTracker: () => PowerTrackerState;
}): PlanBuilder => new PlanBuilder({
  ...planBuilderWiring(),
  capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
  getCapacitySettings: () => configuredHardCap({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 5, marginKw: 0, periodMinutes: 60 }),
  getPowerTracker: params.getPowerTracker,
}, params.state);

const trackerWithHourUsage = (usedKWh: number): PowerTrackerState => ({
  lastTimestamp: Date.now(),
  lastPowerW: 2_500,
  buckets: { [getHourBucketKey(Date.now())]: usedKWh },
});

describe('capacity pace: the build stamps, everyone else reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T11:04:01.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a pace read outside a build leaves the hour the build stamped', async () => {
    const state = createPlanEngineState();
    let powerTracker = trackerWithHourUsage(6);
    const builder = buildPaceBuilder({ state, getPowerTracker: () => powerTracker });

    await builder.buildDevicePlanSnapshot([]);
    expect(state.hourlyBudgetExhausted).toBe(true);
    expect(state.hourlyRemainingKWh).toBe(0);

    // The meter now says the hour is untouched — but nothing has rebuilt yet, so
    // no plan has been decided against that.
    powerTracker = trackerWithHourUsage(0);

    // The read is live: it answers from the tracker as it stands.
    expect(builder.computePhysicalPowerLimit()).toBeGreaterThan(0);
    // The stamp is not: it still belongs to the last build.
    expect(state.hourlyBudgetExhausted).toBe(true);
    expect(state.hourlyRemainingKWh).toBe(0);
  });


  it('the next build stamps the hour it actually sees', async () => {
    const state = createPlanEngineState();
    let powerTracker = trackerWithHourUsage(6);
    const builder = buildPaceBuilder({ state, getPowerTracker: () => powerTracker });

    await builder.buildDevicePlanSnapshot([]);
    expect(state.hourlyBudgetExhausted).toBe(true);

    powerTracker = trackerWithHourUsage(1);
    await builder.buildDevicePlanSnapshot([]);
    expect(state.hourlyBudgetExhausted).toBe(false);
    expect(state.hourlyRemainingKWh).toBe(4);
  });
});

describe('capacity pace on the held hard cap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T11:00:30.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const SCALARS: CapacityScalarSettings = {
    capacityEnabled: true, gridImportLimitKw: 6, limitKw: 5, marginKw: 0.2, periodMinutes: 15,
    dryRun: false, followMonthPeak: true,
  };
  const quarterTracker = (): PowerTrackerState => ({
    lastTimestamp: Date.now(),
    lastPowerW: 1_000,
    capacityQuarter: { startMs: Date.parse('2026-04-15T11:00:00.000Z'), energyKWh: 0, trackedMs: 30_000 },
    capacityMonthlyPeak: { monthKey: '2026-04', peakKw: 8 },
  });
  const builderFor = (scalars: CapacityScalarSettings): PlanBuilder => {
    const getPowerTracker = quarterTracker;
    return new PlanBuilder({
      ...planBuilderWiring(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: createHeldCapacityLimitRead({
        readScalars: () => scalars,
        readTracker: getPowerTracker,
        readTimeZone: () => 'Europe/Brussels',
      }),
      getPowerTracker,
    }, createPlanEngineState());
  };

  it('paces against this month\'s peak once it is above the hard cap, and publishes which cap it holds', async () => {
    const builder = builderFor({ ...SCALARS, gridImportLimitKw: null });
    expect(builder.computeCapacityPace()).toBeCloseTo(7.8, 6);

    const plan = await builder.buildDevicePlanSnapshot([]);
    expect(plan.meta.hardCapLimitKw).toBe(8);
    expect(plan.meta.hardCapSource).toBe('month_peak');
  });

  it('never raises the grid import limit', () => {
    const builder = builderFor(SCALARS);
    expect(builder.computeCapacityPace()).toBeCloseTo(7.8, 6);
    expect(builder.computePhysicalPowerLimit()).toBeCloseTo(5.7, 6);
  });

  it('paces against the configured hard cap with the switch off', async () => {
    const builder = builderFor({ ...SCALARS, gridImportLimitKw: null, followMonthPeak: false });
    expect(builder.computeCapacityPace()).toBeCloseTo(4.8, 6);

    const plan = await builder.buildDevicePlanSnapshot([]);
    expect(plan.meta.hardCapLimitKw).toBe(5);
    expect(plan.meta.hardCapSource).toBe('configured');
  });
});
