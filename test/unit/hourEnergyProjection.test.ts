import {
  computeProjectedHourEnergyKWh,
  computeProjectedPeriodEnergyKWh,
  isProjectedOverHardCap,
} from '../../packages/shared-domain/src/hourEnergyProjection';

describe('computeProjectedHourEnergyKWh', () => {
  it('projects used energy plus the current draw over the remaining minutes', () => {
    expect(computeProjectedHourEnergyKWh({
      usedKWh: 1.9,
      totalKw: 5.2,
      minutesRemainingInHour: 30,
    })).toBeCloseTo(4.5, 5);
  });

  it('returns the used energy at the hour boundary (no minutes remaining)', () => {
    expect(computeProjectedHourEnergyKWh({
      usedKWh: 3.4,
      totalKw: 9,
      minutesRemainingInHour: 0,
    })).toBeCloseTo(3.4, 5);
  });

  it('keeps billed import unchanged while the home exports', () => {
    expect(computeProjectedHourEnergyKWh({
      usedKWh: 0.3,
      totalKw: -2.0,
      minutesRemainingInHour: 46,
    })).toBeCloseTo(0.3, 8);
  });
});

describe('computeProjectedPeriodEnergyKWh', () => {
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
