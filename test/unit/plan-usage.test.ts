import { splitControlledUsageKw, sumControlledUsageKw } from '../../lib/plan/planUsage';

// Managed-usage attribution is one rule now: sum `currentDrawKw` over the
// devices PELS controls. The specs that used to pin the shed / observed-off /
// observed-on ladders are gone with the ladders — a plan device can no longer
// arrive without a reading, so there is no branch left for them to pin.
describe('sumControlledUsageKw', () => {
  it('returns 0 when no controllable devices are present', () => {
    const result = sumControlledUsageKw([
      { expectedPowerKw: 1, controllable: false, currentDrawKw: 1 },
      { expectedPowerKw: 1, currentDrawKw: 3, controllable: false },
    ]);

    expect(result).toBe(0);
  });

  it('sums the resolved draw of every controllable device', () => {
    const result = sumControlledUsageKw([
      { expectedPowerKw: 1, controllable: true, currentDrawKw: 1.2 },
      { expectedPowerKw: 1, currentDrawKw: 0.8, controllable: true },
      { expectedPowerKw: 1, controllable: false, currentDrawKw: 10 },
    ]);

    expect(result).toBeCloseTo(2.0, 6);
  });

  it('treats an undefined `controllable` as controllable, matching the planner filter', () => {
    expect(sumControlledUsageKw([{ expectedPowerKw: 1, currentDrawKw: 0.4, controllable: undefined }]))
      .toBeCloseTo(0.4, 6);
  });

  it('books a device measuring zero at zero, whatever its plan state or nameplate', () => {
    // The defect this replaces: an observed-off device measuring a true 0 W fell
    // through to `getHighestKnownPowerKw` and was credited its RATED power, which
    // `sampleIngest` then wrote into the persisted managed/background split.
    const result = sumControlledUsageKw([
      {
        controllable: true,
        plannedState: 'keep',
        currentOn: false,
        currentDrawKw: 0,
        planningPowerKw: 1.4,
        expectedPowerKw: 2.5,
      },
    ]);

    expect(result).toBe(0);
  });

  it('keeps counting a shed device that is still drawing', () => {
    const result = sumControlledUsageKw([
      { controllable: true, plannedState: 'shed', currentDrawKw: 0.4, expectedPowerKw: 1.2 },
      { expectedPowerKw: 1, controllable: true, currentDrawKw: 0.6 },
    ]);

    expect(result).toBeCloseTo(1.0, 6);
  });

  it('caps controlled usage at totalKw when splitting controlled and uncontrolled usage', () => {
    expect(splitControlledUsageKw({
      totalKw: 1,
      devices: [
        { expectedPowerKw: 1, controllable: true, currentDrawKw: 0.7 },
        { expectedPowerKw: 1, currentDrawKw: 0.8, controllable: true },
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
        { expectedPowerKw: 1, controllable: true, currentDrawKw: 0.7 },
        { expectedPowerKw: 1, currentDrawKw: 0.8, controllable: true },
      ],
    })).toEqual({
      controlledKw: 0,
      uncontrolledKw: 0,
    });
  });

});
