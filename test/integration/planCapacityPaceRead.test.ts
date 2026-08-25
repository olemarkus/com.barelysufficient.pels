/**
 * The capacity pace has one writer. `PlanBuilder.stampCapacityPace` runs at the
 * top of a build and stamps `hourlyBudgetExhausted` / `hourlyRemainingKWh` for
 * the rest of that cycle to read; every other caller of the pace — the periodic
 * status log, a Flow `has_headroom` condition, the rebuild scheduler's threshold
 * input, the shortfall log line — goes through `computeDynamicSoftLimit`, which
 * returns the same number and writes nothing.
 *
 * It matters because the build's own reads of those two fields are not all in
 * one turn of the event loop: the shed decision reads them before the guard's
 * awaited shortfall path, and the reason and meta passes that label that
 * decision read them after. A foreign caller that stamped could land in that
 * window and hand the labels a different hour than the decision saw.
 */
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState, type PlanEngineState } from '../../lib/plan/planState';
import { getHourBucketKey } from '../../lib/utils/dateUtils';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import type { PowerTrackerState } from '../../lib/power/tracker';

/** 5 kWh of hourly allowance, so a 6 kWh bucket is a spent hour and 1 kWh is not. */
const buildPaceBuilder = (params: {
  state: PlanEngineState;
  getPowerTracker: () => PowerTrackerState;
  getDynamicSoftLimitOverride?: () => number | null;
}): PlanBuilder => new PlanBuilder({
  capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
  setCapacityInShortfall: vi.fn(),
  getCapacityDryRun: () => false,
  getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
  getOperatingMode: () => 'Home',
  getModeDeviceTargets: () => ({}),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
  getPowerTracker: params.getPowerTracker,
  getDailyBudgetSnapshot: () => null,
  getPriorityForDevice: () => 100,
  getDynamicSoftLimitOverride: params.getDynamicSoftLimitOverride,
  getShedBehavior: () => ({ action: 'turn_off' }),
  log: vi.fn(),
  logDebug: vi.fn(),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
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
    expect(builder.computeDynamicSoftLimit()).toBeGreaterThan(0);
    // The stamp is not: it still belongs to the last build.
    expect(state.hourlyBudgetExhausted).toBe(true);
    expect(state.hourlyRemainingKWh).toBe(0);
  });

  it('the read keeps the override precedence the stamp has', async () => {
    // Only tests install an override, but it is what makes `getCapacityPaceKw`
    // and the status log agree with the plan under test. Losing it on the read
    // half would leave those two answering from the real tracker while the plan
    // ran on the override, and nothing else asserts they are the same number.
    const state = createPlanEngineState();
    const builder = buildPaceBuilder({
      state,
      getPowerTracker: () => trackerWithHourUsage(6),
      getDynamicSoftLimitOverride: () => 2.1,
    });

    expect(builder.computeDynamicSoftLimit()).toBe(2.1);
    // An override replaces the pace and says nothing about the hour, so the
    // stamp it would have taken is `false` — and the read takes none at all.
    expect(state.hourlyBudgetExhausted).toBe(false);
    expect(state.hourlyRemainingKWh).toBe(0);

    await builder.buildDevicePlanSnapshot([]);
    expect(state.hourlyBudgetExhausted).toBe(false);
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
