import {
  buildDeviceOverviewTransitionSignature,
  formatDeviceOverview,
  getDeviceOverviewReportedStepId,
  isDeviceOverviewSteppedModeTransition,
} from '../packages/shared-domain/src/deviceOverview';
import { PLAN_REASON_CODES } from '../packages/shared-domain/src/planReasonSemantics';
import { legacyDeviceReason } from './utils/deviceReasonTestUtils';

const r = legacyDeviceReason;

describe('device overview formatter', () => {
  it('formats active devices with measured and expected power', () => {
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
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
      reason: r('inactive'),
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
      reason: r('inactive (charger is unplugged)'),
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Inactive',
      usageMsg: 'Unknown',
      statusMsg: 'inactive (charger is unplugged)',
    });
  });

  it('formats keep devices blocked by meter settling without inventing shed state', () => {
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'keep',
      reason: r('meter settling (10s remaining)'),
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Restoring',
      usageMsg: 'Unknown',
      statusMsg: 'waiting for meter to settle (10s remaining)',
    });

    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'shed',
      reason: r('cooldown (restore, 10s remaining)'),
      shedAction: 'turn_off',
    })).toEqual({
      powerMsg: 'on → off',
      stateMsg: 'Shed (powered off)',
      usageMsg: 'Unknown',
      statusMsg: 'cooldown (restore, 10s remaining)',
    });
  });

  it('keeps stabilizing rewrites for keep devices only', () => {
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('meter settling (10s remaining)'),
    }).statusMsg).toBe('waiting for meter to settle (10s remaining)');
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('cooldown (restore, 10s remaining)'),
    }).statusMsg).toBe('waiting for meter to settle (10s remaining)');
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
      reason: r('shed due to capacity'),
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
      reason: r('keep'),
    }).usageMsg).toBe('Measured: 0.00 kW / Expected: 3.00 kW (reported: low / target: max)');
  });

  it('treats on-like stepped step changes as active mode transitions', () => {
    expect(formatDeviceOverview({
      controlModel: 'stepped_load',
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      targetStepId: 'max',
      planningPowerKw: 3,
      measuredPowerKw: 0.6,
      reason: r('cooldown (restore, 10s remaining)'),
    })).toEqual({
      powerMsg: null,
      stateMsg: 'Active (low → max)',
      usageMsg: 'Measured: 0.60 kW / Expected: 3.00 kW (reported: low / target: max)',
      statusMsg: 'waiting for meter to settle (10s remaining)',
    });
  });

  it('keeps off-like stepped restores in restoring state', () => {
    expect(formatDeviceOverview({
      controlModel: 'stepped_load',
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'low',
      targetStepId: 'low',
      planningPowerKw: 1.25,
      reason: r('restore off -> low (need 1.25kW)'),
    }).stateMsg).toBe('Restoring');
  });

  it('keeps steady on-like stepped devices active without a transition arrow', () => {
    expect(formatDeviceOverview({
      controlModel: 'stepped_load',
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      targetStepId: 'low',
      planningPowerKw: 1.25,
      measuredPowerKw: 0.4,
      reason: r('keep'),
    })).toEqual({
      powerMsg: null,
      stateMsg: 'Active',
      usageMsg: 'Measured: 0.40 kW / Expected: 1.25 kW (reported: low)',
      statusMsg: 'keep',
    });
  });

  it('does not treat disappeared stepped devices as active mode transitions', () => {
    const device = {
      controlModel: 'stepped_load' as const,
      currentState: 'disappeared',
      plannedState: 'keep',
      reportedStepId: 'low',
      targetStepId: 'max',
      planningPowerKw: 3,
      measuredPowerKw: 0.6,
      reason: r('cooldown (restore, 10s remaining)'),
    };

    expect(isDeviceOverviewSteppedModeTransition(device)).toBe(false);
    expect(formatDeviceOverview(device)).toEqual({
      powerMsg: null,
      stateMsg: 'State unknown',
      usageMsg: 'Measured: 0.60 kW / Expected: 3.00 kW (reported: low / target: max)',
      statusMsg: 'waiting for meter to settle (10s remaining)',
    });
  });

  it('does not treat unavailable stepped devices as active mode transitions', () => {
    const device = {
      controlModel: 'stepped_load' as const,
      currentState: 'on',
      plannedState: 'keep',
      available: false,
      reportedStepId: 'low',
      targetStepId: 'max',
      planningPowerKw: 3,
      measuredPowerKw: 0.6,
      reason: r('cooldown (restore, 10s remaining)'),
    };

    expect(isDeviceOverviewSteppedModeTransition(device)).toBe(false);
    expect(formatDeviceOverview(device)).toEqual({
      powerMsg: null,
      stateMsg: 'Unavailable',
      usageMsg: 'Measured: 0.60 kW / Expected: 3.00 kW (reported: low / target: max)',
      statusMsg: 'waiting for meter to settle (10s remaining)',
    });
  });

  it('does not treat stale stepped devices as active mode transitions', () => {
    expect(isDeviceOverviewSteppedModeTransition({
      controlModel: 'stepped_load',
      currentState: 'on',
      plannedState: 'keep',
      observationStale: true,
      reportedStepId: 'low',
      targetStepId: 'max',
    })).toBe(false);
  });

  it('prefers the latest confirmed reported step when stale reportedStepId lags actualStepId', () => {
    const device = {
      controlModel: 'stepped_load' as const,
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      actualStepId: 'max',
      actualStepSource: 'reported' as const,
      targetStepId: 'max',
      planningPowerKw: 3,
      measuredPowerKw: 0,
      reason: r('keep'),
    };

    expect(getDeviceOverviewReportedStepId(device)).toBe('max');
    expect(formatDeviceOverview(device).usageMsg)
      .toBe('Measured: 0.00 kW / Expected: 3.00 kW (reported: max)');
  });

  it('handles missing optional values consistently', () => {
    expect(formatDeviceOverview({
      currentState: 'unknown',
      plannedState: 'keep',
      reason: { code: PLAN_REASON_CODES.none },
    })).toEqual({
      powerMsg: 'unknown',
      stateMsg: 'State unknown',
      usageMsg: 'Unknown',
      statusMsg: 'Waiting for headroom',
    });
  });
});

