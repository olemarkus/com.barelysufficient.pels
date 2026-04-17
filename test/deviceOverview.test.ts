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
      targetStepId: 'max',
      planningPowerKw: 3,
      measuredPowerKw: 0,
      reason: 'shed due to capacity',
    })).toEqual({
      powerMsg: null,
      stateMsg: 'Shed to max',
      usageMsg: 'Measured: 0.00 kW / Expected: 3.00 kW (target: max)',
      statusMsg: 'shed due to capacity',
    });
  });

  it('formats reported stepped-load feedback as confirmed observed state', () => {
    expect(formatDeviceOverview({
      controlModel: 'stepped_load',
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      targetStepId: 'max',
      planningPowerKw: 3,
      measuredPowerKw: 0,
      reason: 'keep',
    }).usageMsg).toBe('Measured: 0.00 kW / Expected: 3.00 kW (reported: low / target: max)');
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
    expect(buildDeviceOverviewTransitionSignature({ ...base, reason: 'keep' }))
      .toBe(buildDeviceOverviewTransitionSignature({ ...usageOnly, reason: 'keep' }));
  });

  it('ignores countdown-only cooldown and backoff changes', () => {
    const restoreCooldown = formatDeviceOverview({
      currentState: 'off',
      plannedState: 'shed',
      reason: 'cooldown (restore, 30s remaining)',
      shedAction: 'turn_off',
    });
    const restoreCooldownTick = formatDeviceOverview({
      currentState: 'off',
      plannedState: 'shed',
      reason: 'cooldown (restore, 24s remaining)',
      shedAction: 'turn_off',
    });
    const activationBackoff = formatDeviceOverview({
      currentState: 'off',
      plannedState: 'shed',
      reason: 'activation backoff (1535s remaining)',
      shedAction: 'turn_off',
    });
    const activationBackoffTick = formatDeviceOverview({
      currentState: 'off',
      plannedState: 'shed',
      reason: 'activation backoff (1503s remaining)',
      shedAction: 'turn_off',
    });

    expect(buildDeviceOverviewTransitionSignature({
      ...restoreCooldown,
      reason: 'cooldown (restore, 30s remaining)',
    })).toBe(buildDeviceOverviewTransitionSignature({
      ...restoreCooldownTick,
      reason: 'cooldown (restore, 24s remaining)',
    }));
    expect(buildDeviceOverviewTransitionSignature({
      ...activationBackoff,
      reason: 'activation backoff (1535s remaining)',
    })).toBe(buildDeviceOverviewTransitionSignature({
      ...activationBackoffTick,
      reason: 'activation backoff (1503s remaining)',
    }));
  });

  it('preserves semantic headroom-cooldown changes while ignoring countdown decay', () => {
    const base = formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: 'headroom cooldown (45s remaining; usage 6.00 -> 3.50kW)',
    });
    const countdownOnly = formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: 'headroom cooldown (30s remaining; usage 6.00 -> 3.50kW)',
    });
    const usageChanged = formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: 'headroom cooldown (30s remaining; usage 5.50 -> 3.50kW)',
    });

    expect(buildDeviceOverviewTransitionSignature({
      ...base,
      reason: 'headroom cooldown (45s remaining; usage 6.00 -> 3.50kW)',
    })).toBe(buildDeviceOverviewTransitionSignature({
      ...countdownOnly,
      reason: 'headroom cooldown (30s remaining; usage 6.00 -> 3.50kW)',
    }));
    expect(buildDeviceOverviewTransitionSignature({
      ...base,
      reason: 'headroom cooldown (45s remaining; usage 6.00 -> 3.50kW)',
    })).not.toBe(buildDeviceOverviewTransitionSignature({
      ...usageChanged,
      reason: 'headroom cooldown (30s remaining; usage 5.50 -> 3.50kW)',
    }));
  });

  it('changes when power, state, or status changes', () => {
    const base = formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: 'keep',
      measuredPowerKw: 0,
      expectedPowerKw: 1,
    });

    expect(buildDeviceOverviewTransitionSignature({ ...base, reason: 'keep' })).not.toBe(
      buildDeviceOverviewTransitionSignature({
        ...formatDeviceOverview({
          currentState: 'off',
          plannedState: 'keep',
          reason: 'keep',
          measuredPowerKw: 0,
          expectedPowerKw: 1,
        }),
        reason: 'keep',
      }),
    );
    expect(buildDeviceOverviewTransitionSignature({ ...base, reason: 'keep' })).not.toBe(
      buildDeviceOverviewTransitionSignature({
        ...formatDeviceOverview({
          currentState: 'on',
          plannedState: 'shed',
          shedAction: 'turn_off',
          reason: 'keep',
          measuredPowerKw: 0,
          expectedPowerKw: 1,
        }),
        reason: 'keep',
      }),
    );
    expect(buildDeviceOverviewTransitionSignature({ ...base, reason: 'keep' })).not.toBe(
      buildDeviceOverviewTransitionSignature({
        ...formatDeviceOverview({
          currentState: 'on',
          plannedState: 'keep',
          reason: 'restore throttled',
          measuredPowerKw: 0,
          expectedPowerKw: 1,
        }),
        reason: 'restore throttled',
      }),
    );
  });

  it('changes when stepped observed-vs-target semantics change', () => {
    const base = formatDeviceOverview({
      controlModel: 'stepped_load',
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      targetStepId: 'low',
      reason: 'keep',
    });

    expect(buildDeviceOverviewTransitionSignature({
      ...base,
      reason: 'keep',
      reportedStepId: 'low',
      targetStepId: 'low',
    })).not.toBe(buildDeviceOverviewTransitionSignature({
      ...formatDeviceOverview({
        controlModel: 'stepped_load',
        currentState: 'on',
        plannedState: 'keep',
        reportedStepId: 'low',
        targetStepId: 'max',
        reason: 'keep',
      }),
      reason: 'keep',
      reportedStepId: 'low',
      targetStepId: 'max',
    }));
  });
});
