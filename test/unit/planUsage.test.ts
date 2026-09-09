import { sumBudgetExemptProjectedUsageKw } from '../../lib/plan/planUsage';

describe('plan usage budget exemption helpers', () => {
  it('prefers the measured draw over expected power when the device is drawing', () => {
    expect(sumBudgetExemptProjectedUsageKw([
      {
        budgetExempt: true,
        currentDrawKw: 1.2,
        expectedPowerKw: 2,
      },
      {
        // Drawing nothing and not observed off: the meter is the answer.
        currentDrawKw: 0,
        budgetExempt: true,
        expectedPowerKw: 0.8,
      },
    ])).toBeCloseTo(1.2, 6);
  });

  it('projects an observed-off exempt device onto its configured demand', () => {
    // The daily-pace reservation has to survive a duty cycle, so an exempt
    // device that is OFF still claims its configured demand. This is the one
    // remaining stand-in for a device that is not drawing, and it is a
    // reservation question rather than a measurement question.
    expect(sumBudgetExemptProjectedUsageKw([
      {
        currentDrawKw: 0,
        budgetExempt: true,
        currentOn: false,
        expectedPowerKw: 1.5,
      },
      {
        budgetExempt: true,
        currentDrawKw: 0.5,
        expectedPowerKw: 2,
      },
      {
        currentDrawKw: 0,
        budgetExempt: false,
        expectedPowerKw: 10,
      },
    ])).toBeCloseTo(2, 6);
  });

  it('ignores budget-exempt devices with capacity control disabled', () => {
    expect(sumBudgetExemptProjectedUsageKw([
      { expectedPowerKw: 1,
        budgetExempt: true,
        controllable: false,
        currentDrawKw: 5,
      },
      { expectedPowerKw: 1,
        budgetExempt: true,
        controllable: true,
        currentDrawKw: 1.5,
      },
    ])).toBeCloseTo(1.5, 6);
  });

});
