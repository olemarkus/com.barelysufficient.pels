import { sumControlledUsageKw } from '../lib/plan/planUsage';

describe('sumControlledUsageKw', () => {
  it('returns 0 when no controllable devices are present', () => {
    const result = sumControlledUsageKw([
      { controllable: false, measuredPowerKw: 1 },
      { controllable: false },
    ]);

    expect(result).toBe(0);
  });

  it('returns null when controllable devices have no usage data', () => {
    const result = sumControlledUsageKw([
      { controllable: true },
      { controllable: undefined },
    ]);

    expect(result).toBeNull();
  });

  it('sums measured or expected usage for controllable devices', () => {
    const result = sumControlledUsageKw([
      { controllable: true, measuredPowerKw: 1.2 },
      { controllable: true, expectedPowerKw: 0.8 },
      { controllable: false, measuredPowerKw: 10 },
    ]);

    expect(result).toBeCloseTo(2.0, 6);
  });
});
