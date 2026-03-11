import { sumBudgetExemptLiveUsageKw } from '../lib/plan/planUsage';

describe('plan usage budget exemption helpers', () => {
  it('prefers measured power over expected power when both are available', () => {
    expect(sumBudgetExemptLiveUsageKw([
      {
        budgetExempt: true,
        measuredPowerKw: 1.2,
        expectedPowerKw: 2,
      },
      {
        budgetExempt: true,
        expectedPowerKw: 0.8,
      },
    ])).toBeCloseTo(2, 6);
  });

  it('allows expected power as a live fallback for exempt soft-limit control', () => {
    expect(sumBudgetExemptLiveUsageKw([
      {
        budgetExempt: true,
        expectedPowerKw: 1.5,
      },
      {
        budgetExempt: true,
        measuredPowerKw: 0.5,
        expectedPowerKw: 2,
      },
      {
        budgetExempt: false,
        expectedPowerKw: 10,
      },
    ])).toBeCloseTo(2, 6);
  });
});