describe('device overview transition signatures', () => {
  it('changes on usage-only changes', () => {
    const base = {
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      measuredPowerKw: 0,
      expectedPowerKw: 1,
    };
    const usageOnly = {
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      measuredPowerKw: 0.25,
      expectedPowerKw: 1,
    };

    expect(formatDeviceOverview(base).usageMsg).not.toBe(formatDeviceOverview(usageOnly).usageMsg);
    expect(buildDeviceOverviewTransitionSignature(base))
      .not.toBe(buildDeviceOverviewTransitionSignature(usageOnly));
  });

  it('ignores countdown-only cooldown and backoff changes', () => {
    const restoreCooldown = {
      currentState: 'off',
      plannedState: 'keep',
      reason: r('meter settling (30s remaining)'),
    };
    const restoreCooldownTick = {
      currentState: 'off',
      plannedState: 'keep',
      reason: r('meter settling (24s remaining)'),
    };
    const activationBackoff = {
      currentState: 'off',
      plannedState: 'shed',
      reason: r('activation backoff (1535s remaining)'),
      shedAction: 'turn_off',
    };
    const activationBackoffTick = {
      currentState: 'off',
      plannedState: 'shed',
      reason: r('activation backoff (1503s remaining)'),
      shedAction: 'turn_off',
    };

    expect(buildDeviceOverviewTransitionSignature(restoreCooldown))
      .toBe(buildDeviceOverviewTransitionSignature(restoreCooldownTick));
    expect(buildDeviceOverviewTransitionSignature(activationBackoff))
      .toBe(buildDeviceOverviewTransitionSignature(activationBackoffTick));
  });

  it('ignores countdown-only legacy restore cooldown changes', () => {
    const restoreCooldown = {
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'turn_off',
      reason: r('cooldown (restore, 30s remaining)'),
    };
    const restoreCooldownTick = {
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'turn_off',
      reason: r('cooldown (restore, 24s remaining)'),
    };

    expect(buildDeviceOverviewTransitionSignature(restoreCooldown))
      .toBe(buildDeviceOverviewTransitionSignature(restoreCooldownTick));
  });

  it('preserves semantic recent-PELS headroom-cooldown changes while ignoring countdown decay', () => {
    const base = {
      currentState: 'on',
      plannedState: 'keep',
      reason: r('headroom cooldown (45s remaining; recent PELS shed)'),
    };
    const countdownOnly = {
      currentState: 'on',
      plannedState: 'keep',
      reason: r('headroom cooldown (30s remaining; recent PELS shed)'),
    };
    const sourceChanged = {
      currentState: 'on',
      plannedState: 'keep',
      reason: r('headroom cooldown (30s remaining; recent PELS restore)'),
    };

    expect(buildDeviceOverviewTransitionSignature(base))
      .toBe(buildDeviceOverviewTransitionSignature(countdownOnly));
    expect(buildDeviceOverviewTransitionSignature(base))
      .not.toBe(buildDeviceOverviewTransitionSignature(sourceChanged));
  });

  it('changes when power, state, or status changes', () => {
    const base = {
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      measuredPowerKw: 0,
      expectedPowerKw: 1,
    };

    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature({
        currentState: 'off',
        plannedState: 'keep',
        reason: r('keep'),
        measuredPowerKw: 0,
        expectedPowerKw: 1,
      }),
    );
    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off',
        reason: r('keep'),
        measuredPowerKw: 0,
        expectedPowerKw: 1,
      }),
    );
    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature({
        currentState: 'on',
        plannedState: 'keep',
        reason: r('restore throttled'),
        measuredPowerKw: 0,
        expectedPowerKw: 1,
      }),
    );
  });

  it('changes when stepped observed-vs-target semantics change', () => {
    const base = {
      controlModel: 'stepped_load',
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      targetStepId: 'low',
      reason: r('keep'),
    };

    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(buildDeviceOverviewTransitionSignature({
        controlModel: 'stepped_load',
        currentState: 'on',
        plannedState: 'keep',
        reportedStepId: 'low',
        targetStepId: 'max',
        reason: r('keep'),
    }));
  });
});
