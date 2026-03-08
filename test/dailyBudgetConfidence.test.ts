import {
  computeBacktestedConfidence,
  createConfidenceCache,
  getCachedConfidence,
  resolveConfidence,
  sampleDayIndex,
} from '../lib/dailyBudget/dailyBudgetConfidence';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import {
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  buildLocalDayBuckets,
} from '../lib/utils/dateUtils';

const TZ = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;

function buildPowerTracker(overrides?: Partial<PowerTrackerState>): PowerTrackerState {
  return {
    buckets: {},
    controlledBuckets: {},
    dailyBudgetCaps: {},
    unreliablePeriods: [],
    ...overrides,
  };
}

/**
 * Populate buckets for a given date with a flat hourly usage shape.
 * Returns the ISO keys for the hours.
 */
function addDayUsage(params: {
  buckets: Record<string, number>;
  dateKey: string;
  hourlyKWh: number[];
  controlledBuckets?: Record<string, number>;
  dailyBudgetCaps?: Record<string, number>;
  hourlyControlledKWh?: number[];
  hourlyPlannedKWh?: number[];
}): void {
  const {
    buckets,
    dateKey,
    hourlyKWh,
    controlledBuckets,
    dailyBudgetCaps,
    hourlyControlledKWh,
    hourlyPlannedKWh,
  } = params;
  const dayStartUtcMs = getDateKeyStartMs(dateKey, TZ);
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, TZ);
  const { bucketStartUtcMs } = buildLocalDayBuckets({ dayStartUtcMs, nextDayStartUtcMs, timeZone: TZ });

  for (const [index, ts] of bucketStartUtcMs.entries()) {
    const key = new Date(ts).toISOString();
    buckets[key] = hourlyKWh[index] ?? 0;
    if (controlledBuckets && hourlyControlledKWh) {
      controlledBuckets[key] = hourlyControlledKWh[index] ?? 0;
    }
    if (dailyBudgetCaps && hourlyPlannedKWh) {
      dailyBudgetCaps[key] = hourlyPlannedKWh[index] ?? 0;
    }
  }
}

function buildDateKey(daysAgo: number, baseDate: Date = new Date('2025-03-15T12:00:00Z')): string {
  const d = new Date(baseDate.getTime() - daysAgo * 24 * HOUR_MS);
  return d.toISOString().slice(0, 10);
}

const NOW_MS = new Date('2025-03-15T12:00:00Z').getTime();

