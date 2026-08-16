/**
 * Tests to verify that daily budget violations never trigger capacity shortfall.
 * Only hourly hard cap violations should trigger shortfall.
 */

import CapacityGuard from '../../lib/power/capacityGuard';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { buildNullCapacityStateSummary } from '../../lib/power/capacityStateSummary';

// The guard no longer resolves the hard-cap budget itself; callers pass it in.
const TEST_SHORTFALL_THRESHOLD_KW = 10;

describe('Daily Budget Shortfall Prevention', () => {
  let guard: CapacityGuard;

  beforeEach(() => {
    guard = createTestCapacityGuard({
      homeId: 'main',
      limitKw: 10,
      softMarginKw: 1,
    });

    // Report some power
  });

  test('daily budget violation (softLimitSource=daily) does not check shortfall', async () => {
    // Simulate scenario where we're shedding due to daily budget only
    // In this case, updateGuardState should NOT check shortfall

    // This is tested at the planShedding level - when softLimitSource is 'daily',
    // checkShortfall should be called with hasCandidates=true (preventing shortfall)

    // We can't easily test updateGuardState directly as it's not exported,
    // but we can verify the behavior through the guard's perspective:
    // When power exceeds shortfallThreshold AND no candidates, shortfall triggers

    // Default threshold is the hard cap (10 kW), but we can override for testing

    // Case 1: Power (3 kW) is below shortfall threshold (9 kW)
    // Even with no candidates, shortfall should NOT trigger
    await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0,
      totalKw: 3,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    }); // no candidates
    expect(guard.isInShortfall()).toBe(false);

    // Case 2: Even if we artificially set power above threshold,
    // if we're being called with hasCandidates=true, shortfall won't trigger
    await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 3,
      totalKw: 12,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    }); // Has candidates (daily budget case)
    expect(guard.isInShortfall()).toBe(false);
  });

  test('hourly cap violation (softLimitSource=capacity) checks shortfall', async () => {

    // Power exceeds shortfall threshold (hard cap) AND no candidates
    await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 3,
      totalKw: 12,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    }); // No candidates

    // Shortfall should be triggered
    expect(guard.isInShortfall()).toBe(true);
  });

  test('combined violation (both limits equal, capacity wins) checks shortfall based on hourly threshold', async () => {

    // Power is below hourly hard cap but might exceed daily budget soft limit
    await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 2,
      totalKw: 5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    }); // No candidates

    // Should NOT trigger shortfall because we're below hourly threshold
    expect(guard.isInShortfall()).toBe(false);

    // Now exceed hourly threshold
    await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 3,
      totalKw: 12,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

    // Now it should trigger
    expect(guard.isInShortfall()).toBe(true);
  });
});
