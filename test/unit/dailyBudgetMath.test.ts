import {
  allocateBudgetWithCaps,
  allocateBudgetWithCapsAndFloors,
  allocateBudgetWithPriceTargets,
  buildAllowedCumKWh,
  buildDefaultProfile,
  buildPlan,
  buildWeightsFromPlan,
  getProfileBlendConfidence,
  normalizeWeights,
  resolveCurrentBucketIndex,
} from '../../lib/dailyBudget/dailyBudgetMath';
import {
  buildPriceData,
  buildPriceFactors as buildPriceFactorsFromPrices,
  buildPriceSeriesPair,
  type CombinedPriceData,
} from '../../lib/dailyBudget/dailyBudgetPrices';
import { buildPlanBreakdown } from '../../lib/dailyBudget/dailyBudgetBreakdown';
import { PRICE_SHAPING_FLEX_SHARE } from '../../lib/dailyBudget/dailyBudgetConstants';
import type { DayContext } from '../../lib/dailyBudget/dailyBudgetState';
import type { ObservedHourlyStats } from '../../lib/dailyBudget/observedHourlyStats';
import type { PowerLimitCeiling } from '../../packages/contracts/src/capacitySettings';
import { observedHourlyStatsFixture } from '../helpers/observedHourlyStatsFixture';

// A plan spec states its day flat, the way these specs read; `planDay` lays it
// out as the day context, settings, profile, stored plan and prices `buildPlan` takes.
type PlanSpec = {
  bucketStartUtcMs: number[];
  bucketUsage: number[];
  currentBucketIndex: number;
  usedNowKWh: number;
  dailyBudgetKWh: number;
  profileWeights: number[];
  profileWeightsControlled?: number[];
  profileWeightsUncontrolled?: number[];
  timeZone: string;
  combinedPrices: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
  priceShapingFlexShare?: number;
  controlledUsageWeight?: number;
  previousPlannedKWh?: number[];
  previousPlannedUncontrolledKWh?: number[];
  previousPlannedGrossUncontrolledKWh?: number[];
  previousPlannedControlledKWh?: number[];
  lockCurrentBucket?: boolean;
  planningCeiling: PowerLimitCeiling | null;
  observedStats: ObservedHourlyStats;
};

const planDay = (spec: PlanSpec) => {
  const context: DayContext = {
    nowMs: spec.bucketStartUtcMs[0] ?? 0,
    timeZone: spec.timeZone,
    dateKey: '',
    dayStartUtcMs: spec.bucketStartUtcMs[0] ?? 0,
    bucketStartUtcMs: spec.bucketStartUtcMs,
    bucketStartLocalLabels: [],
    bucketKeys: [],
    currentBucketIndex: spec.currentBucketIndex,
    currentBucketProgress: 0,
    bucketUsage: spec.bucketUsage,
    budgetControlBucketUsage: spec.bucketUsage,
    bucketUsageControlled: [],
    bucketUsageUncontrolled: [],
    usedNowKWh: spec.usedNowKWh,
    budgetControlUsedNowKWh: spec.usedNowKWh,
    meteredUsedNowKWh: spec.usedNowKWh,
    exemptUsedNowKWh: 0,
    currentBucketUsage: spec.bucketUsage[spec.currentBucketIndex] ?? 0,
  };
  const settings = {
    enabled: true,
    dailyBudgetKWh: spec.dailyBudgetKWh,
    priceShapingEnabled: spec.priceShapingEnabled,
    controlledUsageWeight: spec.controlledUsageWeight ?? 0,
    priceShapingFlexShare: spec.priceShapingFlexShare ?? PRICE_SHAPING_FLEX_SHARE,
  };
  const profile = {
    combinedWeights: spec.profileWeights,
    breakdown: {
      uncontrolled: spec.profileWeightsUncontrolled ?? [],
      controlled: spec.profileWeightsControlled ?? [],
    },
    sampleCount: 0,
    controlledShare: 0,
  };
  const previous = spec.previousPlannedKWh
    ? {
      plannedKWh: spec.previousPlannedKWh,
      plannedUncontrolledKWh: spec.previousPlannedUncontrolledKWh,
      plannedGrossUncontrolledKWh: spec.previousPlannedGrossUncontrolledKWh,
      plannedControlledKWh: spec.previousPlannedControlledKWh,
      lastPlanBucketStartUtcMs: spec.lockCurrentBucket ? spec.bucketStartUtcMs[spec.currentBucketIndex] : null,
    }
    : null;
  const priceData = buildPriceData(context, settings, spec.combinedPrices, spec.priceOptimizationEnabled);
  return {
    ...buildPlan(context, settings, profile, spec.observedStats, previous, priceData, spec.planningCeiling),
    priceData,
  };
};

