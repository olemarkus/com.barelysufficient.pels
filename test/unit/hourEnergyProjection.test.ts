import {
  computeProjectedPeriodEnergyKWh,
  isProjectedOverHardCap,
} from '../../packages/shared-domain/src/hourEnergyProjection';

describe('computeProjectedPeriodEnergyKWh', () => {
  it('projects used energy plus the current draw over the remaining minutes', () => {
    expect(computeProjectedPeriodEnergyKWh(1.9, 5.2, 30)).toBeCloseTo(4.5, 5);
  });

  it('returns the used energy at the period boundary (no minutes remaining)', () => {
    expect(computeProjectedPeriodEnergyKWh(3.4, 9, 0)).toBeCloseTo(3.4, 5);
  });

  it('keeps billed import unchanged while the home exports', () => {
    expect(computeProjectedPeriodEnergyKWh(0.3, -2.0, 46)).toBeCloseTo(0.3, 8);
  });

  it('does not let export subtract billed import already used', () => {
    expect(computeProjectedPeriodEnergyKWh(0.9, -6, 1)).toBeCloseTo(0.9, 8);
  });

  it('projects positive import through the remaining period', () => {
    expect(computeProjectedPeriodEnergyKWh(0.9, 6, 1)).toBeCloseTo(1, 8);
  });
});

describe('isProjectedOverHardCap', () => {
  it('is strict: a projection exactly at the cap holds the tariff step', () => {
    // Pins the shared predicate both the hero tone and the pels_status
    // producer call, so a `>` vs `>=` drift between surfaces cannot recur.
    expect(isProjectedOverHardCap({ projectedKWh: 5.0, hardCapKWh: 5.0 })).toBe(false);
    expect(isProjectedOverHardCap({ projectedKWh: 5.01, hardCapKWh: 5.0 })).toBe(true);
  });

  it('never escalates when no cap value is known', () => {
    expect(isProjectedOverHardCap({ projectedKWh: 99, hardCapKWh: null })).toBe(false);
    expect(isProjectedOverHardCap({ projectedKWh: 99, hardCapKWh: undefined })).toBe(false);
  });
});
