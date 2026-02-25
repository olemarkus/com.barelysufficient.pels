import {
  resolveRemainingCaps,
  resolveRemainingFloors,
} from '../lib/dailyBudget/dailyBudgetPlanCaps';

describe('daily budget plan caps/floors', () => {
  const timeZone = 'UTC';
  const bucketStartUtcMs = [Date.UTC(2024, 0, 1, 0, 0, 0)];

  it('does not inflate blended caps when only uncontrolled observed cap exists', () => {
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

  it('does not inflate blended floors when only uncontrolled observed floor exists', () => {
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
    expect(result[0]).toBeCloseTo(0.8, 6);
  });

  it('falls back to uncontrolled cap when controlled endpoint weight has no observed cap', () => {
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

    // Uncontrolled cap: 2 * 1.2 = 2.4 kWh; with 0.8 split share -> total cap 3.0 kWh.
    expect(result[0]).toBeCloseTo(3, 6);
  });

  it('falls back to uncontrolled floor when controlled endpoint weight has no observed floor', () => {
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

    // Uncontrolled floor: 1 * 0.8 = 0.8 kWh; with 0.8 split share -> total floor 1.0 kWh.
    expect(result[0]).toBeCloseTo(1, 6);
  });
});
