import { buildPlanChangeLines, buildPlanSignature } from '../lib/plan/planLogging';
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
});
