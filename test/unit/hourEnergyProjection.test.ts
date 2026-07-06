import { computeProjectedHourEnergyKWh, isProjectedOverHardCap } from '../../packages/shared-domain/src/hourEnergyProjection';

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

  it('floors a net-export projection at zero — "projected" is always a used-energy figure', () => {
    expect(computeProjectedHourEnergyKWh({
      usedKWh: 0.3,
      totalKw: -2.0,
      minutesRemainingInHour: 46,
    })).toBe(0);
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
