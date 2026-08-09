import { splitControlledUsageKw, sumBudgetExemptProjectedUsageKw } from '../../lib/plan/planUsage';

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
        controlCapabilityId: 'onoff',
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

  it('splits controlled and uncontrolled usage from the same helper', () => {
    expect(splitControlledUsageKw({
      totalKw: 4,
      devices: [
        { expectedPowerKw: 1, currentState: 'on', currentDrawKw: 1.5, controllable: true },
        { currentDrawKw: 0.5, currentState: 'on', expectedPowerKw: 0.5, controllable: true },
        { expectedPowerKw: 1, currentState: 'on', currentDrawKw: 2, controllable: false },
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
        { expectedPowerKw: 1, currentState: 'on', currentDrawKw: 1.5, controllable: true },
        { currentDrawKw: 0, currentState: 'on', expectedPowerKw: 1, controllable: true },
      ],
    })).toEqual({
      controlledKw: 1.5,
      uncontrolledKw: 2.5,
    });
  });

  it('books a target-only device at its meter, never at its expected demand', () => {
    // A device with no on/off handle used to fall through to `expectedPowerKw`
    // because its live state was "not applicable". It has a meter like everything
    // else in the managed set, and the meter says 1.25 kW.
    expect(splitControlledUsageKw({
      totalKw: 3,
      devices: [
        {
          currentDrawKw: 1.25,
          currentState: 'not_applicable',
          expectedPowerKw: 4,
          controllable: true,
        },
      ],
    })).toEqual({
      controlledKw: 1.25,
      uncontrolledKw: 1.75,
    });
  });

  it('treats a measured 0 on an observed-on device as authoritative live usage (does not pad with expected demand)', () => {
    // Regression for the resolveLiveUsagePowerKw observed-on branch: when
    // measured_power reports 0 (transient sample, between thermostat duty
    // cycles), the device contributes 0 to live attribution — the expected
    // demand is reserved for restore admission, not live usage padding.
    const result = splitControlledUsageKw({
      totalKw: 5,
      devices: [
        {
          controllable: true,
          plannedState: 'keep',
          currentDrawKw: 0,
          expectedPowerKw: 2,
        },
      ],
    });
    expect(result.controlledKw).toBe(0);
    expect(result.uncontrolledKw).toBe(5);
  });
});