describe('computeBacktestedConfidence', () => {
  it('returns confidence 0 when no valid days exist', () => {
    const pt = buildPowerTracker();
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 0.5,
    });
    expect(result.confidence).toBe(0);
    expect(result.debug.confidenceValidActualDays).toBe(0);
    expect(result.debug.profileBlendConfidence).toBe(0.5);
  });

  it('returns high confidence (~1.0) for 14 identical daily shapes', () => {
    const buckets: Record<string, number> = {};
    const flatHourly = Array.from({ length: 24 }, () => 1);
    for (let i = 1; i <= 14; i++) {
      addDayUsage({ buckets, dateKey: buildDateKey(i), hourlyKWh: flatHourly });
    }
    const pt = buildPowerTracker({ buckets });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.95);
    expect(result.debug.confidenceRegularity).toBeGreaterThanOrEqual(0.95);
    expect(result.debug.confidenceValidActualDays).toBe(14);
  });

  it('returns low regularity for highly variable shapes', () => {
    const buckets: Record<string, number> = {};
    for (let i = 1; i <= 14; i++) {
      const hourlyKWh = Array.from({ length: 24 }, () => 0);
      // Concentrate all usage in a single, different hour each day
      hourlyKWh[i % 24] = 10;
      addDayUsage({ buckets, dateKey: buildDateKey(i), hourlyKWh });
    }
    const pt = buildPowerTracker({ buckets });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });
    expect(result.debug.confidenceRegularity).toBeLessThan(0.5);
  });

  it('returns high adaptability with good plan following and high controlled share', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    // Shape that shifts between two patterns: all in morning vs all in evening
    for (let i = 1; i <= 14; i++) {
      const planned = Array.from({ length: 24 }, () => 0);
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);

      if (i % 2 === 0) {
        planned[8] = 5; planned[9] = 5;
        actual[8] = 5; actual[9] = 5;
        controlled[8] = 4; controlled[9] = 4;
      } else {
        planned[18] = 5; planned[19] = 5;
        actual[18] = 5; actual[19] = 5;
        controlled[18] = 4; controlled[19] = 4;
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets,
        dailyBudgetCaps,
        hourlyControlledKWh: controlled,
        hourlyPlannedKWh: planned,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });
    expect(result.debug.confidenceAdaptability).toBeGreaterThan(0.7);
    expect(result.debug.confidenceAdaptabilityInfluence).toBeGreaterThan(0.3);
    expect(result.debug.confidenceValidPlannedDays).toBe(14);
  });

  it('returns modest improvement with good plan following but low controlled share', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    for (let i = 1; i <= 14; i++) {
      const planned = Array.from({ length: 24 }, () => 0);
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);

      if (i % 2 === 0) {
        planned[8] = 5; planned[9] = 5;
        actual[8] = 5; actual[9] = 5;
        controlled[8] = 0.5; controlled[9] = 0.5; // low controlled share
      } else {
        planned[18] = 5; planned[19] = 5;
        actual[18] = 5; actual[19] = 5;
        controlled[18] = 0.5; controlled[19] = 0.5;
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets,
        dailyBudgetCaps,
        hourlyControlledKWh: controlled,
        hourlyPlannedKWh: planned,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });
    // Adaptability influence should be small due to low controlled share
    expect(result.debug.confidenceAdaptabilityInfluence).toBeLessThan(0.2);
  });

  it('falls back to regularity-only when no dailyBudgetCaps exist', () => {
    const buckets: Record<string, number> = {};
    const flatHourly = Array.from({ length: 24 }, () => 1);
    for (let i = 1; i <= 14; i++) {
      addDayUsage({ buckets, dateKey: buildDateKey(i), hourlyKWh: flatHourly });
    }
    const pt = buildPowerTracker({ buckets });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });
    expect(result.debug.confidenceValidPlannedDays).toBe(0);
    expect(result.debug.confidenceAdaptability).toBe(0);
    expect(result.debug.confidenceAdaptabilityInfluence).toBe(0);
    // Should still have good regularity score
    expect(result.debug.confidenceRegularity).toBeGreaterThan(0.9);
  });

  it('ignores orphan controlled buckets and clamps controlled share to total usage', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    for (let i = 1; i <= 14; i++) {
      const dateKey = buildDateKey(i);
      const dayStartUtcMs = getDateKeyStartMs(dateKey, TZ);
      const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, TZ);
      const { bucketStartUtcMs } = buildLocalDayBuckets({
        dayStartUtcMs, nextDayStartUtcMs, timeZone: TZ,
      });

      const activeHour = i % 2 === 0 ? 6 : 18;
      const activeKey = new Date(bucketStartUtcMs[activeHour]!).toISOString();
      const orphanKey = new Date(bucketStartUtcMs[12]!).toISOString();

      for (const ts of bucketStartUtcMs) {
        dailyBudgetCaps[new Date(ts).toISOString()] = 0;
      }
      buckets[activeKey] = 1;
      controlledBuckets[activeKey] = 0.5;
      controlledBuckets[orphanKey] = 8;
      dailyBudgetCaps[activeKey] = 1;
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: pt, profileBlendConfidence: 1,
    });

    expect(result.debug.confidenceWeightedControlledShare).toBeCloseTo(0.5, 6);
    expect(result.debug.confidenceAdaptabilityInfluence).toBeCloseTo(0.6, 6);
  });

  it('excludes days with unreliable overlap', () => {
    const buckets: Record<string, number> = {};
    const flatHourly = Array.from({ length: 24 }, () => 1);
    // Populate 10 days
    for (let i = 1; i <= 10; i++) {
      addDayUsage({ buckets, dateKey: buildDateKey(i), hourlyKWh: flatHourly });
    }

    // First verify all 10 days are valid without unreliable periods
    const ptClean = buildPowerTracker({ buckets });
    const clean = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: ptClean, profileBlendConfidence: 0.5,
    });
    const totalDays = clean.debug.confidenceValidActualDays;

    // Now mark a wide unreliable window across multiple days (8 days ago through 3 days ago)
    const periodStart = getDateKeyStartMs(buildDateKey(8), TZ);
    const periodEnd = getNextLocalDayStartUtcMs(getDateKeyStartMs(buildDateKey(3), TZ), TZ);
    const pt = buildPowerTracker({
      buckets,
      unreliablePeriods: [{ start: periodStart, end: periodEnd }],
    });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: pt, profileBlendConfidence: 0.5,
    });
    // Should have fewer days than the clean run
    expect(result.debug.confidenceValidActualDays).toBeLessThan(totalDays);
    expect(result.debug.confidenceValidActualDays).toBeGreaterThan(0);
  });

  it('produces valid 24-element profiles for DST 23/25-hour days', () => {
    // Use a timezone with DST and test dates around DST transition
    // CET -> CEST happens last Sunday of March
    const buckets: Record<string, number> = {};
    const dstNow = new Date('2025-03-31T12:00:00Z').getTime();

    // Add days around DST transition (March 30 is DST change in Europe/Oslo)
    for (let i = 1; i <= 5; i++) {
      const d = new Date(dstNow - i * 24 * HOUR_MS);
      const dateKey = d.toISOString().slice(0, 10);
      const dayStart = getDateKeyStartMs(dateKey, TZ);
      const nextDay = getNextLocalDayStartUtcMs(dayStart, TZ);
      const { bucketStartUtcMs } = buildLocalDayBuckets({
        dayStartUtcMs: dayStart,
        nextDayStartUtcMs: nextDay,
        timeZone: TZ,
      });
      for (const ts of bucketStartUtcMs) {
        buckets[new Date(ts).toISOString()] = 1;
      }
    }

    const pt = buildPowerTracker({ buckets });
    const result = computeBacktestedConfidence({
      nowMs: dstNow,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 0.5,
    });
    // Should not crash and should have valid days
    expect(result.debug.confidenceValidActualDays).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('bootstrap returns finite [0,1] values', () => {
    const buckets: Record<string, number> = {};
    for (let i = 1; i <= 10; i++) {
      const hourlyKWh = Array.from({ length: 24 }, (_, h) => (h === i % 24 ? 5 : 1));
      addDayUsage({ buckets, dateKey: buildDateKey(i), hourlyKWh });
    }
    const pt = buildPowerTracker({ buckets });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 0.5,
    });
    expect(Number.isFinite(result.debug.confidenceBootstrapLow)).toBe(true);
    expect(Number.isFinite(result.debug.confidenceBootstrapHigh)).toBe(true);
    expect(result.debug.confidenceBootstrapLow).toBeGreaterThanOrEqual(0);
    expect(result.debug.confidenceBootstrapLow).toBeLessThanOrEqual(1);
    expect(result.debug.confidenceBootstrapHigh).toBeGreaterThanOrEqual(0);
    expect(result.debug.confidenceBootstrapHigh).toBeLessThanOrEqual(1);
    expect(result.debug.confidenceBootstrapLow).toBeLessThanOrEqual(result.debug.confidenceBootstrapHigh);
  });

  it('clamps sampled bootstrap indices when random input reaches 1', () => {
    expect(sampleDayIndex(0, 7)).toBe(0);
    expect(sampleDayIndex(0.999999, 7)).toBe(6);
    expect(sampleDayIndex(1, 7)).toBe(6);
  });

  it('excludes partial-plan days from adaptability scoring', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    // Build 14 days with flat usage and high controlled share
    const flatActual = Array.from({ length: 24 }, () => 1);
    const flatControlled = Array.from({ length: 24 }, () => 0.8);
    const fullPlan = Array.from({ length: 24 }, () => 1);

    for (let i = 1; i <= 14; i++) {
      const dateKey = buildDateKey(i);
      const dayStartUtcMs = getDateKeyStartMs(dateKey, TZ);
      const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, TZ);
      const { bucketStartUtcMs } = buildLocalDayBuckets({
        dayStartUtcMs, nextDayStartUtcMs, timeZone: TZ,
      });

      for (const [index, ts] of bucketStartUtcMs.entries()) {
        const key = new Date(ts).toISOString();
        buckets[key] = flatActual[index] ?? 1;
        controlledBuckets[key] = flatControlled[index] ?? 0.8;

        if (i <= 7) {
          // First 7 days: full plan (all 24 hours have caps)
          dailyBudgetCaps[key] = fullPlan[index] ?? 1;
        } else if (index < 3) {
          // Last 7 days: only 3 out of 24 hours have plan caps (partial)
          dailyBudgetCaps[key] = 1;
        }
        // else: no cap entry — partial plan day
      }
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });

    // Partial-plan days (only 3/24 hours) should NOT count as planned days.
    // Only the 7 fully-planned days should be counted.
    expect(result.debug.confidenceValidPlannedDays).toBeLessThanOrEqual(7);
  });

  it('weights adaptability influence by shift-demand, not simple average', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    // Build two groups of days:
    // Group A (7 days): high controlled share (0.9), plan shifts strongly from centroid
    // Group B (7 days): low controlled share (0.1), plan is near centroid (low shift demand)
    // Both groups follow their plans perfectly.
    //
    // Without proper weighting, influence = mean(0.9, 0.1) = 0.5.
    // With proper weighting (by controlledShare * shiftDemand), the high-controlled,
    // high-shift-demand days should dominate, pushing influence well above 0.5.
    for (let i = 1; i <= 14; i++) {
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);
      const planned = Array.from({ length: 24 }, () => 0);

      if (i <= 7) {
        // Group A: high controlled, shifted plan (all usage at hour 6)
        actual[6] = 10;
        controlled[6] = 9; // controlledShare = 0.9
        planned[6] = 10;
      } else {
        // Group B: low controlled, centroid-like plan (flat usage)
        for (let h = 0; h < 24; h++) {
          actual[h] = 1;
          controlled[h] = 0.1; // controlledShare ≈ 0.1
          planned[h] = 1;
        }
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets,
        dailyBudgetCaps,
        hourlyControlledKWh: controlled,
        hourlyPlannedKWh: planned,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });

    // The high-shift, high-controlled group should dominate the day-weight (controlledShare * shiftDemand).
    // With proper weighting, influence should be above 0.3 (adaptabilityInfluence = clamp(wcs * 1.2, 0, 0.85)).
    // weightedControlledShare is now weighted by shiftDemand only per plan.
    expect(result.debug.confidenceAdaptabilityInfluence).toBeGreaterThan(0.3);
    expect(result.debug.confidenceWeightedControlledShare).toBeGreaterThan(0.3);
  });

  it('lets zero-controlled planned days lower adaptability influence without adding adaptability evidence', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    // Build days where some have controlledShare=0 (weight=0), others have controlledShare=0.8.
    // The zero-controlled days should lower the controlled-share influence, but should not count
    // as positive adaptability evidence for the score ramp.
    for (let i = 1; i <= 14; i++) {
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);
      const planned = Array.from({ length: 24 }, () => 0);

      if (i <= 7) {
        // Days with controlled load, plan shifted to morning
        actual[6] = 10;
        controlled[6] = 8;
        planned[6] = 10;
      } else {
        // Days with zero controlled load, plan shifted to evening
        actual[18] = 10;
        // controlled stays 0
        planned[18] = 10;
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets,
        dailyBudgetCaps,
        hourlyControlledKWh: controlled,
        hourlyPlannedKWh: planned,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });

    // Only 7 out of 14 planned days have positive score weight, so the ramp should see 7 days.
    // But weightedControlledShare should still include the zero-controlled days and land near 0.4,
    // which keeps adaptability influence well below the high-controlled-only case.
    expect(result.debug.confidenceValidPlannedDays).toBe(7);
    expect(result.debug.confidenceWeightedControlledShare).toBeCloseTo(0.4, 6);
    expect(result.debug.confidenceAdaptabilityInfluence).toBeCloseTo(0.48, 6);
  });

  it('does not count zero-controlled planned days toward adaptability evidence', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    for (let i = 1; i <= 14; i++) {
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);
      const planned = Array.from({ length: 24 }, () => 0);

      actual[6] = 10;
      planned[6] = 10;
      if (i === 1) {
        controlled[6] = 9;
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets,
        dailyBudgetCaps,
        hourlyControlledKWh: controlled,
        hourlyPlannedKWh: planned,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });

    expect(result.debug.confidenceValidPlannedDays).toBe(1);
    expect(result.debug.confidenceAdaptability).toBeLessThan(0.2);
    expect(result.debug.confidenceAdaptabilityInfluence).toBeLessThan(0.2);
  });

  it('bootstrap interval reflects combined confidence, not just regularity', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    // Build days where regularity is high (identical shapes) but adaptability varies.
    // If bootstrap only uses regularity scores, the interval will be very tight.
    // If it uses combined scores, the adaptability variation should widen it.
    for (let i = 1; i <= 14; i++) {
      const actual = Array.from({ length: 24 }, () => 1); // flat usage → high regularity
      const controlled = Array.from({ length: 24 }, () => 0.8);
      const planned = Array.from({ length: 24 }, () => 0);

      // Alternating shifted plans that don't match the flat actual profile
      if (i % 2 === 0) {
        planned[6] = 10; // morning plan
      } else {
        planned[18] = 10; // evening plan
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets,
        dailyBudgetCaps,
        hourlyControlledKWh: controlled,
        hourlyPlannedKWh: planned,
      });
    }

    // Run with plan data to get combined bootstrap
    const ptWithPlans = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const withPlans = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: ptWithPlans, profileBlendConfidence: 1,
    });

    // Run without plan data to get regularity-only bootstrap
    const ptNoPlan = buildPowerTracker({ buckets });
    const noPlan = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: ptNoPlan, profileBlendConfidence: 1,
    });

    // With adaptability influence pulling the combined score down (bad plan fit),
    // the bootstrap interval should differ from the regularity-only case.
    // Specifically the low bound should be lower when adaptability is factored in.
    const hasInfluence = withPlans.debug.confidenceAdaptabilityInfluence > 0;
    if (hasInfluence) {
      expect(withPlans.debug.confidenceBootstrapLow).not.toBeCloseTo(
        noPlan.debug.confidenceBootstrapLow, 2,
      );
    }
  });

  it('applies shiftDemand floor of max(0.20, L1/2) so near-centroid plans still contribute', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    // All days: flat usage, high controlled share, plan very close to centroid (flat).
    // Raw L1(planned, centroid) ≈ 0 → raw shiftDemand ≈ 0 → weight ≈ 0 → no adaptability.
    // With floor max(0.20, L1/2), shiftDemand = 0.20 → weight > 0 → adaptability kicks in.
    const flatActual = Array.from({ length: 24 }, () => 1);
    const flatControlled = Array.from({ length: 24 }, () => 0.9);
    const flatPlan = Array.from({ length: 24 }, () => 1);

    for (let i = 1; i <= 14; i++) {
      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: flatActual,
        controlledBuckets,
        dailyBudgetCaps,
        hourlyControlledKWh: flatControlled,
        hourlyPlannedKWh: flatPlan,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: pt, profileBlendConfidence: 1,
    });

    // With the floor, near-centroid plans should still produce positive adaptability influence.
    expect(result.debug.confidenceAdaptabilityInfluence).toBeGreaterThan(0);
    expect(result.debug.confidenceAdaptability).toBeGreaterThan(0);
  });

  it('applies sample-count ramp to adaptabilityScore (few planned days → lower score)', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    // 14 days of usage but only 3 have plan data.
    // With the ramp, adaptabilityScore *= clamp(3/14, 0, 1) ≈ 0.214.
    // Without the ramp, adaptabilityScore would be the raw weighted mean (~high).
    for (let i = 1; i <= 14; i++) {
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);
      const planned = Array.from({ length: 24 }, () => 0);

      // Shifted plan away from centroid so shiftDemand is high
      if (i <= 3) {
        actual[6] = 10;
        controlled[6] = 9;
        planned[6] = 10;
      } else {
        actual[18] = 10;
        // No controlled or plan data for remaining days
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets: i <= 3 ? controlledBuckets : undefined,
        dailyBudgetCaps: i <= 3 ? dailyBudgetCaps : undefined,
        hourlyControlledKWh: i <= 3 ? controlled : undefined,
        hourlyPlannedKWh: i <= 3 ? planned : undefined,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: pt, profileBlendConfidence: 1,
    });

    // With only 3 planned days out of 14, the ramp = 3/14 ≈ 0.214.
    // adaptabilityScore should be significantly penalized (< 0.5 even with perfect plan-fit).
    expect(result.debug.confidenceValidPlannedDays).toBe(3);
    expect(result.debug.confidenceAdaptability).toBeLessThan(0.5);
  });

  it('bootstraps the ramped final confidence on sparse planned-day history', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    for (let i = 1; i <= 14; i++) {
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);
      const planned = Array.from({ length: 24 }, () => 0);

      if (i <= 3) {
        actual[6] = 10;
        controlled[6] = 9;
        planned[6] = 10;
      } else {
        actual[18] = 10;
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets: i <= 3 ? controlledBuckets : undefined,
        dailyBudgetCaps: i <= 3 ? dailyBudgetCaps : undefined,
        hourlyControlledKWh: i <= 3 ? controlled : undefined,
        hourlyPlannedKWh: i <= 3 ? planned : undefined,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: pt, profileBlendConfidence: 1,
    });

    const bootstrapMid = (result.debug.confidenceBootstrapLow + result.debug.confidenceBootstrapHigh) / 2;
    expect(result.debug.confidenceBootstrapLow).toBeLessThanOrEqual(result.confidence);
    expect(result.debug.confidenceBootstrapHigh).toBeGreaterThanOrEqual(result.confidence);
    expect(bootstrapMid).toBeLessThan(0.4);
    expect(Math.abs(bootstrapMid - result.confidence)).toBeLessThan(0.15);
  });

  it('recomputes full bootstrap debug after a startup-style cached confidence update', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    for (let i = 1; i <= 14; i++) {
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);
      const planned = Array.from({ length: 24 }, () => 0);

      if (i <= 3) {
        actual[6] = 10;
        controlled[6] = 9;
        planned[6] = 10;
      } else {
        actual[18] = 10;
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets: i <= 3 ? controlledBuckets : undefined,
        dailyBudgetCaps: i <= 3 ? dailyBudgetCaps : undefined,
        hourlyControlledKWh: i <= 3 ? controlled : undefined,
        hourlyPlannedKWh: i <= 3 ? planned : undefined,
      });
    }

    const cache = createConfidenceCache();
    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const startupResult = resolveConfidence({
      cache,
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
      dateKey: buildDateKey(0),
      includeBootstrapDebug: false,
    });
    expect(startupResult.debug.confidenceBootstrapLow).toBeCloseTo(startupResult.confidence, 10);
    expect(startupResult.debug.confidenceBootstrapHigh).toBeCloseTo(startupResult.confidence, 10);

    const fullResult = resolveConfidence({
      cache,
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
      dateKey: buildDateKey(0),
      includeBootstrapDebug: true,
    });
    expect(fullResult.confidence).toBeCloseTo(startupResult.confidence, 10);
    expect(fullResult.debug.confidenceBootstrapLow).toBeLessThan(fullResult.debug.confidenceBootstrapHigh);
    expect(fullResult.debug.confidenceBootstrapLow).toBeLessThanOrEqual(fullResult.confidence);
    expect(fullResult.debug.confidenceBootstrapHigh).toBeGreaterThanOrEqual(fullResult.confidence);
  });

  it('recomputes cached confidence when the power-tracker history changes', () => {
    const buckets: Record<string, number> = {};
    const flatHourly = Array.from({ length: 24 }, () => 1);
    for (let i = 1; i <= 10; i++) {
      addDayUsage({ buckets, dateKey: buildDateKey(i), hourlyKWh: flatHourly });
    }

    const cache = createConfidenceCache();
    const first = resolveConfidence({
      cache,
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: buildPowerTracker({ buckets }),
      profileBlendConfidence: 1,
      dateKey: buildDateKey(0),
    });
    const second = resolveConfidence({
      cache,
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: buildPowerTracker({ buckets, unreliablePeriods: [{ start: 0, end: NOW_MS }] }),
      profileBlendConfidence: 1,
      dateKey: buildDateKey(0),
    });

    expect(second).not.toBe(first);
    expect(second.debug.confidenceValidActualDays).toBe(0);
  });

  it('recomputes cached confidence when the timezone changes', () => {
    const buckets: Record<string, number> = {};
    for (let i = 1; i <= 10; i++) {
      addDayUsage({ buckets, dateKey: buildDateKey(i), hourlyKWh: Array.from({ length: 24 }, (_, h) => (h === 23 ? 3 : 1)) });
    }

    const cache = createConfidenceCache();
    const first = resolveConfidence({
      cache,
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: buildPowerTracker({ buckets }),
      profileBlendConfidence: 0.25,
      dateKey: buildDateKey(0),
    });
    const second = resolveConfidence({
      cache,
      nowMs: NOW_MS,
      timeZone: 'UTC',
      powerTracker: buildPowerTracker({ buckets }),
      profileBlendConfidence: 0.25,
      dateKey: buildDateKey(0),
    });

    expect(second).not.toBe(first);
  });

  it('reuses cached confidence while updating profile blend debug metadata', () => {
    const buckets: Record<string, number> = {};
    for (let i = 1; i <= 10; i++) {
      addDayUsage({ buckets, dateKey: buildDateKey(i), hourlyKWh: Array.from({ length: 24 }, (_, h) => (h === 23 ? 3 : 1)) });
    }

    const cache = createConfidenceCache();
    const first = resolveConfidence({
      cache,
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: buildPowerTracker({ buckets }),
      profileBlendConfidence: 0.25,
      dateKey: buildDateKey(0),
      includeBootstrapDebug: true,
    });
    const lastMs = cache.lastMs;
    const second = resolveConfidence({
      cache,
      nowMs: NOW_MS + 1000,
      timeZone: TZ,
      powerTracker: buildPowerTracker({ buckets }),
      profileBlendConfidence: 0.75,
      dateKey: buildDateKey(0),
      includeBootstrapDebug: true,
    });

    expect(cache.lastMs).toBe(lastMs);
    expect(second.confidence).toBeCloseTo(first.confidence, 10);
    expect(second.debug.confidenceBootstrapLow).toBeCloseTo(first.debug.confidenceBootstrapLow, 10);
    expect(second.debug.confidenceBootstrapHigh).toBeCloseTo(first.debug.confidenceBootstrapHigh, 10);
    expect(second.debug.profileBlendConfidence).toBe(0.75);
  });

  it('returns an empty cached confidence result when no confidence has been computed yet', () => {
    const cache = createConfidenceCache();
    const result = getCachedConfidence({
      cache,
      profileBlendConfidence: 0.6,
    });

    expect(result.confidence).toBe(0);
    expect(result.debug.profileBlendConfidence).toBe(0.6);
    expect(result.debug.confidenceBootstrapLow).toBe(0);
    expect(result.debug.confidenceBootstrapHigh).toBe(0);
  });

  it('requires near-full plan coverage to count as a planned day', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    const flatActual = Array.from({ length: 24 }, () => 1);
    const flatControlled = Array.from({ length: 24 }, () => 0.8);

    for (let i = 1; i <= 14; i++) {
      const dateKey = buildDateKey(i);
      const dayStartUtcMs = getDateKeyStartMs(dateKey, TZ);
      const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, TZ);
      const { bucketStartUtcMs } = buildLocalDayBuckets({
        dayStartUtcMs, nextDayStartUtcMs, timeZone: TZ,
      });

      for (const [index, ts] of bucketStartUtcMs.entries()) {
        const key = new Date(ts).toISOString();
        buckets[key] = flatActual[index] ?? 1;
        controlledBuckets[key] = flatControlled[index] ?? 0.8;

        // Give 60% of hours plan data — above 50% but below "near-full"
        if (index < Math.floor(bucketStartUtcMs.length * 0.6)) {
          dailyBudgetCaps[key] = 1;
        }
      }
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: pt, profileBlendConfidence: 1,
    });

    // 60% coverage should NOT count as a planned day — threshold should be ~90%.
    expect(result.debug.confidenceValidPlannedDays).toBe(0);
  });

  it('caps adaptabilityInfluence at 0.85 using formula clamp(wcs * 1.2, 0, 0.85)', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    // All days: very high controlled share (0.95), shifted plans.
    // weightedControlledShare ≈ 0.95 → plan formula: clamp(0.95 * 1.2, 0, 0.85) = 0.85.
    // Previously: clamp(0.95, 0, 1) = 0.95 — exceeded the intended 0.85 cap.
    for (let i = 1; i <= 14; i++) {
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);
      const planned = Array.from({ length: 24 }, () => 0);

      if (i % 2 === 0) {
        actual[6] = 10;
        controlled[6] = 9.5;
        planned[6] = 10;
      } else {
        actual[18] = 10;
        controlled[18] = 9.5;
        planned[18] = 10;
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets,
        dailyBudgetCaps,
        hourlyControlledKWh: controlled,
        hourlyPlannedKWh: planned,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: pt, profileBlendConfidence: 1,
    });

    // Influence must be capped at 0.85, not exceed it
    expect(result.debug.confidenceAdaptabilityInfluence).toBeLessThanOrEqual(0.85);
    // But it should still be significant
    expect(result.debug.confidenceAdaptabilityInfluence).toBeGreaterThan(0.5);
  });

  it('computes weightedControlledShare weighted by shiftDemand only, not controlledShare*shiftDemand', () => {
    const buckets: Record<string, number> = {};
    const controlledBuckets: Record<string, number> = {};
    const dailyBudgetCaps: Record<string, number> = {};

    // Two groups with same shiftDemand but different controlledShare.
    // Group A: controlledShare = 0.9 (7 days), shifted to hour 6
    // Group B: controlledShare = 0.1 (7 days), shifted to hour 18
    // Both have equal shiftDemand from the centroid.
    //
    // Plan says: weightedControlledShare = weightedMean(controlledShare, weights=shiftDemand)
    // If shiftDemand is equal for both groups: wcs = mean(0.9, 0.1) = 0.5
    //
    // Bug: weights = controlledShare * shiftDemand, so group A gets 9x the weight.
    // wcs = (0.9 * 0.9*sd + 0.1 * 0.1*sd) / (0.9*sd + 0.1*sd) = (0.81 + 0.01) / 1.0 = 0.82
    for (let i = 1; i <= 14; i++) {
      const actual = Array.from({ length: 24 }, () => 0);
      const controlled = Array.from({ length: 24 }, () => 0);
      const planned = Array.from({ length: 24 }, () => 0);

      if (i <= 7) {
        actual[6] = 10;
        controlled[6] = 9; // controlledShare = 0.9
        planned[6] = 10;
      } else {
        actual[18] = 10;
        controlled[18] = 1; // controlledShare = 0.1
        planned[18] = 10;
      }

      addDayUsage({
        buckets,
        dateKey: buildDateKey(i),
        hourlyKWh: actual,
        controlledBuckets,
        dailyBudgetCaps,
        hourlyControlledKWh: controlled,
        hourlyPlannedKWh: planned,
      });
    }

    const pt = buildPowerTracker({ buckets, controlledBuckets, dailyBudgetCaps });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS, timeZone: TZ, powerTracker: pt, profileBlendConfidence: 1,
    });

    // With equal shiftDemand, wcs should be close to mean(0.9, 0.1) = 0.5
    // Allow some tolerance for the shiftDemand not being perfectly equal
    expect(result.debug.confidenceWeightedControlledShare).toBeLessThan(0.7);
    expect(result.debug.confidenceWeightedControlledShare).toBeGreaterThan(0.3);
  });

  it('combined score matches expected weighted blend for known inputs', () => {
    // Build a scenario where we can predict the output
    // With no plan data, adaptability influence = 0, so confidence = regularity
    const buckets: Record<string, number> = {};
    const flatHourly = Array.from({ length: 24 }, () => 1);
    for (let i = 1; i <= 14; i++) {
      addDayUsage({ buckets, dateKey: buildDateKey(i), hourlyKWh: flatHourly });
    }
    const pt = buildPowerTracker({ buckets });
    const result = computeBacktestedConfidence({
      nowMs: NOW_MS,
      timeZone: TZ,
      powerTracker: pt,
      profileBlendConfidence: 1,
    });
    // With no adaptability influence, confidence should equal regularity
    expect(result.debug.confidenceAdaptabilityInfluence).toBe(0);
    expect(result.confidence).toBeCloseTo(result.debug.confidenceRegularity, 10);
  });
});