describe('allocateBudgetWithCaps', () => {
  it('caps all buckets when every bucket hits its cap', () => {
    const weights = [1, 1, 1];
    const caps = [1, 1, 1];
    const allocations = allocateBudgetWithCaps(weights, 10, caps);

    expect(allocations).toHaveLength(3);
    allocations.forEach((value, index) => {
      expect(value).toBeCloseTo(caps[index], 6);
    });
    const total = allocations.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(3, 6);
  });

  it('falls back to even allocation when weights are zero', () => {
    const allocations = allocateBudgetWithCaps([0, 0, 0], 6, [10, 10, 10]);

    expect(allocations).toHaveLength(3);
    allocations.forEach((value) => {
      expect(value).toBeCloseTo(2, 6);
    });
  });

  it('redistributes zero-weight overflow when one bucket caps early', () => {
    const allocations = allocateBudgetWithCaps([0, 0, 0], 6, [1, 10, 10]);

    expect(allocations[0]).toBeCloseTo(1, 6);
    expect(allocations[1]).toBeCloseTo(2.5, 6);
    expect(allocations[2]).toBeCloseTo(2.5, 6);
    const total = allocations.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(6, 6);
  });

  it('redistributes overflow when caps are uneven', () => {
    const allocations = allocateBudgetWithCaps([0.7, 0.3], 5, [1, 10]);

    expect(allocations[0]).toBeCloseTo(1, 6);
    expect(allocations[1]).toBeCloseTo(4, 6);
    const total = allocations.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(5, 6);
  });
});

describe('allocateBudgetWithCapsAndFloors', () => {
  it('scales floors down when sum exceeds budget', () => {
    const result = allocateBudgetWithCapsAndFloors([1, 1, 1], 9, [10, 10, 10], [5, 5, 5]);

    const total = result.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(9, 6);
    expect(result[0]).toBeCloseTo(3, 6);
    expect(result[1]).toBeCloseTo(3, 6);
    expect(result[2]).toBeCloseTo(3, 6);
  });

  it('floors never exceed caps', () => {
    const result = allocateBudgetWithCapsAndFloors([1, 1], 10, [2, 3], [5, 1]);
    expect(result[0]).toBeLessThanOrEqual(2);
    expect(result[1]).toBeLessThanOrEqual(3);
  });
});

describe('allocateBudgetWithPriceTargets', () => {
  it('maps full price flex from cap in the cheapest bucket to floor in the most expensive bucket', () => {
    const result = allocateBudgetWithPriceTargets([1, 1, 1], 6, [4, 4, 4], [0, 0, 0], [10, 20, 30], 1);

    expect(result[0]).toBeCloseTo(4, 6);
    expect(result[1]).toBeCloseTo(2, 6);
    expect(result[2]).toBeCloseTo(0, 6);
  });

  it('blends neutral allocation toward the full price target', () => {
    const result = allocateBudgetWithPriceTargets([1, 1, 1], 6, [4, 4, 4], [0, 0, 0], [10, 20, 30], 0.5);

    expect(result[0]).toBeCloseTo(3, 6);
    expect(result[1]).toBeCloseTo(2, 6);
    expect(result[2]).toBeCloseTo(1, 6);
  });

  it('falls back to neutral allocation when prices are flat', () => {
    const result = allocateBudgetWithPriceTargets([1, 2], 9, [10, 10], [0, 0], [50, 50], 1);

    expect(result[0]).toBeCloseTo(3, 6);
    expect(result[1]).toBeCloseTo(6, 6);
  });

  it('falls back to neutral allocation when prices are within the near-flat deadband', () => {
    const result = allocateBudgetWithPriceTargets([1, 2], 9, [10, 10], [0, 0], [50, 50.0000005], 1);

    expect(result[0]).toBeCloseTo(3, 6);
    expect(result[1]).toBeCloseTo(6, 6);
  });
});

