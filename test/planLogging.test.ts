import {
  buildPlanCapacityStateSummary,
  buildPlanChangeLines,
  buildPlanDebugSummaryEvent,
  buildPlanDebugSummarySignatureFromEvent,
  buildPlanSignature,
} from '../lib/plan/planLogging';
import type { DevicePlan } from '../lib/plan/planTypes';

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
          reason: 'restore',
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
        },
        {
          id: 'diff',
          name: 'Diff',
          plannedState: 'keep',
          plannedTarget: 'comfort',
          currentState: 'on',
          currentTarget: null,
          controllable: false,
          reason: 'manual',
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
        },
        {
          id: 'other',
          name: 'Other',
          plannedState: 'keep',
          plannedTarget: null,
          currentState: 'off',
          currentTarget: null,
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
          reason: 'keep',
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
          reason: 'inactive (charger is unplugged)',
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
        },
        {
          id: 'stale',
          name: 'Stale',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'unknown',
          observationStale: true,
          controllable: true,
        },
        {
          id: 'cooldown',
          name: 'Cooldown',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          reason: 'cooldown (restore, 10s remaining)',
          controllable: true,
        },
        {
          id: 'penalty',
          name: 'Penalty',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          reason: 'activation backoff (30s remaining)',
          controllable: true,
        },
        {
          id: 'invariant',
          name: 'Invariant',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          reason: 'shed invariant: low -> max blocked (1 device(s) shed, max step: low)',
          controllable: true,
        },
        {
          id: 'manual',
          name: 'Manual',
          plannedState: 'keep',
          currentOn: true,
          currentState: 'on',
          controllable: false,
        },
      ],
    } as unknown as DevicePlan;

    expect(buildPlanCapacityStateSummary(plan)).toEqual({
      controlledDevices: 5,
      shedDevices: 1,
      activeControlledDevices: 4,
      zeroDrawControlledDevices: 1,
      staleControlledDevices: 1,
      pendingControlledDevices: 1,
      blockedByCooldownDevices: 1,
      blockedByPenaltyDevices: 1,
      blockedByInvariantDevices: 1,
    });
  });

  it('returns explicit null summary fields when no plan is available', () => {
    expect(buildPlanCapacityStateSummary(null)).toEqual({
      controlledDevices: null,
      shedDevices: null,
      activeControlledDevices: null,
      zeroDrawControlledDevices: null,
      staleControlledDevices: null,
      pendingControlledDevices: null,
      blockedByCooldownDevices: null,
      blockedByPenaltyDevices: null,
      blockedByInvariantDevices: null,
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
          reason: 'insufficient headroom (need 0.98kW, headroom -0.97kW)',
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
          reason: 'insufficient headroom (need 1.10kW, headroom -0.97kW)',
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
          reason: 'inactive (charger is unplugged)',
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
});
