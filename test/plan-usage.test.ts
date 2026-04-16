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

  it('keeps measured off-state draw when present before falling back to controlled demand', () => {
    const result = sumControlledUsageKw([
      { controllable: true, currentState: 'off', measuredPowerKw: 0.15, expectedPowerKw: 1.2 },
      { controllable: true, currentState: 'off', expectedPowerKw: 0.8 },
    ]);

    expect(result).toBeCloseTo(0.95, 6);
  });

  it('uses planning demand for off devices when telemetry is absent', () => {
    const result = sumControlledUsageKw([
      { controllable: true, currentState: 'off', expectedPowerKw: 1.2, planningPowerKw: 1.4 },
    ]);

    expect(result).toBe(1.4);
  });

  it('uses the same off-device demand fallback for snapshot-shaped devices', () => {
    const result = sumControlledUsageKw([
      { controllable: true, currentOn: false, expectedPowerKw: 1.2, planningPowerKw: 1.4 },
    ]);

    expect(result).toBe(1.4);
  });

  it('preserves unknown usage when currentOn is false but the live state is explicitly unknown', () => {
    const result = sumControlledUsageKw([
      { controllable: true, currentOn: false, currentState: 'unknown', expectedPowerKw: 1.2 },
    ]);

    expect(result).toBeCloseTo(1.2, 6);
  });
  it('preserves measured usage for shed devices so live draw is still counted', () => {
    const result = sumControlledUsageKw([
      { controllable: true, plannedState: 'shed', measuredPowerKw: 0.4, expectedPowerKw: 1.2 },
      { controllable: true, measuredPowerKw: 0.6 },
    ]);

    expect(result).toBeCloseTo(1.0, 6);
  });

  it('keeps shed-device accounting aligned with the shared live-usage helper for unknown live state', () => {
    const result = sumControlledUsageKw([
      { controllable: true, plannedState: 'shed', currentState: 'unknown', expectedPowerKw: 1.2 },
    ]);

    expect(result).toBeNull();
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

  it('treats shed target-only devices explicitly observed off as zero controlled usage', () => {
    expect(splitControlledUsageKw({
      totalKw: 1.25,
      devices: [
        {
          controllable: true,
          plannedState: 'shed',
          currentState: 'not_applicable',
          currentOn: false,
          expectedPowerKw: 1.25,
        },
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

  it('does not produce negative controlled usage when the total is negative', () => {
    expect(splitControlledUsageKw({
      totalKw: -1,
      devices: [
        { controllable: true, measuredPowerKw: 0.7 },
        { controllable: true, expectedPowerKw: 0.8 },
      ],
    })).toEqual({
      controlledKw: 0,
      uncontrolledKw: 0,
    });
  });
});