describe('daily budget math helpers', () => {
  const hourMs = 60 * 60 * 1000;
  const dayStart = Date.UTC(2024, 0, 1, 0, 0, 0);
  const bucketStartUtcMs = [
    dayStart,
    dayStart + hourMs,
    dayStart + 2 * hourMs,
    dayStart + 3 * hourMs,
  ];
  const timeZone = 'UTC';

  it('clamps confidence and normalizes blended weights', () => {
    expect(getProfileBlendConfidence(-1)).toBe(0);
    expect(getProfileBlendConfidence(7)).toBeCloseTo(0.5, 5);
    expect(getProfileBlendConfidence(28)).toBe(1);

    expect(normalizeWeights([0, 0])).toEqual([0, 0]);
    expect(normalizeWeights([1, 1])).toEqual([0.5, 0.5]);
  });

  it('builds a default profile with normalized weights', () => {
    const profile = buildDefaultProfile();
    const total = profile.reduce((sum, value) => sum + value, 0);
    expect(profile).toHaveLength(24);
    expect(total).toBeCloseTo(1, 6);
  });

  it('maps combined prices onto buckets and ignores invalid entries', () => {
    expect(buildPriceSeriesPair({ bucketStartUtcMs, combinedPrices: { prices: [] } })).toBeUndefined();

    const pair = buildPriceSeriesPair({
      bucketStartUtcMs,
      combinedPrices: {
        prices: [
          { startsAt: new Date(bucketStartUtcMs[0]).toISOString(), total: 1, isCheap: false, isExpensive: false },
          { startsAt: 'invalid-date', total: 10, isCheap: false, isExpensive: false },
          { startsAt: new Date(bucketStartUtcMs[2]).toISOString(), total: 3, isCheap: false, isExpensive: false },
        ],
      },
    });

    expect(pair?.prices).toEqual([1, null, 3, null]);
    // No budgetPrice anywhere ⇒ the planning series is identical.
    expect(pair?.planningPrices).toEqual([1, null, 3, null]);
  });

  it('builds price factors only when shaping is enabled and data is complete', () => {
    const combinedPrices = {
      prices: bucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: 10 + index,
        isCheap: false,
        isExpensive: false,
      })),
    };

    const disabled = buildPriceFactorsFromPrices(bucketStartUtcMs, 0, combinedPrices, false, true);
    expect(disabled.priceShapingActive).toBe(false);
    expect(disabled.prices).toHaveLength(4);
    expect(disabled.priceFactors).toBeUndefined();

    const missing = buildPriceFactorsFromPrices(
      bucketStartUtcMs,
      1,
      { prices: combinedPrices.prices.slice(0, 2) },
      true,
      true,
    );
    expect(missing.priceShapingActive).toBe(false);
    expect(missing.prices).toHaveLength(4);

    const enabled = buildPriceFactorsFromPrices(bucketStartUtcMs, 1, combinedPrices, true, true);
    expect(enabled.priceShapingActive).toBe(true);
    expect(enabled.priceFactors?.[0]).toBeNull();
    expect(typeof enabled.priceFactors?.[1]).toBe('number');
  });

  it('buildPriceSeriesPair maps money on total and planning on budgetPrice ?? total', () => {
    const combinedPrices = {
      prices: [
        { startsAt: new Date(bucketStartUtcMs[0]).toISOString(), total: 100, budgetPrice: 10, isCheap: false, isExpensive: false },
        { startsAt: new Date(bucketStartUtcMs[1]).toISOString(), total: 100, budgetPrice: Number.NaN, isCheap: false, isExpensive: false },
        { startsAt: new Date(bucketStartUtcMs[2]).toISOString(), total: 100, isCheap: false, isExpensive: false },
      ],
    };
    const pair = buildPriceSeriesPair({ bucketStartUtcMs, combinedPrices });
    // Money series stays on `total` even when a budgetPrice exists — it feeds
    // `buckets.price` and the Budget-chart cost lines.
    expect(pair?.prices).toEqual([100, 100, 100, null]);
    // Planning series resolves budgetPrice ?? total; junk budgetPrice falls back.
    expect(pair?.planningPrices).toEqual([10, 100, 100, null]);
  });

  it('computes price factors over the planning price while keeping the money series on total', () => {
    // Flat totals ⇒ no total-based shaping signal; a low budgetPrice on bucket 0
    // is the only spread. Shaping must favour that bucket.
    const combinedPrices = {
      prices: bucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: 100,
        ...(index === 0 ? { budgetPrice: 10 } : {}),
        isCheap: false,
        isExpensive: false,
      })),
    };
    const shaped = buildPriceFactorsFromPrices(bucketStartUtcMs, 0, combinedPrices, true, true);
    expect(shaped.priceShapingActive).toBe(true);
    expect(shaped.prices).toEqual([100, 100, 100, 100]); // money series untouched
    expect(shaped.planningPrices).toEqual([10, 100, 100, 100]);
    // median 100, spread 90 ⇒ the surplus bucket's factor clamps at the max.
    expect(shaped.priceFactors?.[0]).toBeCloseTo(1.3, 6);
    expect(shaped.priceFactors?.[1]).toBeCloseTo(1, 6);
    expect(shaped.priceSpreadFactor).toBeCloseTo(0.9, 6);
  });

  it('invariance: absent or total-equal budgetPrice yields the total-based factors', () => {
    const combinedPrices = {
      prices: bucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: 10 + index,
        isCheap: false,
        isExpensive: false,
      })),
    };
    const withEqualBudget = {
      prices: combinedPrices.prices.map((entry) => ({ ...entry, budgetPrice: entry.total })),
    };
    const plain = buildPriceFactorsFromPrices(bucketStartUtcMs, 0, combinedPrices, true, true);
    const equal = buildPriceFactorsFromPrices(bucketStartUtcMs, 0, withEqualBudget, true, true);
    expect(plain.planningPrices).toEqual(plain.prices);
    expect(equal.priceFactors).toEqual(plain.priceFactors);
    expect(equal.prices).toEqual(plain.prices);
    expect(equal.priceSpreadFactor).toBe(plain.priceSpreadFactor);
  });

  it('builds a breakdown that sums to planned values', () => {
    const plannedKWh = [4, 2, 0, 6];
    const breakdown = buildPlanBreakdown({
      bucketStartUtcMs,
      timeZone,
      plannedKWh,
      breakdown: {
        uncontrolled: [1, 0, 0, 0, ...Array.from({ length: 20 }, () => 0)],
        controlled: [0, 1, 0, 0, ...Array.from({ length: 20 }, () => 0)],
      },
    });
    expect(breakdown).not.toBeNull();
    const plannedUncontrolled = breakdown?.plannedUncontrolledKWh ?? [];
    const plannedControlled = breakdown?.plannedControlledKWh ?? [];
    expect(plannedUncontrolled[0]).toBeCloseTo(4, 6);
    expect(plannedControlled[0]).toBeCloseTo(0, 6);
    expect(plannedUncontrolled[1]).toBeCloseTo(0, 6);
    expect(plannedControlled[1]).toBeCloseTo(2, 6);
    expect(plannedUncontrolled[3] + plannedControlled[3]).toBeCloseTo(6, 6);
  });

  it('builds a plan that respects previous buckets and locked current bucket', () => {
    const result = planDay({
      bucketStartUtcMs,
      bucketUsage: [1, 2, 0.5, 0.2],
      currentBucketIndex: 1,
      usedNowKWh: 3,
      dailyBudgetKWh: 10,
      profileWeights: Array.from({ length: 24 }, () => 0),
      timeZone,
      combinedPrices: {
        prices: bucketStartUtcMs.map((ts, index) => ({
          startsAt: new Date(ts).toISOString(),
          total: 15 + index,
          isCheap: false,
          isExpensive: false,
        })),
      },
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      previousPlannedKWh: [1, Number.NaN, 3, 4],
      planningCeiling: { limit: 'capacity', kw: 2 },
      lockCurrentBucket: true,
      observedStats: observedHourlyStatsFixture(),
    });

    expect(result.priceData.priceShapingActive).toBe(true);
    expect(result.plannedKWh).toHaveLength(4);
    expect(result.plannedKWh[0]).toBe(1);
    expect(result.plannedKWh[1]).toBeCloseTo(2, 6);
  });

  it('builds a plan without previous data and without a capacity cap', () => {
    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs,
      bucketUsage: [1, 2, 0, 0],
      currentBucketIndex: 1,
      usedNowKWh: 3,
      dailyBudgetKWh: 8,
      profileWeights: Array.from({ length: 24 }, () => 1),
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      observedStats: observedHourlyStatsFixture(),
    });

    expect(result.priceData.priceShapingActive).toBe(false);
    expect(result.plannedKWh[0]).toBeCloseTo(2, 6);
    expect(result.plannedKWh[1]).toBeCloseTo(3.666666, 4);
  });

  it('keeps controlled service floor independent from unmanaged reserve mode', () => {
    const buildReserveModePlan = (controlledUsageWeight: number) => planDay({
      planningCeiling: null,
      bucketStartUtcMs,
      bucketUsage: [0, 0, 0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 10,
      profileWeights: Array.from({ length: 24 }, () => 1),
      profileWeightsControlled: Array.from({ length: 24 }, () => 0),
      profileWeightsUncontrolled: Array.from({ length: 24 }, () => 1),
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      controlledUsageWeight,
      observedStats: observedHourlyStatsFixture({
        profileObservedMinControlledKWh: [
          2, 0, 0, 0,
          ...Array.from({ length: 20 }, () => 0),
        ],
      }),
    });

    const balanced = buildReserveModePlan(0);
    const conservative = buildReserveModePlan(1);

    // 2 kWh observed minimum, less the 20% peak margin, at the 0.3 controlled weight.
    expect(balanced.plannedControlledKWh[0]).toBeCloseTo(0.48, 6);
    expect(conservative.plannedControlledKWh[0]).toBeCloseTo(0.48, 6);
  });

  it('uses unmanaged reserve mode to raise uncontrolled reserve', () => {
    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs,
      bucketUsage: [0, 0, 0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 10,
      profileWeights: Array.from({ length: 24 }, () => 1),
      profileWeightsControlled: Array.from({ length: 24 }, () => 0),
      profileWeightsUncontrolled: Array.from({ length: 24 }, () => 1),
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      controlledUsageWeight: 1,
      observedStats: observedHourlyStatsFixture({
        profileObservedP50UncontrolledKWh: [1, 0, 0, 0, ...Array.from({ length: 20 }, () => 0)],
        profileObservedP75UncontrolledKWh: [2, 0, 0, 0, ...Array.from({ length: 20 }, () => 0)],
        profileObservedP90UncontrolledKWh: [4, 0, 0, 0, ...Array.from({ length: 20 }, () => 0)],
        profileObservedUncontrolledSampleCounts: [30, 0, 0, 0, ...Array.from({ length: 20 }, () => 0)],
      }),
    });

    expect(result.uncontrolledReserveDiagnostics?.hours[0]?.quantileUsed).toBeGreaterThan(0.75);
    expect(result.plannedUncontrolledKWh[0]).toBeGreaterThan(1);
  });

  it('publishes gross uncontrolled reserve separately from the net planned split', () => {
    const observedGrossBackground = Array.from({ length: 24 }, () => 2);
    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs,
      bucketUsage: [0, 0, 0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 1,
      profileWeights: Array.from({ length: 24 }, () => 1),
      profileWeightsControlled: Array.from({ length: 24 }, () => 0),
      profileWeightsUncontrolled: Array.from({ length: 24 }, () => 1),
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      observedStats: observedHourlyStatsFixture({
        profileObservedP50GrossUncontrolledKWh: observedGrossBackground,
        profileObservedP75GrossUncontrolledKWh: observedGrossBackground,
        profileObservedP90GrossUncontrolledKWh: observedGrossBackground,
        profileObservedGrossUncontrolledSampleCounts: Array.from({ length: 24 }, () => 30),
      }),
    });

    expect(result.plannedUncontrolledKWh[0]).toBeLessThan(2);
    expect(result.plannedGrossUncontrolledKWh[0]).toBeCloseTo(2, 6);
  });

  it('does not inflate gross background with the net daily-budget allowance', () => {
    const observedGrossBackground = Array.from({ length: 24 }, () => 1);
    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs,
      bucketUsage: [0, 0, 0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 12,
      profileWeights: Array.from({ length: 24 }, () => 1),
      profileWeightsControlled: Array.from({ length: 24 }, () => 0),
      profileWeightsUncontrolled: Array.from({ length: 24 }, () => 1),
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      observedStats: observedHourlyStatsFixture({
        profileObservedP50GrossUncontrolledKWh: observedGrossBackground,
        profileObservedP75GrossUncontrolledKWh: observedGrossBackground,
        profileObservedP90GrossUncontrolledKWh: observedGrossBackground,
        profileObservedGrossUncontrolledSampleCounts: Array.from({ length: 24 }, () => 30),
      }),
    });

    expect(result.plannedUncontrolledKWh[0]).toBeGreaterThan(1);
    expect(result.plannedGrossUncontrolledKWh[0]).toBeCloseTo(1, 6);
  });

  it('falls back to net planned background when gross reserve has no samples yet', () => {
    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs,
      bucketUsage: [0, 0, 0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 12,
      profileWeights: Array.from({ length: 24 }, () => 1),
      profileWeightsControlled: Array.from({ length: 24 }, () => 0),
      profileWeightsUncontrolled: Array.from({ length: 24 }, () => 1),
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      observedStats: observedHourlyStatsFixture(),
    });

    expect(result.plannedGrossUncontrolledKWh[0]).toBeCloseTo(result.plannedUncontrolledKWh[0], 6);
    expect(result.plannedGrossUncontrolledKWh[0]).toBeGreaterThan(0);
  });

  it('preserves previous gross uncontrolled reserve for locked buckets', () => {
    const previousPlan = [1, 1, 1, 1];
    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs,
      bucketUsage: [0, 0.2, 0, 0],
      currentBucketIndex: 1,
      usedNowKWh: 0.2,
      dailyBudgetKWh: 4,
      profileWeights: Array.from({ length: 24 }, () => 1),
      profileWeightsControlled: Array.from({ length: 24 }, () => 0),
      profileWeightsUncontrolled: Array.from({ length: 24 }, () => 1),
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      previousPlannedKWh: previousPlan,
      previousPlannedUncontrolledKWh: [0.25, 0.25, 0.25, 0.25],
      previousPlannedGrossUncontrolledKWh: [3, 4, 0.25, 0.25],
      previousPlannedControlledKWh: [0.75, 0.75, 0.75, 0.75],
      lockCurrentBucket: true,
      observedStats: observedHourlyStatsFixture(),
    });

    expect(result.plannedGrossUncontrolledKWh[0]).toBeCloseTo(3, 6);
    expect(result.plannedGrossUncontrolledKWh[1]).toBeCloseTo(4, 6);
  });

  it('scales observed min floors down when budget is lower than floors', () => {
    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs,
      bucketUsage: [0, 0, 0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 8,
      profileWeights: Array.from({ length: 24 }, () => 1),
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      observedStats: observedHourlyStatsFixture({
        profileObservedMinUncontrolledKWh: [
          4, 4, 4, 4,
          ...Array.from({ length: 20 }, () => 0),
        ],
        profileObservedMinControlledKWh: Array.from({ length: 24 }, () => 0),
      }),
    });

    const total = result.plannedKWh.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(8, 6);
    expect(result.plannedKWh[0]).toBeCloseTo(2, 6);
    expect(result.plannedKWh[1]).toBeCloseTo(2, 6);
    expect(result.plannedKWh[2]).toBeCloseTo(2, 6);
    expect(result.plannedKWh[3]).toBeCloseTo(2, 6);
  });

  it('targets cheapest hours toward the cap and most expensive hours toward the floor', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 3);
    const combinedPrices = {
      prices: shortBucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: [10, 20, 30][index] ?? 30,
        isCheap: false,
        isExpensive: false,
      })),
    };
    const baseProfile = Array.from({ length: 24 }, () => 0);
    const controlledProfile = baseProfile.slice();
    const uncontrolledProfile = baseProfile.slice();
    controlledProfile[0] = 1;
    controlledProfile[1] = 1;
    controlledProfile[2] = 1;
    uncontrolledProfile[0] = 1;
    uncontrolledProfile[1] = 1;
    uncontrolledProfile[2] = 1;

    const result = planDay({
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 6,
      profileWeights: baseProfile,
      profileWeightsControlled: controlledProfile,
      profileWeightsUncontrolled: uncontrolledProfile,
      timeZone,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1,
      planningCeiling: { limit: 'capacity', kw: 4 },
      observedStats: observedHourlyStatsFixture(),
    });

    expect(result.priceData.effectivePriceShapingFlexShare).toBe(1);
    expect(result.plannedKWh[0]).toBeCloseTo(4, 6);
    expect(result.plannedKWh[1]).toBeCloseTo(2, 6);
    expect(result.plannedKWh[2]).toBeCloseTo(0, 6);
  });

  it('keeps controlled service floor independent from unmanaged reserve mode during price shaping', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 3);
    const combinedPrices = {
      prices: shortBucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: [10, 20, 30][index] ?? 30,
        isCheap: false,
        isExpensive: false,
      })),
    };
    const baseProfile = Array.from({ length: 24 }, () => 0);
    baseProfile[0] = 1;
    baseProfile[1] = 1;
    baseProfile[2] = 1;
    const controlledProfile = baseProfile.slice();
    const uncontrolledProfile = baseProfile.slice();
    const observedUncontrolledMin = Array.from({ length: 24 }, () => 0);
    const observedControlledMin = Array.from({ length: 24 }, () => 0);
    observedUncontrolledMin[2] = 1;
    observedControlledMin[2] = 3;

    const buildWeightedPlan = (controlledUsageWeight: number) => planDay({
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 12,
      profileWeights: baseProfile,
      profileWeightsControlled: controlledProfile,
      profileWeightsUncontrolled: uncontrolledProfile,
      timeZone,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1,
      planningCeiling: { limit: 'capacity', kw: 10 },
      controlledUsageWeight,
      observedStats: observedHourlyStatsFixture({
        profileObservedMinUncontrolledKWh: observedUncontrolledMin,
        profileObservedMinControlledKWh: observedControlledMin,
      }),
    });

    const balanced = buildWeightedPlan(0);
    const conservative = buildWeightedPlan(1);

    expect(balanced.plannedKWh[2]).toBeCloseTo(conservative.plannedKWh[2], 6);
    expect(balanced.plannedControlledKWh[2]).toBeCloseTo(conservative.plannedControlledKWh[2], 6);
    // 3 kWh observed minimum, less the 20% peak margin, at the 0.3 controlled weight.
    expect(balanced.plannedControlledKWh[2]).toBeGreaterThanOrEqual(0.72);
  });

  it('keeps adaptive uncontrolled reserve in the uncontrolled plan split', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 2);
    const profile = Array.from({ length: 24 }, () => 0);
    profile[0] = 1;
    profile[1] = 1;
    const p50 = [2, 0, ...Array.from({ length: 22 }, () => 0)];
    const p75 = [3, 0, ...Array.from({ length: 22 }, () => 0)];
    const p90 = [5, 0, ...Array.from({ length: 22 }, () => 0)];

    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 6,
      profileWeights: profile,
      profileWeightsControlled: profile,
      profileWeightsUncontrolled: profile,
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      controlledUsageWeight: 1,
      observedStats: observedHourlyStatsFixture({
        profileObservedP50UncontrolledKWh: p50,
        profileObservedP75UncontrolledKWh: p75,
        profileObservedP90UncontrolledKWh: p90,
        profileObservedUncontrolledSampleCounts: [30, 0, ...Array.from({ length: 22 }, () => 0)],
      }),
    });

    expect(result.plannedUncontrolledKWh[0]).toBeGreaterThan(2);
    expect(result.plannedUncontrolledKWh[0]).toBeLessThanOrEqual(5);
    expect(result.uncontrolledReserveDiagnostics?.hours[0]?.reasonCode).toBe('volatile_hour');
  });

  it('uses total observed load as the hourly ceiling independent of unmanaged reserve mode', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 2);
    const profile = Array.from({ length: 24 }, () => 0);
    profile[0] = 1;
    profile[1] = 1;
    const observedUncontrolledMax = [1, 1, ...Array.from({ length: 22 }, () => 0)];
    const observedControlledMax = [3, 3, ...Array.from({ length: 22 }, () => 0)];

    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 8,
      profileWeights: profile,
      profileWeightsControlled: profile,
      profileWeightsUncontrolled: profile,
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      controlledUsageWeight: 0,
      observedStats: observedHourlyStatsFixture({
        profileObservedMaxUncontrolledKWh: observedUncontrolledMax,
        profileObservedMaxControlledKWh: observedControlledMax,
      }),
    });

    expect(result.plannedKWh[0]).toBeCloseTo(4, 6);
    expect(result.plannedKWh[1]).toBeCloseTo(4, 6);
  });

  it('lets price flex fill controlled headroom above the uncontrolled floor', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 2);
    const combinedPrices = {
      prices: shortBucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: index === 0 ? 10 : 30,
        isCheap: false,
        isExpensive: false,
      })),
    };
    const profile = Array.from({ length: 24 }, () => 0);
    profile[0] = 1;
    profile[1] = 1;
    const observedUncontrolledMax = [1, 1, ...Array.from({ length: 22 }, () => 0)];
    const observedControlledMax = [3, 3, ...Array.from({ length: 22 }, () => 0)];
    const observedUncontrolledMin = [0, 1, ...Array.from({ length: 22 }, () => 0)];

    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 5,
      profileWeights: profile,
      profileWeightsControlled: profile,
      profileWeightsUncontrolled: profile,
      timeZone,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1,
      controlledUsageWeight: 0,
      observedStats: observedHourlyStatsFixture({
        profileObservedMaxUncontrolledKWh: observedUncontrolledMax,
        profileObservedMaxControlledKWh: observedControlledMax,
        profileObservedMinUncontrolledKWh: observedUncontrolledMin,
      }),
    });

    // The cheap hour fills to the budget left above the expensive hour's floor
    // (1 kWh observed minimum less the 20% peak margin), under its 4.8 kWh cap.
    expect(result.plannedKWh[0]).toBeCloseTo(4.2, 6);
    expect(result.plannedKWh[1]).toBeCloseTo(0.8, 6);
  });

  it('applies price target shaping to the full plan when split profiles are missing', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 2);
    const combinedPrices = {
      prices: shortBucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: index === 0 ? 10 : 30,
        isCheap: false,
        isExpensive: false,
      })),
    };
    const baseProfile = Array.from({ length: 24 }, () => 0);
    baseProfile[0] = 2;
    baseProfile[1] = 4;

    const priceShape = buildPriceFactorsFromPrices(shortBucketStartUtcMs, 0, combinedPrices, true, true);

    const result = planDay({
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 10,
      profileWeights: baseProfile,
      timeZone,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1,
      planningCeiling: { limit: 'capacity', kw: 10 },
      observedStats: observedHourlyStatsFixture(),
    });

    expect(priceShape.priceShapingActive).toBe(true);
    expect(result.plannedKWh[0]).toBeCloseTo(10, 6);
    expect(result.plannedKWh[1]).toBeCloseTo(0, 6);
  });

  it('uses price target shaping when split profiles are incomplete', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 2);
    const combinedPrices = {
      prices: shortBucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: index === 0 ? 10 : 30,
        isCheap: false,
        isExpensive: false,
      })),
    };
    const baseProfile = Array.from({ length: 24 }, () => 0);
    baseProfile[0] = 2;
    baseProfile[1] = 4;
    const controlledProfile = Array.from({ length: 24 }, () => 0);
    controlledProfile[0] = 9;
    controlledProfile[1] = 1;

    const priceShape = buildPriceFactorsFromPrices(shortBucketStartUtcMs, 0, combinedPrices, true, true);

    const result = planDay({
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 10,
      profileWeights: baseProfile,
      profileWeightsControlled: controlledProfile,
      timeZone,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1,
      planningCeiling: { limit: 'capacity', kw: 10 },
      observedStats: observedHourlyStatsFixture(),
    });

    expect(priceShape.priceShapingActive).toBe(true);
    expect(result.plannedKWh[0]).toBeCloseTo(10, 6);
    expect(result.plannedKWh[1]).toBeCloseTo(0, 6);
  });

  it('handles cumulative budgets and weight normalization helpers', () => {
    expect(buildAllowedCumKWh([1, 2], 0)).toEqual([0, 0]);
    expect(buildAllowedCumKWh([1, 2], 10)).toEqual([1, 3]);

    expect(buildWeightsFromPlan([0, 0])).toEqual([0, 0]);
    expect(buildWeightsFromPlan([1, 3])).toEqual([0.25, 0.75]);

    expect(resolveCurrentBucketIndex(0, 0, 1000)).toBe(0);
    expect(resolveCurrentBucketIndex(0, 24, -hourMs)).toBe(0);
  });

  it('uses the lower of capacity cap and total observed cap', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 2);
    const profileControlled = Array.from({ length: 24 }, () => 0);
    profileControlled[0] = 1;
    profileControlled[1] = 1;
    const profileUncontrolled = Array.from({ length: 24 }, () => 0);

    const observedLimited = planDay({
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 10,
      profileWeights: profileControlled,
      profileWeightsControlled: profileControlled,
      profileWeightsUncontrolled: profileUncontrolled,
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      controlledUsageWeight: 1,
      planningCeiling: { limit: 'capacity', kw: 2 },
      observedStats: observedHourlyStatsFixture({
        profileObservedMaxControlledKWh: [1, 1, ...Array.from({ length: 22 }, () => 0)],
      }),
    });
    // 1 kWh observed peak plus the 20% margin binds below the 2 kW ceiling.
    expect(Math.max(...observedLimited.plannedKWh)).toBeLessThanOrEqual(1.2 + 1e-6);

    const capacityLimited = planDay({
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 10,
      profileWeights: profileControlled,
      profileWeightsControlled: profileControlled,
      profileWeightsUncontrolled: profileUncontrolled,
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      controlledUsageWeight: 1,
      planningCeiling: { limit: 'capacity', kw: 2 },
      observedStats: observedHourlyStatsFixture({
        profileObservedMaxControlledKWh: [10, 10, ...Array.from({ length: 22 }, () => 0)],
      }),
    });
    expect(Math.max(...capacityLimited.plannedKWh)).toBeLessThanOrEqual(2 + 1e-6);
  });

  it('remains stable when budget is infeasible under tight caps', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 3);
    const profileControlled = Array.from({ length: 24 }, () => 0);
    profileControlled[0] = 1;
    profileControlled[1] = 1;
    profileControlled[2] = 1;
    const profileUncontrolled = Array.from({ length: 24 }, () => 0);

    const result = planDay({
      planningCeiling: null,
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 20,
      profileWeights: profileControlled,
      profileWeightsControlled: profileControlled,
      profileWeightsUncontrolled: profileUncontrolled,
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
      controlledUsageWeight: 1,
      observedStats: observedHourlyStatsFixture({
        profileObservedMaxControlledKWh: [1, 1, 1, ...Array.from({ length: 21 }, () => 0)],
      }),
    });

    expect(result.plannedKWh.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(result.plannedUncontrolledKWh.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(result.plannedControlledKWh.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    const total = result.plannedKWh.reduce((sum, value) => sum + value, 0);
    expect(total).toBeLessThanOrEqual(3.6 + 1e-6);
  });

  it('reduces effective price shaping to zero on flat prices and clamps spread factor to 1 on high spread', () => {
    const flatPrices = {
      prices: bucketStartUtcMs.map((ts) => ({
        startsAt: new Date(ts).toISOString(),
        total: 100,
        isCheap: false,
        isExpensive: false,
      })),
    };
    const flatFactors = buildPriceFactorsFromPrices(bucketStartUtcMs, 0, flatPrices, true, true);
    expect(flatFactors.priceShapingActive).toBe(true);
    expect(flatFactors.priceSpreadFactor).toBe(0);

    const baseProfile = Array.from({ length: 24 }, () => 0);
    baseProfile[0] = 1;
    baseProfile[1] = 2;
    const flatPlan = planDay({
      planningCeiling: null,
      bucketStartUtcMs: bucketStartUtcMs.slice(0, 2),
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 9,
      profileWeights: baseProfile,
      timeZone,
      combinedPrices: {
        prices: bucketStartUtcMs.slice(0, 2).map((ts) => ({
          startsAt: new Date(ts).toISOString(),
          total: 50,
          isCheap: false,
          isExpensive: false,
        })),
      },
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1,
      observedStats: observedHourlyStatsFixture(),
    });
    expect(flatPlan.priceData.effectivePriceShapingFlexShare).toBe(0);
    expect(flatPlan.plannedKWh[0]).toBeCloseTo(3, 6);
    expect(flatPlan.plannedKWh[1]).toBeCloseTo(6, 6);

    const nearFlatPlan = planDay({
      planningCeiling: null,
      bucketStartUtcMs: bucketStartUtcMs.slice(0, 2),
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 9,
      profileWeights: baseProfile,
      timeZone,
      combinedPrices: {
        prices: bucketStartUtcMs.slice(0, 2).map((ts, index) => ({
          startsAt: new Date(ts).toISOString(),
          total: index === 0 ? 50 : 50.0000005,
          isCheap: false,
          isExpensive: false,
        })),
      },
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1,
      observedStats: observedHourlyStatsFixture(),
    });
    expect(nearFlatPlan.priceData.priceSpreadFactor).toBe(0);
    expect(nearFlatPlan.priceData.effectivePriceShapingFlexShare).toBe(0);
    expect(nearFlatPlan.plannedKWh[0]).toBeCloseTo(3, 6);
    expect(nearFlatPlan.plannedKWh[1]).toBeCloseTo(6, 6);

    const highSpreadPrices = {
      prices: bucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: index * 1000 + 1,
        isCheap: false,
        isExpensive: false,
      })),
    };
    const highSpreadFactors = buildPriceFactorsFromPrices(bucketStartUtcMs, 0, highSpreadPrices, true, true);
    expect(highSpreadFactors.priceSpreadFactor).toBe(1);
  });
});
