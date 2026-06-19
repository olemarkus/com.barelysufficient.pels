/**
 * Tests to verify that the end-of-hour drain only applies to hourly capacity,
 * not to daily budget constraints.
 */

import { computeDailyUsageSoftLimit } from '../../lib/plan/planBudget';

describe('End-of-Hour Mode', () => {
  // Note: Testing computeDynamicSoftLimit with specific times is difficult because
  // it uses Date.now() internally. The key behavior we want to verify here is that
  // daily budget does NOT apply the end-of-hour drain (the hourly drain itself is
  // covered in planBudget.test.ts).

  describe('Daily budget - never applies the end-of-hour drain', () => {
    test('allows burst rate even in last minutes of day', () => {
      // Setup: 23:55 (5 minutes until end of day)
      const now = new Date('2025-01-15T23:55:00Z').getTime();
      const dayStart = new Date('2025-01-15T00:00:00Z').getTime();
      const dayEnd = new Date('2025-01-16T00:00:00Z').getTime();

      const plannedKWh = 100; // Daily budget: 100 kWh
      const usedKWh = 95; // Used 95 kWh so far
      const result = computeDailyUsageSoftLimit({
        plannedKWh,
        usedKWh,
        bucketStartMs: dayStart,
        bucketEndMs: dayEnd,
        nowMs: now,
      });

      // Remaining: 5 kWh over 5 minutes (but uses min threshold of 10 minutes)
      // remainingHours = max(5/60, 10/60) = 10/60 = 0.1667 hours
      // Burst rate: 5 / 0.1667 = 30 kW
      // Daily budget never applies the end-of-hour drain (no exponential ceiling)
      expect(result).toBeCloseTo(30, 0);
    });

    test('allows burst rate in middle of day', () => {
      const now = new Date('2025-01-15T12:00:00Z').getTime();
      const dayStart = new Date('2025-01-15T00:00:00Z').getTime();
      const dayEnd = new Date('2025-01-16T00:00:00Z').getTime();

      const plannedKWh = 100;
      const usedKWh = 50;
      const result = computeDailyUsageSoftLimit({
        plannedKWh,
        usedKWh,
        bucketStartMs: dayStart,
        bucketEndMs: dayEnd,
        nowMs: now,
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
      const result = computeDailyUsageSoftLimit({
        plannedKWh,
        usedKWh,
        bucketStartMs: dayStart,
        bucketEndMs: dayEnd,
        nowMs: now,
      });

      // Remaining: 1 kWh over 30 seconds (but uses min threshold of 10 minutes)
      // remainingHours = max(0.5/60, 10/60) = 10/60 = 0.1667 hours
      // Burst rate: 1 / 0.1667 = 6 kW
      // No end-of-hour drain - this is the uncapped burst rate
      expect(result).toBeCloseTo(6, 0);
    });
  });
});
