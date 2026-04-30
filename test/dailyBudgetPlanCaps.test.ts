import {
  resolveUncontrolledReserve,
  resolveRemainingCaps,
  resolveRemainingFloors,
} from '../lib/dailyBudget/dailyBudgetPlanCaps';

describe('daily budget plan caps/floors', () => {
  const timeZone = 'UTC';
  const bucketStartUtcMs = [Date.UTC(2024, 0, 1, 0, 0, 0)];

  it('uses available observed cap directly when only uncontrolled observed cap exists', () => {
    const result = resolveRemainingCaps({
      bucketStartUtcMs,
      timeZone,
      splitSharesUncontrolled: [1],
      splitSharesControlled: [0],
      controlledUsageWeight: 0.3,
      profileObservedMaxUncontrolledKWh: [1, ...Array.from({ length: 23 }, () => 0)],
      profileObservedMaxControlledKWh: Array.from({ length: 24 }, () => 0),
      observedPeakMarginRatio: 0.2,
      usedInCurrent: 0,
      remainingStartIndex: 0,
      currentBucketIndex: 0,
    });

    // 1.0 kWh observed max with 20% margin => 1.2 kWh cap for the hour.
    expect(result[0]).toBeCloseTo(1.2, 6);
  });

  it('uses available observed floor directly when only uncontrolled observed floor exists', () => {
    const result = resolveRemainingFloors({
      bucketStartUtcMs,
      timeZone,
      splitSharesUncontrolled: [1],
      splitSharesControlled: [0],
      controlledUsageWeight: 0.3,
      profileObservedMinUncontrolledKWh: [1, ...Array.from({ length: 23 }, () => 0)],
      profileObservedMinControlledKWh: Array.from({ length: 24 }, () => 0),
      observedPeakMarginRatio: 0.2,
      usedInCurrent: 0,
      remainingStartIndex: 0,
      currentBucketIndex: 0,
    });

    // 1.0 kWh observed min with 20% margin => 0.8 kWh floor for the hour.
    expect(result.floors[0]).toBeCloseTo(0.8, 6);
  });

  it('reserves uncontrolled load from p50-p75 without discounting by peak margin', () => {
    const result = resolveRemainingFloors({
      bucketStartUtcMs,
      timeZone,
      splitSharesUncontrolled: [1],
      splitSharesControlled: [0],
      controlledUsageWeight: 0,
      profileObservedMinUncontrolledKWh: [1, ...Array.from({ length: 23 }, () => 0)],
      profileObservedMinControlledKWh: Array.from({ length: 24 }, () => 0),
      profileObservedP50UncontrolledKWh: [2, ...Array.from({ length: 23 }, () => 0)],
      profileObservedP75UncontrolledKWh: [3, ...Array.from({ length: 23 }, () => 0)],
      profileObservedP90UncontrolledKWh: [5, ...Array.from({ length: 23 }, () => 0)],
      profileObservedUncontrolledSampleCounts: [30, ...Array.from({ length: 23 }, () => 0)],
      observedPeakMarginRatio: 0.2,
      usedInCurrent: 0,
      remainingStartIndex: 0,
      currentBucketIndex: 0,
    });

    expect(result.floors[0]).toBeGreaterThan(2);
    expect(result.floors[0]).toBeLessThanOrEqual(3);
    expect(result.floors[0]).not.toBeCloseTo(0.8, 6);
    expect(result.diagnostics.hours[0]?.reasonCode).toBe('volatile_hour');
  });

  it('caps the adaptive reserve at p75 in balanced mode', () => {
    const result = resolveUncontrolledReserve({
      hour: 0,
      p50: 1,
      p75: 2,
      p90: 10,
      samples: 30,
      marginRatio: 0.2,
    });

    expect(result.reservedUncontrolledKWh).toBeCloseTo(2, 6);
    expect(result.diagnostic.quantileUsed).toBeCloseTo(0.75, 6);
  });

  it('can reserve into the p75-p90 tail in conservative mode', () => {
    const balanced = resolveUncontrolledReserve({
      hour: 0,
      p50: 1,
      p75: 2,
      p90: 10,
      samples: 30,
      marginRatio: 0.2,
      reserveAggressiveness: 0,
    });
    const conservative = resolveUncontrolledReserve({
      hour: 0,
      p50: 1,
      p75: 2,
      p90: 10,
      samples: 30,
      marginRatio: 0.2,
      reserveAggressiveness: 1,
    });

    expect(balanced.reservedUncontrolledKWh).toBeCloseTo(2, 6);
    expect(conservative.diagnostic.quantileUsed).toBeCloseTo(0.85, 6);
    expect(conservative.reservedUncontrolledKWh).toBeGreaterThan(balanced.reservedUncontrolledKWh);
    expect(conservative.reservedUncontrolledKWh).toBeLessThan(10);
  });

  it('does not mark stable conservative reserve hours as volatile', () => {
    const result = resolveUncontrolledReserve({
      hour: 0,
      p50: 2,
      p75: 2,
      p90: 2,
      samples: 30,
      marginRatio: 0.2,
      reserveAggressiveness: 1,
    });

    expect(result.reservedUncontrolledKWh).toBeCloseTo(2, 6);
    expect(result.diagnostic.reasonCode).toBe('median_default');
  });

  it('does not scale caps by split share when controlled endpoint weight has no observed cap', () => {
    const result = resolveRemainingCaps({
      bucketStartUtcMs,
      timeZone,
      splitSharesUncontrolled: [0.8],
      splitSharesControlled: [0.2],
      controlledUsageWeight: 1,
      profileObservedMaxUncontrolledKWh: [2, ...Array.from({ length: 23 }, () => 0)],
      profileObservedMaxControlledKWh: Array.from({ length: 24 }, () => 0),
      observedPeakMarginRatio: 0.2,
      usedInCurrent: 0,
      remainingStartIndex: 0,
      currentBucketIndex: 0,
    });

    // Uncontrolled cap: 2 * 1.2 = 2.4 kWh.
    expect(result[0]).toBeCloseTo(2.4, 6);
  });

  it('does not scale floors by split share when controlled endpoint weight has no observed floor', () => {
    const result = resolveRemainingFloors({
      bucketStartUtcMs,
      timeZone,
      splitSharesUncontrolled: [0.8],
      splitSharesControlled: [0.2],
      controlledUsageWeight: 1,
      profileObservedMinUncontrolledKWh: [1, ...Array.from({ length: 23 }, () => 0)],
      profileObservedMinControlledKWh: Array.from({ length: 24 }, () => 0),
      observedPeakMarginRatio: 0.2,
      usedInCurrent: 0,
      remainingStartIndex: 0,
      currentBucketIndex: 0,
    });

    // Uncontrolled floor: 1 * 0.8 = 0.8 kWh.
    expect(result.floors[0]).toBeCloseTo(0.8, 6);
  });
});
