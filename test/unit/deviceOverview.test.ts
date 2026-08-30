import {
  buildDeviceOverviewTransitionSignature,
  formatDeviceOverview,
  getDeviceOverviewReportedStepId,
  isDeviceOverviewSteppedModeTransition,
} from '../../packages/shared-domain/src/deviceOverview';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { PLAN_STATE_CAPACITY_STATUS } from '../../packages/shared-domain/src/planStateLabels';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import { steppedProfile } from '../utils/planTestUtils';
import type { DeviceOverviewSnapshot, DeviceOverviewSteppedLoad } from '../../packages/shared-domain/src/deviceOverview';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';

const r = (reason: string): DeviceReason => fixtureDeviceReason(reason)!;

// The producer resolves `expectedPowerKw`, `controllable` and `available` for
// every device, so every fixture must carry them. Defaults here stand for "this
// test does not care": a reachable, managed binary device that draws nothing
// when running — a device with no `steppedLoad` cluster and no `deviceType` is
// exactly that, so no marker field is needed. Tests about a temperature device
// set `deviceType`, stepped ones build through `buildSteppedOverviewDevice`,
// and anything asserting a usage line overrides `expectedPowerKw`.
const buildOverviewDevice = (
  overrides: Partial<DeviceOverviewSnapshot> & Pick<DeviceOverviewSnapshot, 'reason'>,
): DeviceOverviewSnapshot => ({
  controllable: true,
  available: true,
  currentDrawKw: 0,
  // The producer's own default rung (`DEFAULT_EXPECTED_POWER_KW`): its contract
  // promises a finite POSITIVE figure for every device, so a fixture default of
  // 0 would pin a value the producer never emits.
  expectedPowerKw: 1,
  ...overrides,
});

// Stepped-ness is the PRESENCE of the `steppedLoad` cluster, so a stepped
// fixture carries a real ladder (the shared `steppedProfile`) rather than a
// marker string.
//
// The step ids are set on the cluster, in the second argument. This helper used
// to MIRROR flat top-level ids into the cluster so a fixture stayed "one
// coherent snapshot rather than two disagreeing halves" — which was the right
// instinct about a shape that genuinely had two halves. There is one now, so
// there is nothing to keep in sync.
const buildSteppedOverviewDevice = (
  overrides: Partial<DeviceOverviewSnapshot> & Pick<DeviceOverviewSnapshot, 'reason'>,
  stepped: Partial<DeviceOverviewSteppedLoad> = {},
): DeviceOverviewSnapshot => ({
  ...buildOverviewDevice(overrides),
  steppedLoad: {
    profile: steppedProfile,
    reportedStepId: null,
    targetStepId: null,
    selectedStepId: 'low',
    planningPowerKw: 1,
    commandPending: false,
    ...stepped,
  },
});

describe('overview transition signature', () => {
  // Regression (PR #1955 review, Copilot + Codex): a satisfied target-only
  // thermostat's Running ↔ Idle flip can have the temperature as its only
  // changed input; the signature must carry the RESOLVED state kind so the
  // device log records the transition (and only the transition — sub-epsilon
  // temperature wobble must not change the signature).
  it('changes when the satisfied-idle classification flips, not on sub-epsilon wobble', () => {
    const base = buildOverviewDevice({
      currentState: 'not_applicable',
      plannedState: 'keep',
      reason: r('keep'),
      controllable: true,
      available: true,
      currentDrawKw: 0,
    });
    const at = (currentTemperature: number) => ({
      ...base,
      temperature: { currentTemperature, currentTarget: 16, plannedTarget: 16 },
    });
    const running = buildDeviceOverviewTransitionSignature(at(14));
    const idle = buildDeviceOverviewTransitionSignature(at(20.8));
    const idleWobble = buildDeviceOverviewTransitionSignature(at(20.9));
    expect(idle).not.toBe(running);
    expect(idleWobble).toBe(idle);
  });
});

