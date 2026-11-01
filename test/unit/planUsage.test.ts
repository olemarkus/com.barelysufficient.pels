import { sumBudgetExemptProjectedUsageKw } from '../../lib/plan/planUsage';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

const NONE_HELD = new Set<string>();

// The prod charger's single-phase ladder, trimmed: Off, then 6 A at 1.38 kW.
const chargerLadder: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: '6a', planningPowerW: 1380 },
    { id: '32a', planningPowerW: 7360 },
  ],
};

describe('plan usage budget exemption helpers', () => {
  it('prefers the measured draw over expected power when the device is drawing', () => {
    expect(sumBudgetExemptProjectedUsageKw([
      {
        id: 'a',
        budgetExempt: true,
        countsAsManagedUsage: true,
        currentDrawKw: 1.2,
        expectedPowerKw: 2,
      },
      {
        // Drawing nothing and not observed off: the meter is the answer.
        id: 'b',
        currentDrawKw: 0,
        budgetExempt: true,
        countsAsManagedUsage: true,
        expectedPowerKw: 0.8,
      },
    ], (device) => device.countsAsManagedUsage, NONE_HELD)).toBeCloseTo(1.2, 6);
  });

  it('projects an observed-off exempt device onto its configured demand', () => {
    // The daily-pace reservation has to survive a duty cycle, so an exempt
    // device that is OFF still claims its configured demand. This is the one
    // remaining stand-in for a device that is not drawing, and it is a
    // reservation question rather than a measurement question.
    expect(sumBudgetExemptProjectedUsageKw([
      {
        id: 'a',
        currentDrawKw: 0,
        budgetExempt: true,
        countsAsManagedUsage: true,
        currentOn: false,
        expectedPowerKw: 1.5,
      },
      {
        id: 'b',
        budgetExempt: true,
        countsAsManagedUsage: true,
        currentDrawKw: 0.5,
        expectedPowerKw: 2,
      },
      {
        id: 'c',
        currentDrawKw: 0,
        budgetExempt: false,
        countsAsManagedUsage: true,
        expectedPowerKw: 10,
      },
    ], (device) => device.countsAsManagedUsage, NONE_HELD)).toBeCloseTo(2, 6);
  });

  it('gives an exempt device PELS is holding off no claim beyond its draw', () => {
    // Prod 2026-11-01: a boosted charger held off for the hard cap kept its
    // 7 kW learned peak on the daily axis, so daily-budget limiting of every
    // other device stopped while it waited.
    const held = new Set(['charger', 'heater']);
    expect(sumBudgetExemptProjectedUsageKw([
      {
        id: 'charger',
        budgetExempt: true,
        countsAsManagedUsage: true,
        currentOn: false,
        currentDrawKw: 0,
        expectedPowerKw: 7,
      },
      {
        // Still winding down after the turn-off: what it draws still counts.
        id: 'heater',
        budgetExempt: true,
        countsAsManagedUsage: true,
        currentOn: false,
        currentDrawKw: 0.4,
        expectedPowerKw: 3,
      },
    ], (device) => device.countsAsManagedUsage, held)).toBeCloseTo(0.4, 6);
  });

  it('projects an off exempt device with power steps onto its restart step, not its peak', () => {
    expect(sumBudgetExemptProjectedUsageKw([
      {
        id: 'charger',
        budgetExempt: true,
        countsAsManagedUsage: true,
        currentOn: false,
        steppedLoadProfile: chargerLadder,
        selectedStepId: '6a',
        currentDrawKw: 0,
        expectedPowerKw: 6.99,
        planningPowerKw: 1.38,
      },
    ], (device) => device.countsAsManagedUsage, NONE_HELD)).toBeCloseTo(1.38, 6);
  });

  it('ignores budget-exempt devices with capacity control disabled', () => {
    expect(sumBudgetExemptProjectedUsageKw([
      { id: 'a',
        expectedPowerKw: 1,
        budgetExempt: true,
        countsAsManagedUsage: false,
        currentDrawKw: 5,
      },
      { id: 'b',
        expectedPowerKw: 1,
        budgetExempt: true,
        countsAsManagedUsage: true,
        currentDrawKw: 1.5,
      },
    ], (device) => device.countsAsManagedUsage, NONE_HELD)).toBeCloseTo(1.5, 6);
  });

});
