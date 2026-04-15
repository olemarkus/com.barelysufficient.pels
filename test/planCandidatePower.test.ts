import { resolveCandidatePower } from '../lib/plan/planCandidatePower';

describe('resolveCandidatePower', () => {
  it('uses measured power when positive', () => {
    expect(resolveCandidatePower({ measuredPowerKw: 0.8, expectedPowerKw: 2, powerKw: 3 })).toBeCloseTo(0.8, 6);
  });

  it('treats explicit zero expected power as zero', () => {
    expect(resolveCandidatePower({ expectedPowerKw: 0, powerKw: 2 })).toBe(0);
  });

  it('ignores negative expected power and falls back to configured power', () => {
    expect(resolveCandidatePower({ expectedPowerKw: -1, powerKw: 1.6 })).toBeCloseTo(1.6, 6);
  });

  it('ignores negative expected and configured power and uses fallback', () => {
    expect(resolveCandidatePower({ expectedPowerKw: -1, powerKw: -2 })).toBe(1);
  });

  it('keeps the same preference order across non-measured power sources', () => {
    expect(resolveCandidatePower({ expectedPowerKw: 1.4, planningPowerKw: 1.8, powerKw: 2.2 }))
      .toBeCloseTo(1.4, 6);
  });
});
