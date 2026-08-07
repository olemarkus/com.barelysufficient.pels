import {
  buildDeviceOverviewTransitionSignature,
  formatDeviceOverview,
  getDeviceOverviewReportedStepId,
  isDeviceOverviewSteppedModeTransition,
} from '../../packages/shared-domain/src/deviceOverview';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { PLAN_STATE_CAPACITY_STATUS } from '../../packages/shared-domain/src/planStateLabels';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';

const r = (reason: string): DeviceReason => fixtureDeviceReason(reason)!;

describe('overview transition signature', () => {
  // Regression (PR #1955 review, Copilot + Codex): a satisfied target-only
  // thermostat's Running ↔ Idle flip can have the temperature as its only
  // changed input; the signature must carry the RESOLVED state kind so the
  // device log records the transition (and only the transition — sub-epsilon
  // temperature wobble must not change the signature).
  it('changes when the satisfied-idle classification flips, not on sub-epsilon wobble', () => {
    const base = {
      currentState: 'not_applicable',
      plannedState: 'keep',
      reason: r('keep'),
      controllable: true,
      available: true,
      measuredPowerKw: 0,
      currentTarget: 16,
    };
    const running = buildDeviceOverviewTransitionSignature({ ...base, currentTemperature: 14 });
    const idle = buildDeviceOverviewTransitionSignature({ ...base, currentTemperature: 20.8 });
    const idleWobble = buildDeviceOverviewTransitionSignature({ ...base, currentTemperature: 20.9 });
    expect(idle).not.toBe(running);
    expect(idleWobble).toBe(idle);
  });
});

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
      statusMsg: '',
    });
  });

  // The chip text must stay in lockstep with the resolved state word: a
  // satisfied target-only device is stamped `idle`, so an idle-toned chip
  // reading "Active (temperature-managed)" would contradict the card.
  it('formats a satisfied target-only keep device as Idle, unsatisfied as Active (temperature-managed)', () => {
    const base = {
      currentState: 'not_applicable',
      plannedState: 'keep',
      reason: r('keep'),
      measuredPowerKw: 0,
      expectedPowerKw: 1,
      currentTarget: 16,
    };
    expect(formatDeviceOverview({ ...base, currentTemperature: 20.8 }).stateMsg).toBe('Idle');
    expect(formatDeviceOverview({ ...base, currentTemperature: 14.2 }).stateMsg)
      .toBe('Active (temperature-managed)');
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
      statusMsg: 'Off for now',
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
      statusMsg: 'Off for now (charger is unplugged)',
    });
  });

  it('adds EV battery SoC details to status text without changing control state', () => {
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_charging',
      stateOfCharge: {
        percent: 42,
        status: 'fresh',
      },
      reason: r('keep'),
    }).statusMsg).toBe('EV battery: 42 %');

    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'inactive',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
      stateOfCharge: {
        percent: 42,
        status: 'stale',
      },
      reason: r('inactive'),
    }).statusMsg).toBe('Off for now — EV battery: 42 %, stale');
  });

  it('formats legacy keep devices blocked by meter settling without inventing shed state', () => {
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'keep',
      reason: r('meter settling (10s remaining)'),
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Resuming',
      usageMsg: 'Unknown',
      statusMsg: 'Waiting for power meter to stabilise (10s)',
    });

    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'shed',
      reason: r('cooldown (restore, 10s remaining)'),
      shedAction: 'turn_off',
    })).toEqual({
      powerMsg: 'on → off',
      stateMsg: 'Turned off',
      usageMsg: 'Unknown',
      statusMsg: 'Waiting before resuming (10s)',
    });
  });

  it('formats shed devices blocked by meter settling as held off', () => {
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'shed',
      reason: r('meter settling (10s remaining)'),
      shedAction: 'turn_off',
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Turned off',
      usageMsg: 'Unknown',
      statusMsg: 'Waiting for power meter to stabilise (10s)',
    });
  });

  it('keeps meter settling copy distinct from restore cooldown copy', () => {
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('meter settling (10s remaining)'),
    }).statusMsg).toBe('Waiting for power meter to stabilise (10s)');
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('cooldown (restore, 10s remaining)'),
    }).statusMsg).toBe('Waiting before resuming (10s)');
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
      stateMsg: 'Limited to max',
      usageMsg: 'Measured: 0.00 kW / Expected: 3.00 kW (target: max)',
      statusMsg: PLAN_STATE_CAPACITY_STATUS,
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
      statusMsg: 'Waiting before resuming (10s)',
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
    }).stateMsg).toBe('Resuming');
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
      statusMsg: '',
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
      statusMsg: 'Waiting before resuming (10s)',
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
      statusMsg: 'Waiting before resuming (10s)',
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
      reason: r('keep'),
    })).toBe(false);
  });

  it('surfaces the confirmed reported step in the usage line', () => {
    const device = {
      controlModel: 'stepped_load' as const,
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'max',
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
      statusMsg: 'Waiting for available power',
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

  it('changes when surplusAbsorbActive flips even if the normalized target is unchanged', () => {
    // The "Raised to use your solar power" reason line is driven by surplusAbsorbActive, so a
    // flip must re-render the card even when nothing else (target, state, reason.code) moved —
    // otherwise the line goes stale until some unrelated plan change.
    const withoutSurplus = {
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      measuredPowerKw: 1,
      expectedPowerKw: 1,
      surplusAbsorbActive: false,
    };
    const withSurplus = { ...withoutSurplus, surplusAbsorbActive: true };
    expect(buildDeviceOverviewTransitionSignature(withoutSurplus))
      .not.toBe(buildDeviceOverviewTransitionSignature(withSurplus));
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
      shedAction: 'turn_off' as const,
    };
    const activationBackoffTick = {
      currentState: 'off',
      plannedState: 'shed',
      reason: r('activation backoff (1503s remaining)'),
      shedAction: 'turn_off' as const,
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
      shedAction: 'turn_off' as const,
      reason: r('cooldown (restore, 30s remaining)'),
    };
    const restoreCooldownTick = {
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
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

  it('ignores shortfall jitter in overview transition signatures', () => {
    const base = {
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
      reason: r('shortfall (need 1.21kW, headroom -1.23kW)'),
    };
    const jitterOnly = {
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
      reason: r('shortfall (need 1.24kW, headroom -1.24kW)'),
    };

    expect(buildDeviceOverviewTransitionSignature(base))
      .toBe(buildDeviceOverviewTransitionSignature(jitterOnly));
  });

  // Since `finalizeCeilingReason` attaches a pace-relative `shortfallKw` to
  // every ceiling hold each cycle, the exclusion must hold for all carriers —
  // the gap moves with `softLimitKw − totalKw`, so including it would flip the
  // signature on most rebuilds and flood the device-log ring buffer.
  it('ignores shortfall jitter on capacity, budget, and swap carriers', () => {
    const withGap = (reason: DeviceReason) => ({
      currentState: 'off',
      plannedState: 'shed' as const,
      shedAction: 'turn_off' as const,
      reason,
    });
    const carriers = [
      [{ code: 'capacity', detail: null, shortfallKw: 1.2 }, { code: 'capacity', detail: null, shortfallKw: 2.7 }],
      [
        { code: 'daily_budget', detail: null, shortfallKw: 0.8 },
        { code: 'daily_budget', detail: null, shortfallKw: 1.1 },
      ],
      [
        { code: 'swapped_out', targetName: 'Water heater', shortfallKw: 0.7 },
        { code: 'swapped_out', targetName: 'Water heater', shortfallKw: 1.3 },
      ],
    ] as const;
    for (const [a, b] of carriers) {
      expect(buildDeviceOverviewTransitionSignature(withGap(a)))
        .toBe(buildDeviceOverviewTransitionSignature(withGap(b)));
    }
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
        shedAction: 'turn_off' as const,
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
      controlModel: 'stepped_load' as const,
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      targetStepId: 'low',
      reason: r('keep'),
    };

    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(buildDeviceOverviewTransitionSignature({
        controlModel: 'stepped_load' as const,
        currentState: 'on',
        plannedState: 'keep',
        reportedStepId: 'low',
        targetStepId: 'max',
        reason: r('keep'),
    }));
  });

});
