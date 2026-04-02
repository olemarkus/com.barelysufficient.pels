import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PlanContext } from '../lib/plan/planContext';
import { SWAP_TIMEOUT_MS } from '../lib/plan/planConstants';
import { createPlanEngineState } from '../lib/plan/planState';
import { applyRestorePlan } from '../lib/plan/planRestore';
import { buildPlanDevice, steppedPlanDevice } from './utils/planTestUtils';

const buildContext = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  devices: [],
  desiredForMode: {},
  total: 0,
  softLimit: 0,
  capacitySoftLimit: 0,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: 1,
  headroom: 1,
  restoreMarginPlanning: 0.2,
  ...overrides,
});

describe('restore cooldown backoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('backs off restore cooldown from 60 to 120, 240, then caps at 300 seconds', () => {
    const state = createPlanEngineState();
    let now = Date.UTC(2024, 0, 1, 0, 0, 0);

    const deps = {
      powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
      getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
      log: jest.fn(),
      logDebug: jest.fn(),
    };

    const step = (advanceMs: number): number => {
      now += advanceMs;
      jest.setSystemTime(now);
      state.lastRestoreMs = now - 2 * 60 * 1000;
      state.lastInstabilityMs = now - 1000;

      const result = applyRestorePlan({
        planDevices: [],
        context: buildContext(),
        state,
        sheddingActive: false,
        deps,
      });

      state.restoreCooldownMs = result.restoreCooldownMs;
      state.lastRestoreCooldownBumpMs = result.lastRestoreCooldownBumpMs;
      return result.restoreCooldownMs;
    };

    expect(step(0)).toBe(120000);
    expect(step(60000)).toBe(240000);
    expect(step(60000)).toBe(300000);
    expect(step(60000)).toBe(300000);
  });

  it('resets restore cooldown to base after sustained stability', () => {
    const state = createPlanEngineState();
    let now = Date.UTC(2024, 0, 1, 0, 0, 0);

    const deps = {
      powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
      getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
      log: jest.fn(),
      logDebug: jest.fn(),
    };

    const triggerInstability = (): void => {
      state.lastRestoreMs = now - 2 * 60 * 1000;
      state.lastInstabilityMs = now - 1000;
    };

    triggerInstability();
    jest.setSystemTime(now);
    let result = applyRestorePlan({
      planDevices: [],
      context: buildContext(),
      state,
      sheddingActive: false,
      deps,
    });

    state.restoreCooldownMs = result.restoreCooldownMs;
    state.lastRestoreCooldownBumpMs = result.lastRestoreCooldownBumpMs;
    expect(result.restoreCooldownMs).toBe(120000);

    now += 6 * 60 * 1000;
    state.lastInstabilityMs = now - 6 * 60 * 1000;
    jest.setSystemTime(now);
    result = applyRestorePlan({
      planDevices: [],
      context: buildContext(),
      state,
      sheddingActive: false,
      deps,
    });

    expect(result.restoreCooldownMs).toBe(60000);
  });

  it('uses in-cycle cleaned swap state when selecting swap candidates', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.swapByDevice = {
      'dev-on': { swappedOutFor: 'stale-target' },
      'stale-target': { pendingTarget: true, timestamp: now - SWAP_TIMEOUT_MS - 1000 },
    };

    const deps = {
      powerTracker: { lastTimestamp: 321 } as PowerTrackerState,
      getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
      log: jest.fn(),
      logDebug: jest.fn(),
    };

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({ id: 'dev-off', name: 'Off', priority: 10, currentState: 'off', powerKw: 1 }),
        buildPlanDevice({ id: 'dev-on', name: 'On', priority: 90, currentState: 'on', powerKw: 2 }),
      ],
      context: buildContext({ headroomRaw: 0, headroom: 0 }),
      state,
      sheddingActive: false,
      deps,
    });

    const offDevice = result.planDevices.find((device) => device.id === 'dev-off');
    const onDevice = result.planDevices.find((device) => device.id === 'dev-on');
    expect(offDevice?.plannedState).toBe('keep');
    expect(onDevice?.plannedState).toBe('shed');
    expect(onDevice?.reason).toBe('swapped out for Off');
    expect(result.stateUpdates.swapByDevice['stale-target']?.pendingTarget).toBeFalsy();
    expect(result.stateUpdates.swapByDevice['dev-on']?.swappedOutFor).toBe('dev-off');
  });

  it('blocks stepped-load step-up while another device is still waiting to recover', () => {
    const state = createPlanEngineState();
    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-off',
          name: 'Critical heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          selectedStepId: 'low',
          desiredStepId: 'low',
          measuredPowerKw: 0,
          planningPowerKw: 1.25,
        }),
      ],
      context: buildContext({
        headroomRaw: 1.0,
        headroom: 1.0,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const binaryDevice = result.planDevices.find((device) => device.id === 'dev-off');
    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(binaryDevice?.plannedState).toBe('shed');
    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(steppedDevice?.reason).toBe('waiting for other devices to recover');
  });

  it('blocks stepped-load step-up while another previously shed device is still restoring', () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-off'] = Date.now() - 30_000;

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-off',
          name: 'Critical heater',
          currentState: 'unknown',
          plannedState: 'keep',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          selectedStepId: 'low',
          desiredStepId: 'low',
          measuredPowerKw: 0,
          planningPowerKw: 1.25,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const binaryDevice = result.planDevices.find((device) => device.id === 'dev-off');
    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(binaryDevice?.plannedState).toBe('keep');
    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(steppedDevice?.reason).toBe('waiting for other devices to recover');
  });

  it('blocks stepped-load step-up while another ordinary device is swapped out', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.swapByDevice = {
      'dev-swapped': { swappedOutFor: 'dev-target' },
      'dev-target': { pendingTarget: true, timestamp: now },
    };

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-swapped',
          name: 'Swapped heater',
          currentState: 'off',
          plannedState: 'shed',
          reason: 'swapped out for Critical heater',
          expectedPowerKw: 1.5,
          measuredPowerKw: 0,
          powerKw: 1.5,
        }),
        buildPlanDevice({
          id: 'dev-target',
          name: 'Critical heater',
          currentState: 'off',
          plannedState: 'shed',
          reason: 'swap pending',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          selectedStepId: 'low',
          desiredStepId: 'low',
          measuredPowerKw: 0,
          planningPowerKw: 1.25,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(steppedDevice?.reason).toBe('waiting for other devices to recover');
  });

  it('blocks stepped-load step-up while an ordinary device is still swap pending', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.swapByDevice = {
      'dev-target': { pendingTarget: true, timestamp: now },
    };

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-target',
          name: 'Critical heater',
          currentState: 'off',
          plannedState: 'shed',
          reason: 'swap pending',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          selectedStepId: 'low',
          desiredStepId: 'low',
          measuredPowerKw: 0,
          planningPowerKw: 1.25,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(steppedDevice?.reason).toBe('waiting for other devices to recover');
  });

  it('does not let a stale recently shed device block an unrelated stepped restore', () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-off'] = Date.now() - 30_000;

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-off',
          name: 'Critical heater',
          currentState: 'unknown',
          observationStale: true,
          plannedState: 'keep',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          selectedStepId: 'low',
          desiredStepId: 'low',
          measuredPowerKw: 0,
          planningPowerKw: 1.25,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('medium');
    expect(steppedDevice?.reason).toBe('restore low -> medium (need 0.95kW)');
  });

  it('blocks stepped-load step-up while a shed-temperature device is still awaiting restore confirmation', () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-temp'] = Date.now() - 30_000;

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-temp',
          name: 'Hall thermostat',
          currentState: 'on',
          plannedState: 'keep',
          currentTarget: 16,
          plannedTarget: 23,
          shedAction: 'set_temperature',
          pendingTargetCommand: {
            desired: 23,
            retryCount: 0,
            nextRetryAtMs: Date.now() + 30_000,
            status: 'waiting_confirmation',
          },
          expectedPowerKw: 1.5,
          measuredPowerKw: 0,
          powerKw: 1.5,
        }),
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          selectedStepId: 'low',
          desiredStepId: 'low',
          measuredPowerKw: 0,
          planningPowerKw: 1.25,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const tempDevice = result.planDevices.find((device) => device.id === 'dev-temp');
    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(tempDevice?.plannedState).toBe('keep');
    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(steppedDevice?.reason).toBe('waiting for other devices to recover');
  });

  it('blocks ordinary restore while another stepped-load restore is still awaiting confirmation', () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-step'] = Date.now() - 30_000;
    state.lastDeviceRestoreMs['dev-step'] = Date.now() - 5_000;

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'on',
          selectedStepId: 'low',
          desiredStepId: 'medium',
          stepCommandPending: true,
          stepCommandStatus: 'pending',
          measuredPowerKw: 1.25,
          planningPowerKw: 1.25,
        }),
        buildPlanDevice({
          id: 'dev-off',
          name: 'Hall heater',
          currentState: 'off',
          plannedState: 'keep',
          expectedPowerKw: 1.5,
          measuredPowerKw: 0,
          powerKw: 1.5,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');
    const offDevice = result.planDevices.find((device) => device.id === 'dev-off');

    expect(steppedDevice?.plannedState).toBe('keep');
    expect(offDevice?.plannedState).toBe('shed');
    expect(offDevice?.reason).toBe('waiting for other devices to recover');
  });

  it('does not block ordinary restore when another shed-temperature device is temporarily unavailable rather than recovering', () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-temp'] = Date.now() - 30_000;

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-temp',
          name: 'Hall thermostat',
          currentState: 'on',
          plannedState: 'keep',
          currentTarget: 16,
          plannedTarget: 23,
          shedAction: 'set_temperature',
          pendingTargetCommand: {
            desired: 23,
            retryCount: 1,
            nextRetryAtMs: Date.now() + 30_000,
            status: 'temporary_unavailable',
          },
          expectedPowerKw: 1.5,
          measuredPowerKw: 0,
          powerKw: 1.5,
        }),
        buildPlanDevice({
          id: 'dev-off',
          name: 'Hall heater',
          currentState: 'off',
          plannedState: 'keep',
          expectedPowerKw: 1.5,
          measuredPowerKw: 0,
          powerKw: 1.5,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const offDevice = result.planDevices.find((device) => device.id === 'dev-off');

    expect(offDevice?.plannedState).toBe('keep');
    expect(offDevice?.reason).toBeUndefined();
  });

  it('plans first restore to lowest non-zero step for an off stepped device, even with retained higher step', () => {
    const state = createPlanEngineState();
    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'off',
          plannedState: 'keep',
          selectedStepId: 'medium',
          desiredStepId: 'medium',
          measuredPowerKw: 0,
          planningPowerKw: 2.0,
        }),
      ],
      context: buildContext({
        headroomRaw: 1.6, // Enough for low (1.25 + 0.23 buffer = 1.48), but NOT enough for medium (2.0 + 0.3 buffer = 2.3)
        headroom: 1.6,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    // It should successfully plan a restore to 'low'
    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(steppedDevice?.reason).toBe('restore medium -> low (need 1.48kW)');
  });

  it('applies shedding cooldown reason to stepped restore candidates as well as off devices', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastRecoveryMs = now - 5_000;

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-off',
          name: 'Heater',
          currentState: 'off',
          powerKw: 2,
          expectedPowerKw: 2,
        }),
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          selectedStepId: 'low',
          desiredStepId: 'low',
          currentState: 'on',
          measuredPowerKw: 1.25,
          planningPowerKw: 1.25,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const binaryDevice = result.planDevices.find((device) => device.id === 'dev-off');
    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(binaryDevice?.reason).toBe('cooldown (shedding, 55s remaining)');
    expect(steppedDevice?.reason).toBe('cooldown (shedding, 55s remaining)');
    expect(steppedDevice?.desiredStepId).toBe('low');
  });

  it('applies restore cooldown reason to stepped restore candidates during recent restore cooldown', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastRestoreMs = now - 5_000;

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          selectedStepId: 'low',
          desiredStepId: 'low',
          currentState: 'on',
          measuredPowerKw: 1.25,
          planningPowerKw: 1.25,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.reason).toBe('cooldown (restore, 55s remaining)');
    expect(steppedDevice?.desiredStepId).toBe('low');
  });
});
