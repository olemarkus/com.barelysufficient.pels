import { splitControlledUsageKw, sumControlledUsageKw } from '../lib/plan/planUsage';

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

  it('prefers measured usage even when a device is currently marked off', () => {
    const result = sumControlledUsageKw([
      { controllable: true, currentState: 'off', measuredPowerKw: 0.15, expectedPowerKw: 1.2 },
      { controllable: true, currentState: 'off', expectedPowerKw: 0.8 },
    ]);

    expect(result).toBeCloseTo(0.15, 6);
  });

  it('returns zero for off devices when only expected or planning values are available', () => {
    const result = sumControlledUsageKw([
      { controllable: true, currentState: 'off', expectedPowerKw: 1.2, planningPowerKw: 1.4 },
    ]);

    expect(result).toBe(0);
  });

  it('preserves measured usage for shed devices so live draw is still counted', () => {
    const result = sumControlledUsageKw([
      { controllable: true, plannedState: 'shed', measuredPowerKw: 0.4, expectedPowerKw: 1.2 },
      { controllable: true, measuredPowerKw: 0.6 },
    ]);

    expect(result).toBeCloseTo(1.0, 6);
  });

  it('treats shed devices observed off without a measurement as zero controlled usage', () => {
    expect(splitControlledUsageKw({
      totalKw: 1.25,
      devices: [
        { controllable: true, plannedState: 'shed', currentState: 'off', expectedPowerKw: 1.25 },
      ],
    })).toEqual({
      controlledKw: 0,
      uncontrolledKw: 1.25,
    });
  });

  it('caps controlled usage at totalKw when splitting controlled and uncontrolled usage', () => {
    expect(splitControlledUsageKw({
      totalKw: 1,
      devices: [
        { controllable: true, measuredPowerKw: 0.7 },
        { controllable: true, expectedPowerKw: 0.8 },
      ],
    })).toEqual({
      controlledKw: 1,
      uncontrolledKw: 0,
    });
  });
});
