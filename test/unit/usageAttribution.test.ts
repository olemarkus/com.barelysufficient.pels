import {
  splitControlledUsageKw,
  sumControlledUsageKw,
  sumBudgetExemptMeasuredUsageKw,
} from '../../lib/power/usageAttribution';

// Managed-usage attribution is one rule now: sum `currentDrawKw` over the
// devices PELS controls. The specs that used to pin the shed / observed-off /
// observed-on ladders are gone with the ladders — a plan device can no longer
// arrive without a reading, so there is no branch left for them to pin.
describe('sumControlledUsageKw', () => {
  it('returns 0 when no controllable devices are present', () => {
    const devices = [
      { expectedPowerKw: 1, controllable: false, currentDrawKw: 1 },
      { expectedPowerKw: 1, currentDrawKw: 3, controllable: false },
    ];
    const result = sumControlledUsageKw(devices);

    expect(result).toBe(0);
  });

  it('sums the resolved draw of every controllable device', () => {
    const devices = [
      { expectedPowerKw: 1, controllable: true, currentDrawKw: 1.2 },
      { expectedPowerKw: 1, currentDrawKw: 0.8, controllable: true },
      { expectedPowerKw: 1, controllable: false, currentDrawKw: 10 },
    ];
    const result = sumControlledUsageKw(devices);

    expect(result).toBeCloseTo(2.0, 6);
  });

  it('treats an undefined `controllable` as controllable, matching the planner filter', () => {
    const devices = [{ expectedPowerKw: 1, currentDrawKw: 0.4, controllable: undefined }];
    expect(sumControlledUsageKw(devices))
      .toBeCloseTo(0.4, 6);
  });

  it('books a device measuring zero at zero, whatever its plan state or nameplate', () => {
    // The defect this replaces: an observed-off device measuring a true 0 W fell
    // through to `getHighestKnownPowerKw` and was credited its RATED power, which
    // `sampleIngest` then wrote into the persisted managed/background split.
    const devices = [
      {
        controllable: true,
        plannedState: 'keep',
        currentOn: false,
        currentDrawKw: 0,
        planningPowerKw: 1.4,
        expectedPowerKw: 2.5,
      },
    ];
    const result = sumControlledUsageKw(devices);

    expect(result).toBe(0);
  });

  it('keeps counting a shed device that is still drawing', () => {
    const devices = [
      { controllable: true, plannedState: 'shed', currentDrawKw: 0.4, expectedPowerKw: 1.2 },
      { expectedPowerKw: 1, controllable: true, currentDrawKw: 0.6 },
    ];
    const result = sumControlledUsageKw(devices);

    expect(result).toBeCloseTo(1.0, 6);
  });

  it('caps controlled usage at totalKw when splitting controlled and uncontrolled usage', () => {
    const devices = [
      { expectedPowerKw: 1, controllable: true, currentDrawKw: 0.7 },
      { expectedPowerKw: 1, currentDrawKw: 0.8, controllable: true },
    ];
    expect(splitControlledUsageKw({
      totalKw: 1,
      devices,
    })).toEqual({
      controlledKw: 1,
      uncontrolledKw: 0,
    });
  });

  it('does not produce negative controlled usage when the total is negative', () => {
    const devices = [
      { expectedPowerKw: 1, controllable: true, currentDrawKw: 0.7 },
      { expectedPowerKw: 1, currentDrawKw: 0.8, controllable: true },
    ];
    expect(splitControlledUsageKw({
      totalKw: -1,
      devices,
    })).toEqual({
      controlledKw: 0,
      uncontrolledKw: 0,
    });
  });

});

describe('splitControlledUsageKw', () => {
  it('splits controlled and uncontrolled usage from the same helper', () => {
    const devices = [
      { expectedPowerKw: 1, currentState: 'on', currentDrawKw: 1.5, controllable: true },
      { currentDrawKw: 0.5, currentState: 'on', expectedPowerKw: 0.5, controllable: true },
      { expectedPowerKw: 1, currentState: 'on', currentDrawKw: 2, controllable: false },
    ];
    expect(splitControlledUsageKw({
      totalKw: 4,
      devices,
    })).toEqual({
      controlledKw: 2,
      uncontrolledKw: 2,
    });
  });

  it('does not treat configured fallback power as live controlled usage', () => {
    const devices = [
      { expectedPowerKw: 1, currentState: 'on', currentDrawKw: 1.5, controllable: true },
      { currentDrawKw: 0, currentState: 'on', expectedPowerKw: 1, controllable: true },
    ];
    expect(splitControlledUsageKw({
      totalKw: 4,
      devices,
    })).toEqual({
      controlledKw: 1.5,
      uncontrolledKw: 2.5,
    });
  });

  it('books a target-only device at its meter, never at its expected demand', () => {
    // A device with no on/off handle used to fall through to `expectedPowerKw`
    // because its live state was "not applicable". It has a meter like everything
    // else in the managed set, and the meter says 1.25 kW.
    const devices = [
      {
        currentDrawKw: 1.25,
        currentState: 'not_applicable',
        expectedPowerKw: 4,
        controllable: true,
      },
    ];
    expect(splitControlledUsageKw({
      totalKw: 3,
      devices,
    })).toEqual({
      controlledKw: 1.25,
      uncontrolledKw: 1.75,
    });
  });

  it('treats a measured 0 on an observed-on device as authoritative live usage (does not pad with expected demand)', () => {
    // Regression for the observed-on branch of managed-usage attribution (`sumControlledUsageKw`): when
    // measured_power reports 0 (transient sample, between thermostat duty
    // cycles), the device contributes 0 to live attribution — the expected
    // demand is reserved for restore admission, not live usage padding.
    const devices = [
      {
        controllable: true,
        plannedState: 'keep',
        currentDrawKw: 0,
        expectedPowerKw: 2,
      },
    ];
    const result = splitControlledUsageKw({
      totalKw: 5,
      devices,
    });
    expect(result.controlledKw).toBe(0);
    expect(result.uncontrolledKw).toBe(5);
  });
});

describe('sumBudgetExemptMeasuredUsageKw', () => {
  it('counts only resolved draw of budget-exempt controllable devices', () => {
    const devices = [
      { budgetExempt: true, controllable: true, currentDrawKw: 1.2 },
      { budgetExempt: true, currentDrawKw: 0.3 },
      { budgetExempt: true, controllable: false, currentDrawKw: 4 },
      { budgetExempt: false, controllable: true, currentDrawKw: 5 },
      { controllable: true, currentDrawKw: 6 },
    ] as const;
    expect(sumBudgetExemptMeasuredUsageKw(devices)).toBeCloseTo(1.5, 6);
  });

  it('does not reserve expected demand for an observed-off exempt device', () => {
    const devices = [{
      budgetExempt: true,
      currentDrawKw: 0,
      currentOn: false,
      expectedPowerKw: 2,
    }] as const;
    expect(sumBudgetExemptMeasuredUsageKw(devices)).toBe(0);
  });
});
