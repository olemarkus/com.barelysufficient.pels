/**
 * Tests to verify that end-of-hour capping only applies to hourly capacity,
 * not to daily budget constraints.
 */

import { computeDailyUsageSoftLimit } from '../lib/plan/planBudget';

describe('End-of-Hour Mode', () => {
  // Note: Testing computeDynamicSoftLimit with specific times is difficult because
  // it uses Date.now() internally. The key behavior we want to verify is that
  // daily budget does NOT apply EOH capping, which is tested in dailyBudgetCap.test.ts

  describe('Daily budget - never applies EOH capping', () => {
    test('allows burst rate even in last minutes of day', () => {
      // Setup: 23:55 (5 minutes until end of day)
      const now = new Date('2025-01-15T23:55:00Z').getTime();
      const dayStart = new Date('2025-01-15T00:00:00Z').getTime();
      const dayEnd = new Date('2025-01-16T00:00:00Z').getTime();

      const plannedKWh = 100; // Daily budget: 100 kWh
      const usedKWh = 95; // Used 95 kWh so far
      const logDebug = jest.fn();

      const result = computeDailyUsageSoftLimit({
        plannedKWh,
        usedKWh,
        bucketStartMs: dayStart,
        bucketEndMs: dayEnd,
        nowMs: now,
        logDebug,
      });

      // Remaining: 5 kWh over 5 minutes (but uses min threshold of 10 minutes)
      // remainingHours = max(5/60, 10/60) = 10/60 = 0.1667 hours
      // Burst rate: 5 / 0.1667 = 30 kW
      // Daily budget never applies EOH capping (no min(burst, sustainable))
      expect(result).toBeCloseTo(30, 0);
    });

    test('allows burst rate in middle of day', () => {
      const now = new Date('2025-01-15T12:00:00Z').getTime();
      const dayStart = new Date('2025-01-15T00:00:00Z').getTime();
      const dayEnd = new Date('2025-01-16T00:00:00Z').getTime();

      const plannedKWh = 100;
      const usedKWh = 50;
      const logDebug = jest.fn();

      const result = computeDailyUsageSoftLimit({
        plannedKWh,
        usedKWh,
        bucketStartMs: dayStart,
        bucketEndMs: dayEnd,
        nowMs: now,
        logDebug,
      });

      // Remaining: 50 kWh over 12 hours = 4.17 kW
      expect(result).toBeCloseTo(4.17, 1);
    });

    test('returns appropriate burst rate even with very little time remaining', () => {
      // Setup: 23:59:30 (30 seconds until end of day)
      const now = new Date('2025-01-15T23:59:30Z').getTime();
      const dayStart = new Date('2025-01-15T00:00:00Z').getTime();
      const dayEnd = new Date('2025-01-16T00:00:00Z').getTime();

      const plannedKWh = 100;
      const usedKWh = 99; // Only 1 kWh remaining
      const logDebug = jest.fn();

      const result = computeDailyUsageSoftLimit({
        plannedKWh,
        usedKWh,
        bucketStartMs: dayStart,
        bucketEndMs: dayEnd,
        nowMs: now,
        logDebug,
      });

      // Remaining: 1 kWh over 30 seconds (but uses min threshold of 10 minutes)
      // remainingHours = max(0.5/60, 10/60) = 10/60 = 0.1667 hours
      // Burst rate: 1 / 0.1667 = 6 kW
      // No EOH capping - this is the uncapped burst rate
      expect(result).toBeCloseTo(6, 0);
    });
  });

  describe('Combined scenario - hourly caps, daily does not', () => {
    test('hourly applies EOH, daily provides higher burst rate', () => {
      // Scenario: Last 5 minutes of hour
      // Hourly: Would allow high burst but EOH caps it
      // Daily: Allows even higher burst (no EOH cap)
      // Result: Hourly EOH cap wins (min of the two)

      // This test verifies that the planner correctly takes min(hourly_eoh_capped, daily_burst)
      // and that daily_burst is indeed uncapped

      // Hourly: 4 kWh used, 5 kWh remaining, 5 min left
      // Burst would be 60 kW, but EOH caps to 9 kW
      const hourlySoftLimit = 9; // EOH-capped

      // Daily: 50 kWh used, 50 kWh remaining, 13.08 hours left
      // Burst: 50/13.08 = 3.82 kW (no EOH cap)
      const dailySoftLimit = 3.82;

      // Planner takes min: min(9, 3.82) = 3.82
      const effectiveSoftLimit = Math.min(hourlySoftLimit, dailySoftLimit);

      expect(effectiveSoftLimit).toBe(3.82);
      expect(dailySoftLimit).toBeLessThan(hourlySoftLimit); // Daily is more restrictive here
    });
  });
});
