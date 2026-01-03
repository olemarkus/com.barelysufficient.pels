import { allocateBudgetWithCaps } from '../lib/dailyBudget/dailyBudgetMath';

describe('allocateBudgetWithCaps', () => {
  it('caps all buckets when every bucket hits its cap', () => {
    const weights = [1, 1, 1];
    const caps = [1, 1, 1];
    const allocations = allocateBudgetWithCaps({
      weights,
      totalKWh: 10,
      caps,
    });

    expect(allocations).toHaveLength(3);
    allocations.forEach((value, index) => {
      expect(value).toBeCloseTo(caps[index], 6);
    });
    const total = allocations.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(3, 6);
  });

  it('falls back to even allocation when weights are zero', () => {
    const allocations = allocateBudgetWithCaps({
      weights: [0, 0, 0],
      totalKWh: 6,
      caps: [10, 10, 10],
    });

    expect(allocations).toHaveLength(3);
    allocations.forEach((value) => {
      expect(value).toBeCloseTo(2, 6);
    });
  });

  it('redistributes overflow when caps are uneven', () => {
    const allocations = allocateBudgetWithCaps({
      weights: [0.7, 0.3],
      totalKWh: 5,
      caps: [1, 10],
    });

    expect(allocations[0]).toBeCloseTo(1, 6);
    expect(allocations[1]).toBeCloseTo(4, 6);
    const total = allocations.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(5, 6);
  });
});