describe('device overview formatter', () => {
  it('formats active devices with measured and expected power', () => {
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      currentDrawKw: 0,
      expectedPowerKw: 3,
    }))).toEqual({
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
    const base = buildOverviewDevice({
      currentState: 'not_applicable',
      plannedState: 'keep',
      reason: r('keep'),
      currentDrawKw: 0,
      expectedPowerKw: 1,
    });
    const at = (currentTemperature: number) => ({
      ...base,
      temperature: { currentTemperature, currentTarget: 16, plannedTarget: 16 },
    });
    expect(formatDeviceOverview(at(20.8)).stateMsg).toBe('Idle');
    expect(formatDeviceOverview(at(14.2)).stateMsg)
      .toBe('Active (temperature-managed)');
  });

  it('formats inactive devices', () => {
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'off',
      plannedState: 'inactive',
      currentDrawKw: 0,
      reason: r('inactive (charger is unplugged)'),
    }))).toEqual({
      powerMsg: 'off',
      stateMsg: 'Inactive',
      usageMsg: 'Measured: 0.00 kW / Expected: 1.00 kW',
      statusMsg: 'Off for now (charger is unplugged)',
    });
  });

  it('formats unplugged chargers without changing semantics', () => {
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'off',
      plannedState: 'inactive',
      currentDrawKw: 0,
      reason: r('inactive (charger is unplugged)'),
    }))).toEqual({
      powerMsg: 'off',
      stateMsg: 'Inactive',
      usageMsg: 'Measured: 0.00 kW / Expected: 1.00 kW',
      statusMsg: 'Off for now (charger is unplugged)',
    });
  });

  it('adds EV battery SoC details to status text without changing control state', () => {
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      deviceRole: 'ev_charger',
      evChargingState: 'plugged_in_charging',
      stateOfCharge: { level: { kind: 'known', percent: 42 } },
      currentDrawKw: 0,
      reason: r('keep'),
    })).statusMsg).toBe('EV battery: 42 %');

    // Unplugged: the producer has no level, so the card shows no battery line at
    // all rather than a number carrying a qualifier ("42 %, stale") the reader
    // was invited to use anyway.
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'off',
      plannedState: 'inactive',
      deviceRole: 'ev_charger',
      evChargingState: 'plugged_out',
      stateOfCharge: { level: { kind: 'unavailable', reasonCode: 'not_connected' } },
      currentDrawKw: 0,
      reason: r('inactive (charger is unplugged)'),
    })).statusMsg).toBe('Off for now (charger is unplugged)');
  });

  it('formats legacy keep devices blocked by meter settling without inventing shed state', () => {
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'off',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('meter settling (10s remaining)'),
    }))).toEqual({
      powerMsg: 'off',
      stateMsg: 'Resuming',
      usageMsg: 'Measured: 0.00 kW / Expected: 1.00 kW',
      statusMsg: 'Waiting for power meter to stabilise (10s)',
    });

    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'on',
      plannedState: 'shed',
      currentDrawKw: 0,
      reason: r('cooldown (restore, 10s remaining)'),
      shedAction: 'turn_off',
    }))).toEqual({
      powerMsg: 'on → off',
      stateMsg: 'Turned off',
      usageMsg: 'Measured: 0.00 kW / Expected: 1.00 kW',
      statusMsg: 'Waiting to resume — 10s',
    });
  });

  it('formats shed devices blocked by meter settling as held off', () => {
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'off',
      plannedState: 'shed',
      currentDrawKw: 0,
      reason: r('meter settling (10s remaining)'),
      shedAction: 'turn_off',
    }))).toEqual({
      powerMsg: 'off',
      stateMsg: 'Turned off',
      usageMsg: 'Measured: 0.00 kW / Expected: 1.00 kW',
      statusMsg: 'Waiting for power meter to stabilise (10s)',
    });
  });

  it('keeps meter settling copy distinct from restore cooldown copy', () => {
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('meter settling (10s remaining)'),
    })).statusMsg).toBe('Waiting for power meter to stabilise (10s)');
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('cooldown (restore, 10s remaining)'),
    })).statusMsg).toBe('Waiting to resume — 10s');
  });

  it('formats stepped-load devices with desired step labels', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'set_step',
      currentDrawKw: 0,
      reason: r('shed due to capacity'),
    }, {
      targetStepId: 'max',
      planningPowerKw: 3,
    }))).toEqual({
      powerMsg: null,
      stateMsg: 'Limited to Max',
      usageMsg: 'Measured: 0.00 kW / Planned: 3.00 kW (target: Max)',
      statusMsg: PLAN_STATE_CAPACITY_STATUS,
    });
  });

  // Shed behaviour is a FLOOR ("worst case, turn off"), not an action: since
  // 2026-08-17 the planner may park a `turn_off` stepped device at any rung above
  // the off step and the executor honours it. The state line must key on where
  // the plan actually parks the device, or a device still running reads as
  // switched off.
  it('reads a turn_off device parked at a running rung as limited to that step', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'turn_off',
      currentDrawKw: 2,
      reason: r('shed due to capacity'),
    }, {
      reportedStepId: 'max',
      targetStepId: 'medium',
      planningPowerKw: 2,
    })).stateMsg).toBe('Limited to Medium');
  });

  // A stepped device can be limited by lowering its setpoint while its step
  // target stays where it was. Naming the rung there said "Limited to Max" for a
  // device whose step never moved, hiding the setpoint that actually changed.
  it('reads a stepped device limited by setpoint as lowered, not as its unchanged step', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'set_temperature',
      shedTemperature: 15,
      currentDrawKw: 2,
      reason: r('shed due to capacity'),
    }, {
      reportedStepId: 'max',
      targetStepId: 'max',
      selectedStepId: 'max',
      planningPowerKw: 2,
    })).stateMsg).toBe('Lowered');
  });

  it('keeps a turn_off device parked at the off step turned off', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'turn_off',
      currentDrawKw: 0,
      reason: r('shed due to capacity'),
    }, {
      reportedStepId: 'off',
      targetStepId: 'off',
      selectedStepId: 'off',
      planningPowerKw: 0,
    })).stateMsg).toBe('Turned off');
  });

  // Naming the rung when the plan parked the device at the off step read
  // "Limited to Off" — awkward, and the same situation a `turn_off` device
  // reports as "Turned off".
  it('reads a set_step device parked at the off step as turned off', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'set_step',
      currentDrawKw: 0,
      reason: r('shed due to capacity'),
    }, {
      reportedStepId: 'off',
      targetStepId: 'off',
      selectedStepId: 'off',
      planningPowerKw: 0,
    })).stateMsg).toBe('Turned off');
  });

  // The one case with no rung to name at all keeps the bare state word.
  it('keeps the bare Limited word for a set_step device with no target step', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'set_step',
      currentDrawKw: 0,
      reason: r('shed due to capacity'),
    }, {
      targetStepId: null,
    })).stateMsg).toBe('Limited');
  });

  // A charger trimmed to a lower rung is still charging, just slower — "Charging
  // paused" contradicted a charger drawing 3.7 kW. Only a charger the plan
  // actually stops keeps that line.
  it('does not call a charger parked at a running rung paused', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'turn_off',
      deviceRole: 'ev_charger',
      evChargingState: 'plugged_in_charging',
      currentDrawKw: 3.7,
      reason: r('shed due to capacity'),
    }, {
      reportedStepId: 'max',
      targetStepId: 'low',
      planningPowerKw: 1.25,
    })).stateMsg).toBe('Limited to Low');
  });

  it('keeps Charging paused for a charger the plan actually stops', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'turn_off',
      deviceRole: 'ev_charger',
      evChargingState: 'plugged_in_paused',
      currentDrawKw: 0,
      reason: r('shed due to capacity'),
    }, {
      reportedStepId: 'off',
      targetStepId: 'off',
      selectedStepId: 'off',
      planningPowerKw: 0,
    })).stateMsg).toBe('Charging paused');
  });

  it('formats reported stepped-load feedback as confirmed observed state', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('keep'),
    }, {
      reportedStepId: 'low',
      targetStepId: 'max',
      planningPowerKw: 3,
    })).usageMsg).toBe('Measured: 0.00 kW / Planned: 3.00 kW (reported: Low / target: Max)');
  });

  it('treats on-like stepped step changes as active mode transitions', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 0.6,
      reason: r('cooldown (restore, 10s remaining)'),
    }, {
      reportedStepId: 'low',
      targetStepId: 'max',
      planningPowerKw: 3,
    }))).toEqual({
      powerMsg: null,
      stateMsg: 'Active (low → max)',
      usageMsg: 'Measured: 0.60 kW / Planned: 3.00 kW (reported: Low / target: Max)',
      statusMsg: 'Waiting to increase — 10s',
    });
  });

  // The `not_applicable` + known-rung case that used to be asserted here is gone
  // with the card branch it pinned. The producer cannot emit that combination:
  // a stepped device with a known rung resolves to on/off, and only an unknown
  // rung falls through to `not_applicable`. That contract is pinned directly in
  // `test/unit/observedStateResolution.test.ts`.

  it('keeps off-like stepped restores in restoring state', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'off',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('restore off -> low (need 1.25kW)'),
    }, {
      targetStepId: 'low',
      selectedStepId: 'off',
      planningPowerKw: 1.25,
    })).stateMsg).toBe('Resuming');
  });

  it('keeps steady on-like stepped devices active without a transition arrow', () => {
    expect(formatDeviceOverview(buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 0.4,
      reason: r('keep'),
    }, {
      reportedStepId: 'low',
      targetStepId: 'low',
      planningPowerKw: 1.25,
    }))).toEqual({
      powerMsg: null,
      stateMsg: 'Active',
      usageMsg: 'Measured: 0.40 kW / Planned: 1.25 kW (reported: Low)',
      statusMsg: '',
    });
  });

  it('does not treat disappeared stepped devices as active mode transitions', () => {
    const device = buildSteppedOverviewDevice({
      currentState: 'disappeared',
      plannedState: 'keep',
      currentDrawKw: 0.6,
      reason: r('cooldown (restore, 10s remaining)'),
    }, {
      reportedStepId: 'low',
      targetStepId: 'max',
      planningPowerKw: 3,
    });

    expect(isDeviceOverviewSteppedModeTransition(device)).toBe(false);
    expect(formatDeviceOverview(device)).toEqual({
      powerMsg: null,
      stateMsg: 'State unknown',
      usageMsg: 'Measured: 0.60 kW / Planned: 3.00 kW (reported: Low / target: Max)',
      statusMsg: 'Waiting to resume — 10s',
    });
  });

  it('does not treat unavailable stepped devices as active mode transitions', () => {
    const device = buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      available: false,
      currentDrawKw: 0.6,
      reason: r('cooldown (restore, 10s remaining)'),
    }, {
      reportedStepId: 'low',
      targetStepId: 'max',
      planningPowerKw: 3,
    });

    expect(isDeviceOverviewSteppedModeTransition(device)).toBe(false);
    expect(formatDeviceOverview(device)).toEqual({
      powerMsg: null,
      stateMsg: 'Unavailable',
      usageMsg: 'Measured: 0.60 kW / Planned: 3.00 kW (reported: Low / target: Max)',
      statusMsg: 'Waiting to increase — 10s',
    });
  });

  it('does not treat unavailable stepped devices as active mode transitions', () => {
    expect(isDeviceOverviewSteppedModeTransition(buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      available: false,
      currentDrawKw: 0,
      reason: r('keep'),
    }, {
      reportedStepId: 'low',
      targetStepId: 'max',
    }))).toBe(false);
  });

  it('surfaces the confirmed reported step in the usage line', () => {
    const device = buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('keep'),
    }, {
      reportedStepId: 'max',
      targetStepId: 'max',
      planningPowerKw: 3,
    });

    expect(getDeviceOverviewReportedStepId(device)).toBe('max');
    expect(formatDeviceOverview(device).usageMsg)
      .toBe('Measured: 0.00 kW / Planned: 3.00 kW (reported: Max)');
  });

  // "Optional" here is now only the genuinely optional half of the shape. The
  // usage line always carries both figures: `expectedPowerKw` is required and
  // producer-resolved, so the measured-only branch of `formatUsageText` is
  // unreachable for a device that came off a plan.
  it('handles missing optional values consistently', () => {
    expect(formatDeviceOverview(buildOverviewDevice({
      currentState: 'unknown',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    }))).toEqual({
      powerMsg: 'unknown',
      stateMsg: 'State unknown',
      usageMsg: 'Measured: 0.00 kW / Expected: 1.00 kW',
      statusMsg: '',
    });
  });
});

