import { applyRestorePlan } from '../lib/plan/planRestore';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanContext } from '../lib/plan/planContext';
import type { DevicePlanDevice } from '../lib/plan/planTypes';

const buildContext = (dailyBudget?: PlanContext['dailyBudget']): PlanContext => ({
  devices: [],
  desiredForMode: {},
  total: 2,
  softLimit: 6,
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 30,
  headroomRaw: 5,
  headroom: 5,
  restoreMarginPlanning: 0.2,
  dailyBudget,
});

const buildDevice = (overrides: Partial<DevicePlanDevice>): DevicePlanDevice => ({
  id: 'device',
  name: 'Device',
  currentState: 'off',
  plannedState: 'keep',
  currentTarget: null,
  plannedTarget: null,
  priority: 100,
  powerKw: 1,
  ...overrides,
});

describe('daily budget restore gating', () => {
  it('blocks low-priority restores when pressure is high', () => {
    const state = createPlanEngineState();
    const context = buildContext({
      enabled: true,
      pressure: 0.9,
      aggressiveness: 'strict',
      usedNowKWh: 6,
      allowedNowKWh: 4,
      remainingKWh: 1,
      exceeded: true,
      frozen: true,
    });
    const planDevices: DevicePlanDevice[] = [
      buildDevice({ id: 'device-on', name: 'Always On', currentState: 'on', priority: 1 }),
      buildDevice({ id: 'device-low', name: 'Low Priority', currentState: 'off', priority: 100 }),
    ];

    const result = applyRestorePlan({
      planDevices,
      context,
      state,
      sheddingActive: false,
      deps: {
        powerTracker: {},
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        log: () => undefined,
        logDebug: () => undefined,
      },
    });

    const low = result.planDevices.find((dev) => dev.id === 'device-low');
    expect(low?.plannedState).toBe('shed');
    expect(low?.reason).toContain('daily budget');
  });

  it('allows restores when pressure is low', () => {
    const state = createPlanEngineState();
    const context = buildContext({
      enabled: true,
      pressure: 0,
      aggressiveness: 'relaxed',
      usedNowKWh: 3,
      allowedNowKWh: 4,
      remainingKWh: 3,
      exceeded: false,
      frozen: false,
    });
    const planDevices: DevicePlanDevice[] = [
      buildDevice({ id: 'device-on', name: 'Always On', currentState: 'on', priority: 1 }),
      buildDevice({ id: 'device-low', name: 'Low Priority', currentState: 'off', priority: 100 }),
    ];

    const result = applyRestorePlan({
      planDevices,
      context,
      state,
      sheddingActive: false,
      deps: {
        powerTracker: {},
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        log: () => undefined,
        logDebug: () => undefined,
      },
    });

    const low = result.planDevices.find((dev) => dev.id === 'device-low');
    expect(low?.plannedState).toBe('keep');
    expect(low?.reason ?? '').not.toContain('daily budget');
  });
});
