import {
  buildPlanCapacityStateSummary,
  buildPlanChangeLines,
  buildPlanDebugSummaryEvent,
  buildPlanDebugSummarySignatureFromEvent,
  buildPlanSignature,
} from '../lib/plan/planLogging';
import type { DevicePlan } from '../lib/plan/planTypes';
import { legacyDeviceReason } from './utils/deviceReasonTestUtils';

const r = legacyDeviceReason;
const KEEP_REASON = r('keep')!;
const CAPACITY_REASON = r('shed due to capacity')!;

describe('plan logging helpers', () => {
  it('formats restore hints with power and headroom context', () => {
    const plan = {
      meta: { headroomKw: 1.2 },
      devices: [
        {
          id: 'dev-1',
          name: 'Heater',
          plannedState: 'keep',
          plannedTarget: 21,
          currentState: 'off',
          currentTarget: 20,
          powerKw: 1.5,
          reason: r('restore (need 1.50kW, headroom unknownkW)'),
        },
      ],
    } as unknown as DevicePlan;

    const lines = buildPlanChangeLines(plan);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('restoring, needs ~1.50kW vs headroom 1.20kW');
    expect(lines[0]).toContain('power off -> on');
  });

  it('handles uncontrollable devices and null targets', () => {
    const plan = {
      meta: { headroomKw: null },
      devices: [
        {
          id: 'same',
          name: 'Same',
          plannedState: 'keep',
          plannedTarget: 'eco',
          currentState: 'on',
          currentTarget: 'eco',
          controllable: false,
          reason: KEEP_REASON,
        },
        {
          id: 'diff',
          name: 'Diff',
          plannedState: 'keep',
          plannedTarget: 'comfort',
          currentState: 'on',
          currentTarget: null,
          controllable: false,
          reason: r('manual'),
        },
      ],
    } as unknown as DevicePlan;

    const lines = buildPlanChangeLines(plan);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('temp –° -> comfort°');
    expect(lines[0]).toContain('power on -> on');
  });

  it('formats shed actions and sorts by priority/name', () => {
    const plan = {
      meta: { headroomKw: null },
      devices: [
        {
          id: 'temp-no-target',
          name: 'Zeta',
          plannedState: 'shed',
          plannedTarget: null,
          currentState: 'on',
          currentTarget: 18,
          shedAction: 'set_temperature',
          priority: 2,
          reason: CAPACITY_REASON,
        },
        {
          id: 'off',
          name: 'Beta',
          plannedState: 'shed',
          plannedTarget: null,
          currentState: 'on',
          currentTarget: null,
          shedAction: 'turn_off',
          priority: 1,
          reason: CAPACITY_REASON,
        },
        {
          id: 'temp',
          name: 'Alpha',
          plannedState: 'shed',
          plannedTarget: 18,
          currentState: 'on',
          currentTarget: { mode: 'eco' },
          shedAction: 'set_temperature',
          priority: 1,
          reason: CAPACITY_REASON,
        },
      ],
    } as unknown as DevicePlan;

    const lines = buildPlanChangeLines(plan);
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith('Alpha:')).toBe(true);
    expect(lines[0]).toContain('set temp 18°');
    expect(lines[1]).toContain('power on -> off');
    expect(lines[2]).toContain('set temp');
  });

  it('builds a deterministic plan signature', () => {
    const plan = {
      meta: { headroomKw: 0 },
      devices: [
        {
          id: 'dev-1',
          name: 'Heater',
          plannedState: 'keep',
          plannedTarget: null,
          currentState: 'on',
          currentTarget: null,
          reason: KEEP_REASON,
        },
      ],
    } as unknown as DevicePlan;

    const signature = buildPlanSignature(plan);
    expect(signature).toContain('dev-1');
    expect(signature).toContain('plannedState');
  });

  it('falls back to default power and sort keys when missing', () => {
    const plan = {
      meta: { headroomKw: 0.5 },
      devices: [
        {
          id: 'fallback',
          name: '',
          plannedState: 'keep',
          plannedTarget: null,
          currentState: 'off',
          currentTarget: null,
          reason: KEEP_REASON,
        },
        {
          id: 'other',
          name: 'Other',
          plannedState: 'keep',
          plannedTarget: null,
          currentState: 'off',
          currentTarget: null,
          reason: KEEP_REASON,
        },
      ],
    } as unknown as DevicePlan;

    const lines = buildPlanChangeLines(plan);
    expect(lines[0]).toContain('needs ~1.00kW');
  });

  it('does not model non-onoff devices as power restore transitions', () => {
    const plan = {
      meta: { headroomKw: 0.8 },
      devices: [
        {
          id: 'temp-only',
          name: 'Temp Only',
          plannedState: 'keep',
          plannedTarget: 21,
          currentState: 'not_applicable',
          currentTarget: 16,
          shedAction: 'set_temperature',
          shedTemperature: 16,
          reason: r('keep'),
        },
      ],
    } as unknown as DevicePlan;

    const lines = buildPlanChangeLines(plan);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('power n/a -> n/a');
    expect(lines[0]).not.toContain('unknown -> on');
  });

  it('does not model inactive EV devices as restore transitions', () => {
    const plan = {
      meta: { headroomKw: 3.2 },
      devices: [
        {
          id: 'ev-1',
          name: 'EV Charger',
          plannedState: 'inactive',
          plannedTarget: null,
          currentState: 'off',
          currentTarget: null,
          reason: r('inactive (charger is unplugged)'),
        },
      ],
    } as unknown as DevicePlan;

    const lines = buildPlanChangeLines(plan);
    expect(lines).toEqual([]);
  });

  it('builds capacity state summary counts with stable zero fields', () => {
    const plan = {
      meta: { headroomKw: -0.5 },
      devices: [
        {
          id: 'shed',
          name: 'Shed',
          plannedState: 'shed',
          currentOn: true,
          currentState: 'on',
          measuredPowerKw: 0,
          binaryCommandPending: true,
          controllable: true,
          reason: CAPACITY_REASON,
        },
        {
          id: 'stale',
          name: 'Stale',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'unknown',
          observationStale: true,
          controllable: true,
          reason: KEEP_REASON,
        },
        {
          id: 'cooldown',
          name: 'Cooldown',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          reason: r('meter settling (10s remaining)'),
          controllable: true,
        },
        {
          id: 'penalty',
          name: 'Penalty',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          reason: r('activation backoff (30s remaining)'),
          controllable: true,
        },
        {
          id: 'invariant',
          name: 'Invariant',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          reason: r('shed invariant: low -> max blocked (1 device(s) shed, max step: low)'),
          controllable: true,
        },
        {
          id: 'manual',
          name: 'Manual',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          controllable: false,
          reason: KEEP_REASON,
        },
      ],
    } as unknown as DevicePlan;

    expect(buildPlanCapacityStateSummary(plan)).toEqual({
      controlledDevices: 5,
      plannedShedDevices: 1,
      pendingPlannedShedDevices: 1,
      activePlannedShedDevices: 1,
      activeControlledDevices: 4,
      zeroDrawControlledDevices: 1,
      staleControlledDevices: 1,
      pendingControlledDevices: 1,
      blockedByCooldownDevices: 1,
      blockedByPenaltyDevices: 1,
      blockedByInvariantDevices: 1,
      summarySource: null,
      summarySourceAtMs: null,
      controlledPowerW: null,
      uncontrolledPowerW: null,
      remainingReducibleControlledLoadW: 4000,
      remainingReducibleControlledLoad: true,
      remainingActionableControlledLoadW: 2000,
      remainingActionableControlledLoad: true,
      actuationInFlight: true,
    });
  });

  it('distinguishes actionable shortfall load from reducible live load', () => {
    const plan = {
      meta: { headroomKw: -0.5 },
      devices: [
        {
          id: 'cooldown',
          name: 'Cooldown',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          controllable: true,
          reason: r('meter settling (10s remaining)'),
        },
        {
          id: 'penalty',
          name: 'Penalty',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          controllable: true,
          reason: r('activation backoff (30s remaining)'),
        },
      ],
    } as unknown as DevicePlan;

    expect(buildPlanCapacityStateSummary(plan)).toEqual(expect.objectContaining({
      remainingReducibleControlledLoadW: 2000,
      remainingReducibleControlledLoad: true,
      remainingActionableControlledLoadW: 0,
      remainingActionableControlledLoad: false,
    }));
  });

  it('keeps shed-invariant stepped restore blocks actionable for shortfall shedding', () => {
    const plan = {
      meta: { headroomKw: -0.5 },
      devices: [
        {
          id: 'invariant',
          name: 'Stepped load',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          controllable: true,
          reason: r('shed invariant: low -> max blocked (1 device(s) shed, max step: low)'),
        },
      ],
    } as unknown as DevicePlan;

    expect(buildPlanCapacityStateSummary(plan)).toEqual(expect.objectContaining({
      blockedByInvariantDevices: 1,
      remainingReducibleControlledLoadW: 1000,
      remainingReducibleControlledLoad: true,
      remainingActionableControlledLoadW: 1000,
      remainingActionableControlledLoad: true,
    }));
  });

  it('does not count a stepped load at its configured shed step as remaining reducible', () => {
    const plan = {
      meta: {
        headroomKw: -0.5,
        totalKw: 4,
        softLimitKw: 0,
        capacitySoftLimitKw: 0,
        softLimitSource: 'capacity',
      },
      devices: [
        {
          id: 'connected-300',
          name: 'Connected 300',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          controllable: true,
          controlModel: 'stepped_load',
          steppedLoadProfile: {
            model: 'stepped_load',
            steps: [
              { id: 'off', planningPowerW: 0 },
              { id: 'Low', planningPowerW: 1250 },
              { id: 'Medium', planningPowerW: 2500 },
            ],
          },
          selectedStepId: undefined,
          desiredStepId: 'Low',
          targetStepId: 'Low',
          measuredPowerKw: 1.193,
          expectedPowerKw: 1.25,
          shedAction: 'set_step',
          reason: r('shed invariant: Low -> Medium blocked (11 device(s) shed, max step: Low)'),
        },
      ],
    } as unknown as DevicePlan;

    expect(buildPlanCapacityStateSummary(plan)).toEqual(expect.objectContaining({
      activeControlledDevices: 1,
      blockedByInvariantDevices: 1,
      remainingReducibleControlledLoadW: 0,
      remainingReducibleControlledLoad: false,
      remainingActionableControlledLoadW: 0,
      remainingActionableControlledLoad: false,
    }));
  });

  it('counts a stepped turn_off load at lowest active step as remaining reducible without an off step', () => {
    const plan = {
      meta: {
        headroomKw: -0.41,
        totalKw: 4.23,
        softLimitKw: 3.82,
        capacitySoftLimitKw: 4.5,
        softLimitSource: 'daily',
      },
      devices: [
        {
          id: 'connected-300',
          name: 'Connected 300',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          controllable: true,
          budgetExempt: false,
          controlModel: 'stepped_load',
          steppedLoadProfile: {
            model: 'stepped_load',
            steps: [
              { id: 'Low', planningPowerW: 1250 },
              { id: 'Medium', planningPowerW: 1750 },
              { id: 'Max', planningPowerW: 3000 },
            ],
          },
          selectedStepId: 'Low',
          desiredStepId: 'Low',
          targetStepId: 'Low',
          hasBinaryControl: true,
          measuredPowerKw: 1.193,
          expectedPowerKw: 1.25,
          shedAction: 'turn_off',
          reason: KEEP_REASON,
        },
      ],
    } as unknown as DevicePlan;

    expect(buildPlanCapacityStateSummary(plan)).toEqual(expect.objectContaining({
      activeControlledDevices: 1,
      remainingReducibleControlledLoadW: 1193,
      remainingReducibleControlledLoad: true,
      remainingActionableControlledLoadW: 1193,
      remainingActionableControlledLoad: true,
    }));
  });

  it('does not count a target device already at its shed temperature as remaining reducible', () => {
    const plan = {
      meta: {
        headroomKw: -0.8,
        totalKw: 4.8,
        softLimitKw: 4,
        capacitySoftLimitKw: 4,
        softLimitSource: 'capacity',
      },
      devices: [
        {
          id: 'heater-at-shed-temp',
          name: 'Heater At Shed Temp',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          currentTarget: 15,
          plannedTarget: 15,
          controllable: true,
          expectedPowerKw: 0.8,
          shedAction: 'set_temperature',
          shedTemperature: 15,
          reason: KEEP_REASON,
        },
      ],
    } as unknown as DevicePlan;

    expect(buildPlanCapacityStateSummary(plan)).toEqual(expect.objectContaining({
      remainingReducibleControlledLoadW: 0,
      remainingReducibleControlledLoad: false,
      remainingActionableControlledLoadW: 0,
      remainingActionableControlledLoad: false,
    }));
  });

  it('returns explicit null summary fields when no plan is available', () => {
    expect(buildPlanCapacityStateSummary(null)).toEqual({
      controlledDevices: null,
      plannedShedDevices: null,
      pendingPlannedShedDevices: null,
      activePlannedShedDevices: null,
      activeControlledDevices: null,
      zeroDrawControlledDevices: null,
      staleControlledDevices: null,
      pendingControlledDevices: null,
      blockedByCooldownDevices: null,
      blockedByPenaltyDevices: null,
      blockedByInvariantDevices: null,
      summarySource: null,
      summarySourceAtMs: null,
      controlledPowerW: null,
      uncontrolledPowerW: null,
      remainingReducibleControlledLoadW: null,
      remainingReducibleControlledLoad: null,
      remainingActionableControlledLoadW: null,
      remainingActionableControlledLoad: null,
      actuationInFlight: null,
    });
  });

  it('builds grouped structured debug summaries for restore-blocked and inactive devices', () => {
    const plan = {
      meta: {
        totalKw: 3.97,
        softLimitKw: 3.0,
        capacitySoftLimitKw: 4.0,
        dailySoftLimitKw: 3.0,
        softLimitSource: 'daily',
        headroomKw: -0.97,
      },
      devices: [
        {
          id: 'dev-1',
          name: 'Heater 1',
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          reason: r('insufficient headroom to restore (need 0.98kW, available -0.97kW)'),
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          reason: r('insufficient headroom to restore (need 1.10kW, available -0.97kW)'),
        },
        {
          id: 'ev-1',
          name: 'EV',
          currentOn: false,
          currentState: 'off',
          plannedState: 'inactive',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          reason: r('inactive (charger is unplugged)'),
        },
      ],
    } as unknown as DevicePlan;

    expect(buildPlanDebugSummaryEvent(plan)).toEqual({
      event: 'plan_debug_summary',
      totalKw: 3.97,
      softLimitKw: 3,
      capacitySoftLimitKw: 4,
      dailySoftLimitKw: 3,
      softLimitSource: 'daily',
      headroomKw: -0.97,
      restoreBlockedCount: 2,
      restoreBlockedReasons: [{ reason: 'insufficient headroom', count: 2 }],
      inactiveCount: 1,
      inactiveReasons: [{ reason: 'charger is unplugged', count: 1 }],
    });
    expect(buildPlanDebugSummarySignatureFromEvent(buildPlanDebugSummaryEvent(plan)))
      .toBe(JSON.stringify(buildPlanDebugSummaryEvent(plan)));
  });

  it('groups legacy restore cooldown reasons under one restore-blocked bucket', () => {
    const plan = {
      meta: {
        totalKw: 2.2,
        softLimitKw: 3,
        capacitySoftLimitKw: 3,
        dailySoftLimitKw: null,
        softLimitSource: 'capacity',
        headroomKw: 0.8,
      },
      devices: [
        {
          id: 'dev-1',
          name: 'Heater 1',
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          reason: r('cooldown (restore, 45s remaining)'),
        },
        {
          id: 'dev-2',
          name: 'Heater 2',
          currentOn: false,
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          reason: r('cooldown (restore, 12s remaining)'),
        },
      ],
    } as unknown as DevicePlan;

    expect(buildPlanDebugSummaryEvent(plan)).toEqual(expect.objectContaining({
      restoreBlockedCount: 2,
      restoreBlockedReasons: [{ reason: 'cooldown (restore)', count: 2 }],
    }));
  });
});
