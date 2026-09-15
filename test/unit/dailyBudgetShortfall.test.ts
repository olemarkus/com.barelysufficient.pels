/**
 * Tests to verify that daily budget violations never trigger capacity shortfall.
 * Only hourly hard cap violations should trigger shortfall.
 */

import CapacityGuard from '../../lib/power/capacityGuard';
import { createTestCapacityGuard, planVerdictSummaryFixture } from '../helpers/createTestCapacityGuard';

// The guard no longer resolves the hard-cap budget itself; callers pass it in.
const TEST_SHORTFALL_THRESHOLD_KW = 10;

describe('Daily Budget Shortfall Prevention', () => {
  let guard: CapacityGuard;

  beforeEach(() => {
    guard = createTestCapacityGuard({ homeId: 'main' });

    // Report some power
  });

  test('daily budget violation (softLimitSource=daily) does not check shortfall', async () => {
    // Simulate scenario where we're shedding due to daily budget only
    // In this case, the shortfall verdict should NOT open an incident

    // This is tested at the planShedding level - when softLimitSource is 'daily',
    // the plan verdict should report load it can still shed (preventing shortfall)

    // Here we verify the behavior through the guard's perspective:
    // When power exceeds shortfallThreshold AND no candidates, shortfall triggers

    // Default threshold is the hard cap (10 kW), but we can override for testing

    // Case 1: Power (3 kW) is below shortfall threshold (9 kW)
    // Even with no candidates, shortfall should NOT trigger
    await guard.recordReading(3, TEST_SHORTFALL_THRESHOLD_KW); // no candidates
    expect(guard.isInShortfall()).toBe(false);

    // Case 2: Even if we artificially set power above threshold,
    // if the verdict reports load it can still shed, shortfall won't trigger
    await guard.recordPlanVerdict(12, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: true })); // Has candidates (daily budget case)
    expect(guard.isInShortfall()).toBe(false);
  });

  test('hourly cap violation (softLimitSource=capacity) checks shortfall', async () => {

    // Power exceeds shortfall threshold (hard cap) AND no candidates
    await guard.recordPlanVerdict(12, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false })); // No candidates

    // Shortfall should be triggered
    expect(guard.isInShortfall()).toBe(true);
  });

  test('combined violation (both limits equal, capacity wins) checks shortfall based on hourly threshold', async () => {

    // Power is below hourly hard cap but might exceed daily budget soft limit
    await guard.recordReading(5, TEST_SHORTFALL_THRESHOLD_KW); // No candidates

    // Should NOT trigger shortfall because we're below hourly threshold
    expect(guard.isInShortfall()).toBe(false);

    // Now exceed hourly threshold
    await guard.recordPlanVerdict(12, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));

    // Now it should trigger
    expect(guard.isInShortfall()).toBe(true);
  });
});
