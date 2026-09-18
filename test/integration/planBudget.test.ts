import { getHourBucketKey } from '../../lib/utils/dateUtils';
import {
  computeDailyUsageSoftLimit,
  computeDynamicSoftLimit,
  computeShortfallThreshold,
} from '../../lib/plan/planBudget';

describe('planBudget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('computeDynamicSoftLimit', () => {
    it('returns 0 when net soft budget is non-positive', () => {
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 5, periodMinutes: 60 },
        powerTracker: {},
      });
      expect(result).toEqual({ allowedKw: 0, hourlyBudgetExhausted: false, remainingKWh: 0 });
    });

    it('allows burst rate mid-hour when under budget', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 30, 0);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 7, marginKw: 0.3, periodMinutes: 60 },
        powerTracker: { buckets: { [bucketKey]: 1.5 } },
      });

      // Soft budget = 6.7 kWh. Remaining = 5.2 kWh over 0.5h => 10.4 kW burst.
      expect(result.allowedKw).toBeCloseTo(10.4, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('paces a Belgian quarter against one quarter of the configured kW cap', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 7, 30);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        powerTracker: {
          lastTimestamp: nowMs,
          capacityQuarter: { startMs: quarterStartMs, energyKWh: 0.5, trackedMs: nowMs - quarterStartMs },
        },
      });

      // Quarter allowance = 1.25 kWh. 0.75 kWh remains over 7.5 minutes => 6 kW.
      expect(result.allowedKw).toBeCloseTo(6, 6);
      expect(result.remainingKWh).toBeCloseTo(0.75, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('carries a sparse Flow meter sample through a settings-triggered quarter rebuild', () => {
      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const lastTimestamp = quarterStartMs + 7 * 60 * 1000;
      const nowMs = quarterStartMs + 10 * 60 * 1000;
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        powerTracker: {
          lastTimestamp,
          lastPowerW: 3_000,
          capacityQuarter: {
            startMs: quarterStartMs,
            energyKWh: 0.35,
            trackedMs: lastTimestamp - quarterStartMs,
          },
        },
      });

      // The held 3 kW sample contributes another 0.15 kWh from :07 to :10.
      // 0.75 kWh remains over five minutes, so the honest pace is 9 kW.
      expect(result.allowedKw).toBeCloseTo(9, 6);
      expect(result.remainingKWh).toBeCloseTo(0.75, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('carries a sparse Flow sample across the Belgian quarter boundary', () => {
      const previousQuarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const lastTimestamp = previousQuarterStartMs + 14 * 60 * 1000;
      const nowMs = previousQuarterStartMs + 17 * 60 * 1000;
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        powerTracker: {
          lastTimestamp,
          lastPowerW: 3_000,
          capacityQuarter: {
            startMs: previousQuarterStartMs,
            energyKWh: 0.7,
            trackedMs: lastTimestamp - previousQuarterStartMs,
          },
        },
      });

      // The held 3 kW sample covers :15–:17 in the new quarter: 0.1 kWh used,
      // 1.15 kWh remains across 13 minutes, so the safe pace is about 5.31 kW.
      expect(result.allowedKw).toBeCloseTo(1.15 / (13 / 60), 6);
      expect(result.remainingKWh).toBeCloseTo(1.15, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('keeps an explicit build timestamp after the wall clock crosses a quarter boundary', () => {
      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const buildNowMs = quarterStartMs + 14 * 60 * 1000;
      vi.useFakeTimers();
      vi.setSystemTime(quarterStartMs + 15 * 60 * 1000 + 1);
      const powerTracker = {
        lastTimestamp: buildNowMs,
        lastPowerW: 0,
        capacityQuarter: {
          startMs: quarterStartMs,
          energyKWh: 0.5,
          trackedMs: buildNowMs - quarterStartMs,
        },
      };
      const capacitySettings = { limitKw: 5, marginKw: 0, periodMinutes: 15 } as const;

      const pace = computeDynamicSoftLimit({ capacitySettings, powerTracker }, buildNowMs);
      const shortfallThreshold = computeShortfallThreshold(
        { capacitySettings, powerTracker },
        buildNowMs,
      );

      expect(pace.remainingKWh).toBeCloseTo(0.75, 6);
      expect(shortfallThreshold).toBeCloseTo(45, 6);
    });

    it('marks a Belgian quarter exhausted at the quarter allowance', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 8);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        powerTracker: {
          lastTimestamp: nowMs,
          capacityQuarter: { startMs: quarterStartMs, energyKWh: 1.25, trackedMs: nowMs - quarterStartMs },
        },
      });

      expect(result.allowedKw).toBe(0);
      expect(result.hourlyBudgetExhausted).toBe(true);
    });

    it('fails closed until the first quarter is tracked from its boundary', () => {
      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const nowMs = quarterStartMs + 10 * 60 * 1000;
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        powerTracker: {
          lastTimestamp: nowMs,
          capacityQuarter: { startMs: quarterStartMs, energyKWh: 0.2, trackedMs: 5 * 60 * 1000 },
        },
      });

      expect(result).toEqual({ allowedKw: 0, hourlyBudgetExhausted: false, remainingKWh: 0 });
    });

    it('drains burst toward sustainable via the exponential ceiling near hour end', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 55, 0); // 5 minutes remaining
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        powerTracker: { buckets: { [bucketKey]: 0.5 } },
      });

      // Remaining = 4.5 kWh, remaining time clamps to 10m => burst 27 kW.
      // Drain ceiling at 5 min = 5 * e^(5/4) = 17.4517 kW; allowed = min(27, 17.4517).
      // The pace is pulled below the raw burst but stays well above the steady
      // sustainable rate (5 kW) — a smooth taper, not a cliff to sustainable.
      expect(result.allowedKw).toBeCloseTo(17.4517, 3);
      expect(result.allowedKw).toBeGreaterThan(5);
      expect(result.allowedKw).toBeLessThan(27);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('does not cliff to sustainable at the 10-minute mark (drain barely binds there)', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 50, 0); // exactly 10 minutes remaining
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        powerTracker: { buckets: { [bucketKey]: 0.5 } },
      });

      // Drain ceiling at 10 min = 5 * e^(10/4) ≈ 60.9 kW, far above the 27 kW burst,
      // so the burst rate governs. Regression guard: the legacy hard cliff would
      // have clamped this to 5 kW at exactly 10 minutes.
      expect(result.allowedKw).toBeCloseTo(27, 6);
    });

    it('crosses the hour boundary at the sustainable rate', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 59, 59, 999); // ~0 minutes remaining
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        powerTracker: { buckets: { [bucketKey]: 0.5 } }, // budget remaining, burst would be high
      });

      // At the boundary the drain ceiling collapses to the sustainable rate (5 kW),
      // so even with budget left the pace is the steady rate — the next hour starts clean.
      expect(result.allowedKw).toBeCloseTo(5, 2);
    });

    it('tapers smoothly down to the sustainable rate over the final minutes', () => {
      vi.useFakeTimers();
      const sample = (minute: number): number => {
        const nowMs = Date.UTC(2025, 0, 15, 12, minute, 0);
        vi.setSystemTime(nowMs);
        const bucketKey = getHourBucketKey(nowMs);
        return computeDynamicSoftLimit({
          capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 60 }, // sustainable = 5 kW
          powerTracker: { buckets: { [bucketKey]: 0.5 } }, // burst stays at 27 kW (floored)
        }).allowedKw;
      };

      // minutesRemaining 6,5,4,3,2,1 — same usage, so the drain ceiling governs the
      // whole tail and the pace falls strictly and continuously toward sustainable.
      const series = [54, 55, 56, 57, 58, 59].map((m) => sample(m));
      for (let i = 1; i < series.length; i += 1) {
        expect(series[i]).toBeLessThan(series[i - 1]);
      }
      expect(series[0]).toBeCloseTo(22.4084, 3); // 6 min: 5 * e^(6/4)
      expect(series[series.length - 1]).toBeCloseTo(6.4201, 3); // 1 min: 5 * e^(1/4)
      expect(series[series.length - 1]).toBeGreaterThan(5); // never below the sustainable rate
    });

    it('uses 10-minute minimum remaining time near hour end', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 59, 0);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        powerTracker: { buckets: { [bucketKey]: 4.8 } },
      });

      // Remaining = 0.2 kWh; with 10-minute minimum => 0.2 / (10/60) = 1.2 kW.
      expect(result.allowedKw).toBeCloseTo(1.2, 6);
      expect(result.hourlyBudgetExhausted).toBe(false);
    });

    it('marks hourly budget exhausted when usage exceeds soft budget', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 20, 0);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const result = computeDynamicSoftLimit({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 60 },
        powerTracker: { buckets: { [bucketKey]: 6 } },
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
        capacitySettings: { limitKw: 0, marginKw: 0.5, periodMinutes: 60 },
        powerTracker: {},
      });
      expect(threshold).toBe(0);
    });

    it('returns 0 when hard-cap budget for the hour is already exhausted', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 30, 0);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const threshold = computeShortfallThreshold({
        capacitySettings: { limitKw: 5, marginKw: 0.5, periodMinutes: 60 },
        powerTracker: { buckets: { [bucketKey]: 6 } },
      });
      expect(threshold).toBe(0);
    });

    it('uses 0.01h minimum remaining time at end of hour', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 59, 59, 999);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const bucketKey = getHourBucketKey(nowMs);
      const threshold = computeShortfallThreshold({
        capacitySettings: { limitKw: 5, marginKw: 2, periodMinutes: 60 },
        powerTracker: { buckets: { [bucketKey]: 0 } },
      });

      // remaining = 5kWh, min remaining time = 0.01h => threshold = 500kW
      expect(threshold).toBeCloseTo(500, 6);
    });

    it('uses the current quarter energy for Belgian shortfall detection', () => {
      const nowMs = Date.UTC(2025, 0, 15, 12, 10);
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);

      const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
      const threshold = computeShortfallThreshold({
        capacitySettings: { limitKw: 5, marginKw: 0, periodMinutes: 15 },
        powerTracker: {
          lastTimestamp: nowMs,
          capacityQuarter: { startMs: quarterStartMs, energyKWh: 1, trackedMs: nowMs - quarterStartMs },
        },
      });

      // 0.25 kWh remains over five minutes => 3 kW.
      expect(threshold).toBeCloseTo(3, 6);
    });
  });
});
