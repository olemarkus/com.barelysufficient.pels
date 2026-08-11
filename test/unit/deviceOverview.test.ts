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
      currentDrawKw: 0,
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
      currentDrawKw: 0,
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
      currentDrawKw: 0,
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
      currentDrawKw: 0,
      reason: r('inactive (charger is unplugged)'),
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Inactive',
      usageMsg: 'Measured: 0.00 kW',
      statusMsg: 'Off for now (charger is unplugged)',
    });
  });

  it('formats unplugged chargers without changing semantics', () => {
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'inactive',
      currentDrawKw: 0,
      reason: r('inactive (charger is unplugged)'),
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Inactive',
      usageMsg: 'Measured: 0.00 kW',
      statusMsg: 'Off for now (charger is unplugged)',
    });
  });

  it('adds EV battery SoC details to status text without changing control state', () => {
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_charging',
      stateOfCharge: { level: { kind: 'known', percent: 42 } },
      currentDrawKw: 0,
      reason: r('keep'),
    }).statusMsg).toBe('EV battery: 42 %');

    // Unplugged: the producer has no level, so the card shows no battery line at
    // all rather than a number carrying a qualifier ("42 %, stale") the reader
    // was invited to use anyway.
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'inactive',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
      stateOfCharge: { level: { kind: 'unavailable', reasonCode: 'not_connected' } },
      currentDrawKw: 0,
      reason: r('inactive (charger is unplugged)'),
    }).statusMsg).toBe('Off for now (charger is unplugged)');
  });

  it('formats legacy keep devices blocked by meter settling without inventing shed state', () => {
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('meter settling (10s remaining)'),
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Resuming',
      usageMsg: 'Measured: 0.00 kW',
      statusMsg: 'Waiting for power meter to stabilise (10s)',
    });

    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'shed',
      currentDrawKw: 0,
      reason: r('cooldown (restore, 10s remaining)'),
      shedAction: 'turn_off',
    })).toEqual({
      powerMsg: 'on → off',
      stateMsg: 'Turned off',
      usageMsg: 'Measured: 0.00 kW',
      statusMsg: 'Waiting to resume — 10s',
    });
  });

  it('formats shed devices blocked by meter settling as held off', () => {
    expect(formatDeviceOverview({
      currentState: 'off',
      plannedState: 'shed',
      currentDrawKw: 0,
      reason: r('meter settling (10s remaining)'),
      shedAction: 'turn_off',
    })).toEqual({
      powerMsg: 'off',
      stateMsg: 'Turned off',
      usageMsg: 'Measured: 0.00 kW',
      statusMsg: 'Waiting for power meter to stabilise (10s)',
    });
  });

  it('keeps meter settling copy distinct from restore cooldown copy', () => {
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('meter settling (10s remaining)'),
    }).statusMsg).toBe('Waiting for power meter to stabilise (10s)');
    expect(formatDeviceOverview({
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('cooldown (restore, 10s remaining)'),
    }).statusMsg).toBe('Waiting to resume — 10s');
  });

  it('formats stepped-load devices with desired step labels', () => {
    expect(formatDeviceOverview({
      controlModel: 'stepped_load',
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'set_step',
      targetStepId: 'max',
      planningPowerKw: 3,
      currentDrawKw: 0,
      reason: r('shed due to capacity'),
    })).toEqual({
      powerMsg: null,
      stateMsg: 'Limited to Max',
      usageMsg: 'Measured: 0.00 kW / Planned: 3.00 kW (target: Max)',
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
      currentDrawKw: 0,
      reason: r('keep'),
    }).usageMsg).toBe('Measured: 0.00 kW / Planned: 3.00 kW (reported: Low / target: Max)');
  });

  it('treats on-like stepped step changes as active mode transitions', () => {
    expect(formatDeviceOverview({
      controlModel: 'stepped_load',
      currentState: 'on',
      plannedState: 'keep',
      reportedStepId: 'low',
      targetStepId: 'max',
      planningPowerKw: 3,
      currentDrawKw: 0.6,
      reason: r('cooldown (restore, 10s remaining)'),
    })).toEqual({
      powerMsg: null,
      stateMsg: 'Active (low → max)',
      usageMsg: 'Measured: 0.60 kW / Planned: 3.00 kW (reported: Low / target: Max)',
      statusMsg: 'Waiting to increase — 10s',
    });
  });

  it('uses increase for a target-only stepped device at a non-off step', () => {
    expect(formatDeviceOverview({
      controlModel: 'stepped_load',
      currentState: 'not_applicable',
      plannedState: 'keep',
      reportedStepId: 'low',
      selectedStepId: 'medium',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [{ id: 'step_0', planningPowerW: 0 }, { id: 'low', planningPowerW: 1_000 }],
      },
      planningPowerKw: 2,
      currentDrawKw: 0.6,
      reason: { code: 'cooldown_restore', remainingSec: 10 },
    }).statusMsg).toBe('Waiting to increase — 10s');
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
      currentDrawKw: 0,
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
      currentDrawKw: 0.4,
      reason: r('keep'),
    })).toEqual({
      powerMsg: null,
      stateMsg: 'Active',
      usageMsg: 'Measured: 0.40 kW / Planned: 1.25 kW (reported: Low)',
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
      currentDrawKw: 0.6,
      reason: r('cooldown (restore, 10s remaining)'),
    };

    expect(isDeviceOverviewSteppedModeTransition(device)).toBe(false);
    expect(formatDeviceOverview(device)).toEqual({
      powerMsg: null,
      stateMsg: 'State unknown',
      usageMsg: 'Measured: 0.60 kW / Planned: 3.00 kW (reported: Low / target: Max)',
      statusMsg: 'Waiting to resume — 10s',
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
      currentDrawKw: 0.6,
      reason: r('cooldown (restore, 10s remaining)'),
    };

    expect(isDeviceOverviewSteppedModeTransition(device)).toBe(false);
    expect(formatDeviceOverview(device)).toEqual({
      powerMsg: null,
      stateMsg: 'Unavailable',
      usageMsg: 'Measured: 0.60 kW / Planned: 3.00 kW (reported: Low / target: Max)',
      statusMsg: 'Waiting to increase — 10s',
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
      currentDrawKw: 0,
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
      currentDrawKw: 0,
      reason: r('keep'),
    };

    expect(getDeviceOverviewReportedStepId(device)).toBe('max');
    expect(formatDeviceOverview(device).usageMsg)
      .toBe('Measured: 0.00 kW / Planned: 3.00 kW (reported: Max)');
  });

  it('handles missing optional values consistently', () => {
    expect(formatDeviceOverview({
      currentState: 'unknown',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    })).toEqual({
      powerMsg: 'unknown',
      stateMsg: 'State unknown',
      usageMsg: 'Measured: 0.00 kW',
      statusMsg: '',
    });
  });
});

