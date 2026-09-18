import { computeProjectedPeriodEnergyKWh } from '../../packages/shared-domain/src/hourEnergyProjection';

describe('computeProjectedPeriodEnergyKWh', () => {
  it('does not let export subtract billed import already used', () => {
    expect(computeProjectedPeriodEnergyKWh(0.9, -6, 1)).toBeCloseTo(0.9, 8);
  });

  it('projects positive import through the remaining period', () => {
    expect(computeProjectedPeriodEnergyKWh(0.9, 6, 1)).toBeCloseTo(1, 8);
  });
});
