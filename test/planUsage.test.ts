import { splitControlledUsageKw, sumBudgetExemptLiveUsageKw } from '../lib/plan/planUsage';

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

  it('ignores budget-exempt devices with capacity control disabled', () => {
    expect(sumBudgetExemptLiveUsageKw([
      {
        budgetExempt: true,
        controllable: false,
        measuredPowerKw: 5,
      },
      {
        budgetExempt: true,
        controllable: true,
        measuredPowerKw: 1.5,
      },
    ])).toBeCloseTo(1.5, 6);
  });

  it('splits controlled and uncontrolled usage from the same helper', () => {
    expect(splitControlledUsageKw({
      totalKw: 4,
      devices: [
        { currentState: 'on', measuredPowerKw: 1.5, controllable: true },
        { currentState: 'on', expectedPowerKw: 0.5, controllable: true },
        { currentState: 'on', measuredPowerKw: 2, controllable: false },
      ],
    })).toEqual({
      controlledKw: 2,
      uncontrolledKw: 2,
    });
  });

  it('does not treat configured fallback power as live controlled usage', () => {
    expect(splitControlledUsageKw({
      totalKw: 4,
      devices: [
        { currentState: 'on', measuredPowerKw: 1.5, controllable: true },
        { currentState: 'on', powerKw: 1, controllable: true },
      ],
    })).toEqual({
      controlledKw: 1.5,
      uncontrolledKw: 2.5,
    });
  });
});
