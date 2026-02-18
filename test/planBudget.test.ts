import { jest } from '@jest/globals';
import { getHourBucketKey } from '../lib/utils/dateUtils';
import {
  computeDailyUsageSoftLimit,
  computeDynamicSoftLimit,
  computeShortfallThreshold,
} from '../lib/plan/planBudget';

describe('planBudget', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('computeDynamicSoftLimit', () => {
    it('returns 0 when net soft budget is non-positive', () => {
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 5 },
        powerTracker: {},
        logDebug: jest.fn(),
      });
      expect(result).toEqual({ allowedKw: 0, hourlyBudgetExhausted: false });
    });

    it('allows burst rate mid-hour when under budget', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 30, 0);
      jest.useFakeTimers();
      jest.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 7, marginKw: 0.3 },
        powerTracker: { buckets: { [bucketKey]: 1.5 } },
        logDebug: jest.fn(),
      });

      // Soft budget = 6.7 kWh. Remaining = 5.2 kWh over 0.5h => 10.4 kW burst.
      expect(result.allowedKw).toBeCloseTo(10.4, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('caps to sustainable rate in last 10 minutes when burst is higher', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 55, 0);
      jest.useFakeTimers();
      jest.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0 },
        powerTracker: { buckets: { [bucketKey]: 0.5 } },
        logDebug: jest.fn(),
      });

      // Remaining = 4.5 kWh, remaining time clamps to 10m => burst 27 kW.
      // Last 10 minutes applies cap: min(27, 5) = 5 kW.
      expect(result.allowedKw).toBeCloseTo(5, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('uses 10-minute minimum remaining time near hour end', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 59, 0);
      jest.useFakeTimers();
      jest.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0 },
        powerTracker: { buckets: { [bucketKey]: 4.8 } },
        logDebug: jest.fn(),
      });

      // Remaining = 0.2 kWh; with 10-minute minimum => 0.2 / (10/60) = 1.2 kW.
      expect(result.allowedKw).toBeCloseTo(1.2, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('marks hourly budget exhausted when usage exceeds soft budget', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 20, 0);
      jest.useFakeTimers();
      jest.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0 },
        powerTracker: { buckets: { [bucketKey]: 6 } },
        logDebug: jest.fn(),
      });

      expect(result.allowedKw).toBe(0);
      expect(result.hourlyBudgetExhausted).toBe(true);
    });
  });

  describe('computeDailyUsageSoftLimit', () => {
    it('returns 0 for non-finite or non-positive planned budget', () => {
      expect(computeDailyUsageSoftLimit({
        plannedKWh: Number.NaN,
        usedKWh: 0,
        bucketStartMs: 0,
        bucketEndMs: 3600000,
      })).toBe(0);

      expect(computeDailyUsageSoftLimit({
        plannedKWh: 0,
        usedKWh: 0,
        bucketStartMs: 0,
        bucketEndMs: 3600000,
      })).toBe(0);
    });

    it('returns 0 for invalid bucket window', () => {
      expect(computeDailyUsageSoftLimit({
        plannedKWh: 4,
        usedKWh: 1,
        bucketStartMs: 1000,
        bucketEndMs: 1000,
      })).toBe(0);
    });

    it('clamps now to bucket range and treats non-finite used as 0', () => {
      const bucketStartMs = Date.UTC(2025, 0, 15, 12, 0, 0);
      const bucketEndMs = bucketStartMs + 60 * 60 * 1000;
      const nowBeforeBucket = bucketStartMs - 30 * 60 * 1000;

      const allowed = computeDailyUsageSoftLimit({
        plannedKWh: 4,
        usedKWh: Number.NaN,
        bucketStartMs,
        bucketEndMs,
        nowMs: nowBeforeBucket,
      });

      // now clamps to bucket start (1h remaining), used treated as 0 => 4 kW
      expect(allowed).toBeCloseTo(4, 6);
    });
  });

  describe('computeShortfallThreshold', () => {
    it('returns 0 when hard-cap budget is non-positive', () => {
      const threshold = computeShortfallThreshold({
        capacitySettings: { limitKw: 0, marginKw: 0.5 },
        powerTracker: {},
      });
      expect(threshold).toBe(0);
    });

    it('returns 0 when hard-cap budget for the hour is already exhausted', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 30, 0);
      jest.useFakeTimers();
      jest.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const threshold = computeShortfallThreshold({
        capacitySettings: { limitKw: 5, marginKw: 0.5 },
        powerTracker: { buckets: { [bucketKey]: 6 } },
      });
      expect(threshold).toBe(0);
    });

    it('uses 0.01h minimum remaining time at end of hour', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 59, 59, 999);
      jest.useFakeTimers();
      jest.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const threshold = computeShortfallThreshold({
        capacitySettings: { limitKw: 5, marginKw: 2 },
        powerTracker: { buckets: { [bucketKey]: 0 } },
      });

      // remaining = 5kWh, min remaining time = 0.01h => threshold = 500kW
      expect(threshold).toBeCloseTo(500, 6);
    });
  });
});