describe('device overview transition signatures', () => {
  it('changes on usage-only changes', () => {
    const base = buildOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      currentDrawKw: 0,
      expectedPowerKw: 1,
    });
    const usageOnly = buildOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      currentDrawKw: 0.25,
      expectedPowerKw: 1,
    });

    expect(formatDeviceOverview(base).usageMsg).not.toBe(formatDeviceOverview(usageOnly).usageMsg);
    expect(buildDeviceOverviewTransitionSignature(base))
      .not.toBe(buildDeviceOverviewTransitionSignature(usageOnly));
  });

  it('changes when surplusAbsorbActive flips even if the normalized target is unchanged', () => {
    // The "Raised to use your solar power" reason line is driven by surplusAbsorbActive, so a
    // flip must re-render the card even when nothing else (target, state, reason.code) moved —
    // otherwise the line goes stale until some unrelated plan change.
    const withoutSurplus = buildOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      currentDrawKw: 1,
      expectedPowerKw: 1,
      surplusAbsorbActive: false,
    });
    const withSurplus = { ...withoutSurplus, surplusAbsorbActive: true };
    expect(buildDeviceOverviewTransitionSignature(withoutSurplus))
      .not.toBe(buildDeviceOverviewTransitionSignature(withSurplus));
  });

  it('ignores countdown-only cooldown and backoff changes', () => {
    const restoreCooldown = buildOverviewDevice({
      currentState: 'off',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('meter settling (30s remaining)'),
    });
    const restoreCooldownTick = buildOverviewDevice({
      currentState: 'off',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('meter settling (24s remaining)'),
    });
    const activationBackoff = buildOverviewDevice({
      currentState: 'off',
      plannedState: 'shed',
      currentDrawKw: 0,
      reason: r('activation backoff (1535s remaining)'),
      shedAction: 'turn_off' as const,
    });
    const activationBackoffTick = buildOverviewDevice({
      currentState: 'off',
      plannedState: 'shed',
      currentDrawKw: 0,
      reason: r('activation backoff (1503s remaining)'),
      shedAction: 'turn_off' as const,
    });

    expect(buildDeviceOverviewTransitionSignature(restoreCooldown))
      .toBe(buildDeviceOverviewTransitionSignature(restoreCooldownTick));
    expect(buildDeviceOverviewTransitionSignature(activationBackoff))
      .toBe(buildDeviceOverviewTransitionSignature(activationBackoffTick));
  });

  it('ignores countdown-only legacy restore cooldown changes', () => {
    const restoreCooldown = buildOverviewDevice({
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
      currentDrawKw: 0,
      reason: r('cooldown (restore, 30s remaining)'),
    });
    const restoreCooldownTick = buildOverviewDevice({
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
      currentDrawKw: 0,
      reason: r('cooldown (restore, 24s remaining)'),
    });

    expect(buildDeviceOverviewTransitionSignature(restoreCooldown))
      .toBe(buildDeviceOverviewTransitionSignature(restoreCooldownTick));
  });

  it('ignores shortfall jitter in overview transition signatures', () => {
    const base = buildOverviewDevice({
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
      currentDrawKw: 0,
      reason: r('shortfall (need 1.21kW, headroom -1.23kW)'),
    });
    const jitterOnly = buildOverviewDevice({
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'turn_off' as const,
      currentDrawKw: 0,
      reason: r('shortfall (need 1.24kW, headroom -1.24kW)'),
    });

    expect(buildDeviceOverviewTransitionSignature(base))
      .toBe(buildDeviceOverviewTransitionSignature(jitterOnly));
  });

  // Since `finalizeCeilingReason` attaches a pace-relative `shortfallKw` to
  // every ceiling hold each cycle, the exclusion must hold for all carriers —
  // the gap moves with `softLimitKw − totalKw`, so including it would flip the
  // signature on most rebuilds and flood the device-log ring buffer.
  it('ignores shortfall jitter on capacity, budget, and swap carriers', () => {
    const withGap = (reason: DeviceReason) => buildOverviewDevice({
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
    const base = buildOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      reason: r('keep'),
      currentDrawKw: 0,
      expectedPowerKw: 1,
    });

    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature(buildOverviewDevice({
        currentState: 'off',
        plannedState: 'keep',
        reason: r('keep'),
        currentDrawKw: 0,
        expectedPowerKw: 1,
      })),
    );
    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature(buildOverviewDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off' as const,
        reason: r('keep'),
        currentDrawKw: 0,
        expectedPowerKw: 1,
      })),
    );
    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(
      buildDeviceOverviewTransitionSignature(buildOverviewDevice({
        currentState: 'on',
        plannedState: 'keep',
        reason: r('restore throttled'),
        currentDrawKw: 0,
        expectedPowerKw: 1,
      })),
    );
  });

  it('changes when stepped observed-vs-target semantics change', () => {
    const base = buildSteppedOverviewDevice({
      currentState: 'on',
      plannedState: 'keep',
      currentDrawKw: 0,
      reason: r('keep'),
    }, {
      reportedStepId: 'low',
      targetStepId: 'low',
    });

    expect(buildDeviceOverviewTransitionSignature(base)).not.toBe(buildDeviceOverviewTransitionSignature(buildSteppedOverviewDevice({
        currentState: 'on',
        plannedState: 'keep',
        currentDrawKw: 0,
        reason: r('keep'),
    }, {
      reportedStepId: 'low',
      targetStepId: 'max',
    })));
  });

});
