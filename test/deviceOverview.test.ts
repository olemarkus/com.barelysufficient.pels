import {
  buildDeviceOverviewTransitionSignature,
  formatDeviceOverview,
} from '../packages/shared-domain/src/deviceOverview';

describe('device overview formatter', () => {
  it('formats active devices with measured and expected power', () => {
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: 'keep',
      measuredPowerKw: 0,
      expectedPowerKw: 3,
    })).toEqual({
      powerMsg: 'on',
      stateMsg: 'Active',
      usageMsg: 'Measured: 0.00 kW / Expected: 3.00 kW',
      statusMsg: 'keep',
    });
  });

  it('formats inactive devices', () => {
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'inactive',
      reason: 'inactive',
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Inactive',
      usageMsg: 'Unknown',
      statusMsg: 'inactive',
    });
  });

  it('formats unplugged chargers without changing semantics', () => {
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'inactive',
      reason: 'inactive (charger is unplugged)',
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Inactive',
      usageMsg: 'Unknown',
      statusMsg: 'inactive (charger is unplugged)',
    });
  });

  it('formats shed and cooldown style statuses', () => {
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'shed',
      reason: 'cooldown (restore, 10s remaining)',
      shedAction: 'turn_off',
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Shed (restore cooldown)',
      usageMsg: 'Unknown',
      statusMsg: 'cooldown (restore, 10s remaining)',
    });

    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: 'cooldown (restore, 10s remaining)',
    }).statusMsg).toBe('stabilizing after restore (10s remaining)');
  });

  it('formats stepped-load devices with desired step labels', () => {
    expect(formatDeviceOverview({
      controlModel: 'stepped_load',
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'set_step',
      selectedStepId: 'low',
      desiredStepId: 'max',
      planningPowerKw: 3,
      measuredPowerKw: 0,
      reason: 'shed due to capacity',
    })).toEqual({
      powerMsg: null,
      stateMsg: 'Shed to max',
      usageMsg: 'Measured: 0.00 kW / Expected: 3.00 kW (low → max)',
      statusMsg: 'shed due to capacity',
    });
  });

  it('handles missing optional values consistently', () => {
    expect(formatDeviceOverview({
      currentState: 'unknown',
      plannedState: 'keep',
    })).toEqual({
      powerMsg: 'unknown',
      stateMsg: 'State unknown',
      usageMsg: 'Unknown',
      statusMsg: 'Waiting for headroom',
    });
  });
});

describe('device overview transition signatures', () => {
  it('ignores usage-only changes', () => {
    const base = formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: 'keep',
      measuredPowerKw: 0,
      expectedPowerKw: 1,
    });
    const usageOnly = formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: 'keep',
      measuredPowerKw: 0.25,
      expectedPowerKw: 1,
    });

    expect(base.usageMsg).not.toBe(usageOnly.usageMsg);
    expect(buildDeviceOverviewTransitionSignature(base))
      .toBe(buildDeviceOverviewTransitionSignature(usageOnly));
  });

  it('changes when power, state, or status changes', () => {
    const base = formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: 'keep',
      measuredPowerKw: 0,
      expectedPowerKw: 1,
    });

    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature(formatDeviceOverview({
        currentState: 'off',
        plannedState: 'keep',
        reason: 'keep',
        measuredPowerKw: 0,
        expectedPowerKw: 1,
      })),
    );
    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature(formatDeviceOverview({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off',
        reason: 'keep',
        measuredPowerKw: 0,
        expectedPowerKw: 1,
      })),
    );
    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature(formatDeviceOverview({
        currentState: 'on',
        plannedState: 'keep',
        reason: 'restore throttled',
        measuredPowerKw: 0,
        expectedPowerKw: 1,
      })),
    );
  });
});