describe('device overview transition signatures', () => {
  it('changes on usage-only changes', () => {
    const base = {
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      currentDrawKw: 0,
      expectedPowerKw: 1,
    };
    const usageOnly = {
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      currentDrawKw: 0.25,
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
      currentDrawKw: 1,
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
      currentDrawKw: 0,
      reason: r('meter settling (30s remaining)'),
    };
    const restoreCooldownTick = {
      currentState: 'off',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('meter settling (24s remaining)'),
    };
    const activationBackoff = {
      currentState: 'off',
      plannedState: 'shed',
      currentDrawKw: 0,
      reason: r('activation backoff (1535s remaining)'),
      shedAction: 'turn_off' as const,
    };
    const activationBackoffTick = {
      currentState: 'off',
      plannedState: 'shed',
      currentDrawKw: 0,
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
      currentDrawKw: 0,
      reason: r('cooldown (restore, 30s remaining)'),
    };
    const restoreCooldownTick = {
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
      currentDrawKw: 0,
      reason: r('cooldown (restore, 24s remaining)'),
    };

    expect(buildDeviceOverviewTransitionSignature(restoreCooldown))
      .toBe(buildDeviceOverviewTransitionSignature(restoreCooldownTick));
  });

  it('ignores shortfall jitter in overview transition signatures', () => {
    const base = {
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
      currentDrawKw: 0,
      reason: r('shortfall (need 1.21kW, headroom -1.23kW)'),
    };
    const jitterOnly = {
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
      currentDrawKw: 0,
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
      currentDrawKw: 0,
      reason,
    });
    const carriers = [
      [{ code: 'capacity', shortfallKw: 1.2 }, { code: 'capacity', shortfallKw: 2.7 }],
      [
        { code: 'daily_budget', shortfallKw: 0.8 },
        { code: 'daily_budget', shortfallKw: 1.1 },
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
      currentDrawKw: 0,
      expectedPowerKw: 1,
    };

    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature({
        currentState: 'off',
        plannedState: 'keep',
        reason: r('keep'),
        currentDrawKw: 0,
        expectedPowerKw: 1,
      }),
    );
    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off' as const,
        reason: r('keep'),
        currentDrawKw: 0,
        expectedPowerKw: 1,
      }),
    );
    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature({
        currentState: 'on',
        plannedState: 'keep',
        reason: r('restore throttled'),
        currentDrawKw: 0,
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
      currentDrawKw: 0,
      reason: r('keep'),
    };

    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(buildDeviceOverviewTransitionSignature({
        controlModel: 'stepped_load' as const,
        currentState: 'on',
        plannedState: 'keep',
        reportedStepId: 'low',
        targetStepId: 'max',
        currentDrawKw: 0,
        reason: r('keep'),
    }));
  });

});
