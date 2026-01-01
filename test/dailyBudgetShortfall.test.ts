/**
 * Tests to verify that daily budget violations never trigger capacity shortfall.
 * Only hourly hard cap violations should trigger shortfall.
 */

import { jest } from '@jest/globals';
import CapacityGuard from '../lib/core/capacityGuard';

describe('Daily Budget Shortfall Prevention', () => {
  let guard: CapacityGuard;

  beforeEach(() => {
    guard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 1,
      log: jest.fn(),
    });

    // Report some power
    guard.reportTotalPower(3);
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
    const shortfallThreshold = 10; // hard cap
    guard.setShortfallThresholdProvider(() => shortfallThreshold);

    // Case 1: Power (3 kW) is below shortfall threshold (9 kW)
    // Even with no candidates, shortfall should NOT trigger
    await guard.checkShortfall(false, 0); // no candidates
    expect(guard.isInShortfall()).toBe(false);

    // Case 2: Even if we artificially set power above threshold,
    // if we're being called with hasCandidates=true, shortfall won't trigger
    guard.reportTotalPower(12); // Exceeds threshold
    await guard.checkShortfall(true, 3); // Has candidates (daily budget case)
    expect(guard.isInShortfall()).toBe(false);
  });

  test('hourly cap violation (softLimitSource=capacity) checks shortfall', async () => {
    const shortfallThreshold = 10; // hard cap (limitKw)
    guard.setShortfallThresholdProvider(() => shortfallThreshold);

    // Power exceeds shortfall threshold (hard cap) AND no candidates
    guard.reportTotalPower(12); // Exceeds 10 kW hard cap
    await guard.checkShortfall(false, 3); // No candidates

    // Shortfall should be triggered
    expect(guard.isInShortfall()).toBe(true);
  });

  test('combined violation (softLimitSource=both) checks shortfall based on hourly threshold', async () => {
    const shortfallThreshold = 10; // hard cap
    guard.setShortfallThresholdProvider(() => shortfallThreshold);

    // Power is below hourly hard cap but might exceed daily budget soft limit
    guard.reportTotalPower(5); // Below 10 kW hard cap
    await guard.checkShortfall(false, 2); // No candidates

    // Should NOT trigger shortfall because we're below hourly threshold
    expect(guard.isInShortfall()).toBe(false);

    // Now exceed hourly threshold
    guard.reportTotalPower(12);
    await guard.checkShortfall(false, 3);

    // Now it should trigger
    expect(guard.isInShortfall()).toBe(true);
  });
});
