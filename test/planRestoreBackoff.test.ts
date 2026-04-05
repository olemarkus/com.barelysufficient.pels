import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PlanContext } from '../lib/plan/planContext';
import {
  ACTIVATION_BACKOFF_STICK_WINDOW_MS,
  ACTIVATION_SETBACK_RESTORE_BLOCK_MS,
  getActivationPenaltyLevel,
  getActivationRestoreBlockRemainingMs,
  recordActivationAttemptStart,
  recordActivationSetback,
} from '../lib/plan/planActivationBackoff';
import { RESTORE_ADMISSION_FLOOR_KW, SWAP_TIMEOUT_MS } from '../lib/plan/planConstants';
import { planRestoreForSteppedDevice } from '../lib/plan/planRestoreHelpers';
import { applyShedTemperatureHold } from '../lib/plan/planReasons';
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
    expect(steppedDevice?.reason).toMatch(/shed invariant/);
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
    expect(steppedDevice?.reason).toMatch(/shed invariant/);
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
    expect(steppedDevice?.reason).toMatch(/shed invariant/);
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
        headroomRaw: 2.0, // Enough for low plus 0.50kW (reserve + floor), but NOT enough for medium
        headroom: 2.0,
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

  it('blocks binary restores during startup stabilization', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-off',
          name: 'Startup Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
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

    const device = result.planDevices.find((entry) => entry.id === 'dev-off');
    expect(device?.plannedState).toBe('shed');
    expect(device?.reason).toBe('startup stabilization');
  });

  it('blocks stepped restore during startup stabilization', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Startup Tank',
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

    const device = result.planDevices.find((entry) => entry.id === 'dev-step');
    expect(device?.desiredStepId).toBe('low');
    expect(device?.reason).toBe('startup stabilization');
  });

  it('does not block non-capacity restores during startup stabilization', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-off',
          name: 'Budget Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
        softLimitSource: 'daily',
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

    const device = result.planDevices.find((entry) => entry.id === 'dev-off');
    expect(device?.plannedState).toBe('keep');
    expect(device?.reason).not.toBe('startup stabilization');
  });

  it('returns effective timing for non-capacity restores during startup stabilization', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-off',
          name: 'Budget Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
        softLimitSource: 'daily',
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 15, stepId: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    expect(result.inStartupStabilization).toBe(false);
    expect(result.inShedWindow).toBe(false);
  });
});

// Shared deps factory for restore tests below
const makeDeps = () => ({
  powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
  getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
  log: jest.fn(),
  logDebug: jest.fn(),
});


describe('restore → overshoot attribution → penalty → re-restore block', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('pre-stick shed writes lastSetbackMs and blocks restore for 10 minutes', () => {
    // §3.1: Prove restore→overshoot→shed loop is broken when shed happens before stick window.
    const state = createPlanEngineState();
    const deviceId = 'dev-heater';
    const T0 = Date.UTC(2024, 0, 1, 10, 0, 0);
    jest.setSystemTime(T0);

    // T=0: restore actuation — attempt started
    recordActivationAttemptStart({ state, deviceId, source: 'pels_restore', nowTs: T0 });
    state.lastDeviceRestoreMs[deviceId] = T0;

    // T=14s: overshoot attribution — shed before stick window
    const T14s = T0 + 14_000;
    const setback = recordActivationSetback({ state, deviceId, nowTs: T14s });

    expect(setback.bumped).toBe(true);
    expect(setback.penaltyLevel).toBe(1);
    expect(state.activationAttemptByDevice[deviceId]?.lastSetbackMs).toBe(T14s);

    // T=60s: restore cooldown expires — device should be blocked by activation setback
    const T60s = T0 + 60_000;
    jest.setSystemTime(T60s);
    const blockRemaining = getActivationRestoreBlockRemainingMs({
      state,
      deviceId,
      nowTs: T60s,
    });
    expect(blockRemaining).toBeGreaterThan(0);
    expect(blockRemaining).toBeLessThanOrEqual(ACTIVATION_SETBACK_RESTORE_BLOCK_MS);

    // applyRestorePlan should block the device
    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: deviceId,
          name: 'Water Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
      ],
      context: buildContext({ headroomRaw: 5, headroom: 5 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });

    const dev = result.planDevices.find((d) => d.id === deviceId);
    expect(dev?.plannedState).toBe('shed');
    expect(dev?.reason).toMatch(/activation backoff/);
  });

  it('post-stick shed refreshes lastSetbackMs so the time block stays active', () => {
    // §3.1 / H3 fix: after the stick window, shedding should still update lastSetbackMs
    // so the 10-minute restore block restarts. Without the fix, lastSetbackMs is not updated
    // and getActivationRestoreBlockRemainingMs returns null.
    const state = createPlanEngineState();
    const deviceId = 'dev-heater';
    const T0 = Date.UTC(2024, 0, 1, 10, 0, 0);

    // Pre-stick setback → L1, lastSetbackMs set at T0+5s
    recordActivationAttemptStart({ state, deviceId, source: 'pels_restore', nowTs: T0 });
    recordActivationSetback({ state, deviceId, nowTs: T0 + 5_000 });

    // New attempt started; shed happens after stick window
    recordActivationAttemptStart({ state, deviceId, source: 'pels_restore', nowTs: T0 + 65_000 });
    const TPostStick = T0 + 65_000 + ACTIVATION_BACKOFF_STICK_WINDOW_MS + 60_000;
    const setback = recordActivationSetback({ state, deviceId, nowTs: TPostStick });

    expect(setback.bumped).toBe(false); // stickReached → no level bump, still expected

    // lastSetbackMs should be updated to TPostStick so the block restarts
    expect(state.activationAttemptByDevice[deviceId]?.lastSetbackMs).toBe(TPostStick);

    // Block should be active immediately after the post-stick shed
    const blockRemaining = getActivationRestoreBlockRemainingMs({
      state,
      deviceId,
      nowTs: TPostStick + 1_000,
    });
    expect(blockRemaining).toBeGreaterThan(0);
  });

  it('block expires after stick window and device is admitted with elevated headroom', () => {
    // §3.3: Full cycle — after block expires, device restores but requires penalty headroom.
    const state = createPlanEngineState();
    const deviceId = 'dev-heater';
    const T0 = Date.UTC(2024, 0, 1, 10, 0, 0);
    jest.setSystemTime(T0);

    // Simulate: restore attempted, overshoot attributed (pre-stick)
    recordActivationAttemptStart({ state, deviceId, source: 'pels_restore', nowTs: T0 });
    state.lastDeviceRestoreMs[deviceId] = T0;
    recordActivationSetback({ state, deviceId, nowTs: T0 + 14_000 }); // L0 → L1

    expect(getActivationPenaltyLevel(state, deviceId)).toBe(1);

    // Block is active at T=60s
    expect(getActivationRestoreBlockRemainingMs({ state, deviceId, nowTs: T0 + 60_000 }))
      .toBeGreaterThan(0);

    // Block expires 10min after lastSetbackMs (T0+14s), not T0
    const TAfterBlock = T0 + 14_000 + ACTIVATION_SETBACK_RESTORE_BLOCK_MS + 1_000;
    jest.setSystemTime(TAfterBlock);
    expect(getActivationRestoreBlockRemainingMs({ state, deviceId, nowTs: TAfterBlock })).toBeNull();

    // Device needs penalty headroom: L1 adds ~15% extra above base
    // base: expected=2kW + buffer=0.3kW = 2.3kW; penalty L1: ~15% → ~2.65kW
    // With headroom=2.2kW (below penalty threshold) → still blocked by headroom
    const resultInsufficient = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: deviceId,
          name: 'Water Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
      ],
      context: buildContext({ headroomRaw: 2.2, headroom: 2.2 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });
    const devInsufficient = resultInsufficient.planDevices.find((d) => d.id === deviceId);
    expect(devInsufficient?.plannedState).toBe('shed');
    expect(devInsufficient?.reason).toMatch(/insufficient headroom/);

    // With headroom=3.5kW (above penalty threshold + 0.50kW floor) → admitted
    const resultAdmitted = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: deviceId,
          name: 'Water Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
      ],
      context: buildContext({ headroomRaw: 3.5, headroom: 3.5 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });
    const devAdmitted = resultAdmitted.planDevices.find((d) => d.id === deviceId);
    expect(devAdmitted?.plannedState).toBe('keep');
  });
});

describe('restore admission — headroom and penalty gates', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('admits device when headroom exactly meets base need plus admission reserve plus floor', () => {
    const state = createPlanEngineState();
    // expected=2kW, buffer=0.3kW → needed=2.3kW, plus 0.25kW reserve + 0.25kW floor = 2.80kW
    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
        }),
      ],
      context: buildContext({ headroomRaw: 2.80, headroom: 2.80 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });
    expect(result.planDevices.find((d) => d.id === 'dev')?.plannedState).toBe('keep');
  });

  it('blocks device when headroom is just below base need plus admission reserve', () => {
    const state = createPlanEngineState();
    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
        }),
      ],
      context: buildContext({ headroomRaw: 2.54, headroom: 2.54 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });
    const dev = result.planDevices.find((d) => d.id === 'dev');
    expect(dev?.plannedState).toBe('shed');
    expect(dev?.reason).toMatch(/insufficient headroom/);
  });

  it('requires postReserveMarginKw >= 0.25kW floor in addition to the 0.25kW admission reserve', () => {
    const state = createPlanEngineState();
    // expected=0.522kW, buffer=0.2kW → needed=0.722kW, plus 0.25kW reserve + 0.25kW floor = 1.222kW

    const rejected = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 0.522,
          measuredPowerKw: 0,
        }),
      ],
      context: buildContext({ headroomRaw: 1.1, headroom: 1.1 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });

    const admitted = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 0.522,
          measuredPowerKw: 0,
        }),
      ],
      context: buildContext({ headroomRaw: 1.25, headroom: 1.25 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });

    expect(rejected.planDevices.find((d) => d.id === 'dev')?.plannedState).toBe('shed');
    expect(admitted.planDevices.find((d) => d.id === 'dev')?.plannedState).toBe('keep');
  });

  it('device with expectedPowerKw=0 falls through to powerKw for admission — not 0.2kW only', () => {
    // H1 fix: expectedPowerKw=0 should not be treated as "device draws 0kW".
    // After fix, estimateRestorePower skips 0 and uses powerKw=2 → needed≈2.3kW.
    // 0.25kW headroom is insufficient → device blocked.
    const state = createPlanEngineState();
    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 0,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
      ],
      context: buildContext({ headroomRaw: 0.25, headroom: 0.25 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });
    const dev = result.planDevices.find((d) => d.id === 'dev');
    expect(dev?.plannedState).toBe('shed');
    expect(dev?.reason).toMatch(/insufficient headroom/);
  });

  it('recently shed device needs extra headroom via recent-shed multiplier', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    // Shed 20s ago — within the recent-shed backoff window
    state.lastDeviceShedMs['dev'] = now - 20_000;

    // Without recent-shed penalty: expected=2kW + buffer=0.3kW = 2.3kW needed
    // With recent-shed multiplier (1.5×): 2.3 * 1.5 = 3.45kW
    // 2.5kW headroom: sufficient without penalty, insufficient with it
    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
        }),
      ],
      context: buildContext({ headroomRaw: 2.5, headroom: 2.5 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });
    const dev = result.planDevices.find((d) => d.id === 'dev');
    expect(dev?.plannedState).toBe('shed');
    expect(dev?.reason).toMatch(/insufficient headroom/);
  });

  it('penalty L4 requires approximately double the base needed headroom', () => {
    // §3.4: penalty L4 → applyActivationPenalty gives max(base*2, base+1.2kW)
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    const deviceId = 'dev';

    // Set penalty level 4 with a fresh lastSetbackMs (block expired)
    state.activationAttemptByDevice[deviceId] = {
      penaltyLevel: 4,
      lastSetbackMs: now - ACTIVATION_SETBACK_RESTORE_BLOCK_MS - 1_000,
    };

    // base need: expected=2kW + buffer=0.3kW = 2.3kW
    // L4 penalty: max(2.3*2, 2.3+1.2) = max(4.6, 3.5) = 4.6kW
    // 3kW headroom: below 4.6 → blocked
    const resultBlocked = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: deviceId,
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
        }),
      ],
      context: buildContext({ headroomRaw: 3, headroom: 3 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });
    expect(resultBlocked.planDevices.find((d) => d.id === deviceId)?.plannedState).toBe('shed');

    // 5.1kW headroom: above 4.6 + 0.50kW floor → admitted
    const resultAdmitted = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: deviceId,
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
        }),
      ],
      context: buildContext({ headroomRaw: 5.1, headroom: 5.1 }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });
    expect(resultAdmitted.planDevices.find((d) => d.id === deviceId)?.plannedState).toBe('keep');
  });

  it('active setback blocks device before swap phase is reached', () => {
    // §3.4: when setback is active, planRestoreForDevice returns early — swap is never attempted
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    const deviceId = 'dev-off';

    // Fresh setback — block in effect
    state.activationAttemptByDevice[deviceId] = {
      penaltyLevel: 1,
      lastSetbackMs: now - 1_000, // 1s ago, block runs for 10min
    };

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: deviceId,
          name: 'Off Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
        }),
        // High-priority on device that could be swapped out
        buildPlanDevice({
          id: 'dev-on',
          name: 'On Heater',
          priority: 90,
          currentState: 'on',
          expectedPowerKw: 3,
          measuredPowerKw: 3,
          powerKw: 3,
        }),
      ],
      context: buildContext({ headroomRaw: 0, headroom: 0 }),
      state,
      sheddingActive: false,
      deps: {
        ...makeDeps(),
        getShedBehavior: (id: string) => id === 'dev-on'
          ? { action: 'turn_off' as const, temperature: null, stepId: null }
          : { action: 'turn_off' as const, temperature: null, stepId: null },
      },
    });

    const dev = result.planDevices.find((d) => d.id === deviceId);
    const onDev = result.planDevices.find((d) => d.id === 'dev-on');
    // Blocked by setback — swap should NOT have been attempted
    expect(dev?.plannedState).toBe('shed');
    expect(dev?.reason).toMatch(/activation backoff/);
    // On device should remain on (swap was not triggered)
    expect(onDev?.plannedState).toBe('keep');
  });

  it('uses full restore need for target-based restore instead of buffer-only headroom', () => {
    const state = createPlanEngineState();
    state.lastPlannedShedIds = new Set(['dev-temp']);

    const result = applyShedTemperatureHold({
      planDevices: [
        buildPlanDevice({
          id: 'dev-temp',
          name: 'Nordic S4 REL',
          currentState: 'keep',
          plannedState: 'keep',
          currentTarget: 18,
          plannedTarget: 22,
          currentOn: true,
          shedAction: 'set_temperature',
          shedTemperature: 18,
          expectedPowerKw: 1.0,
          powerKw: 1.0,
        }),
      ],
      state,
      shedReasons: new Map(),
      inShedWindow: false,
      inCooldown: false,
      activeOvershoot: false,
      availableHeadroom: 0.25,
      restoredOneThisCycle: false,
      restoredThisCycle: new Set(),
      shedCooldownRemainingSec: null,
      holdDuringRestoreCooldown: false,
      restoreCooldownSeconds: 60,
      restoreCooldownRemainingSec: null,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 18, stepId: null }),
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-temp');
    expect(device?.plannedTarget).toBe(18);
    expect(device?.reason).toContain('insufficient headroom');
    expect(result.restoredOneThisCycle).toBe(false);
  });

  it('blocks target-based restore on activation setback and logs the rejection', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    jest.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastPlannedShedIds = new Set(['dev-temp']);
    state.activationAttemptByDevice['dev-temp'] = {
      penaltyLevel: 1,
      lastSetbackMs: now - 1_000,
    };
    const structuredLog = { debug: jest.fn(), info: jest.fn() };

    const result = applyShedTemperatureHold({
      planDevices: [
        buildPlanDevice({
          id: 'dev-temp',
          name: 'Nordic S4 REL',
          currentState: 'keep',
          plannedState: 'keep',
          currentTarget: 18,
          plannedTarget: 22,
          currentOn: true,
          shedAction: 'set_temperature',
          shedTemperature: 18,
          expectedPowerKw: 1.0,
          powerKw: 1.0,
        }),
      ],
      state,
      shedReasons: new Map(),
      inShedWindow: false,
      inCooldown: false,
      activeOvershoot: false,
      availableHeadroom: 3,
      restoredOneThisCycle: false,
      restoredThisCycle: new Set(),
      shedCooldownRemainingSec: null,
      holdDuringRestoreCooldown: false,
      restoreCooldownSeconds: 60,
      restoreCooldownRemainingSec: null,
      structuredLog: structuredLog as any,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 18, stepId: null }),
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-temp');
    expect(device?.plannedTarget).toBe(18);
    expect(device?.reason).toMatch(/activation backoff/);
    expect(structuredLog.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_rejected',
      restoreType: 'target',
      deviceId: 'dev-temp',
    }));
  });
});

describe('restore admission floor — 0.250 kW postReserveMarginKw minimum', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const makeDepsFloor = () => ({
    powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
    getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
    logDebug: jest.fn(),
  });

  it(`RESTORE_ADMISSION_FLOOR_KW is ${RESTORE_ADMISSION_FLOOR_KW}kW`, () => {
    expect(RESTORE_ADMISSION_FLOOR_KW).toBe(0.25);
  });

  it('rejects binary restore when postReserveMarginKw is 0.249 (below floor)', () => {
    const state = createPlanEngineState();
    // needed = 1.2kW (expected=1 + buffer=0.2), reserve=0.25, floor=0.25 → min headroom = 1.70kW
    // headroom = 1.699 → postReserveMarginKw = 1.699 - 1.2 - 0.25 = 0.249 < floor
    const result = applyRestorePlan({
      planDevices: [buildPlanDevice({ id: 'dev', name: 'Heater', currentState: 'off', expectedPowerKw: 1, measuredPowerKw: 0 })],
      context: buildContext({ headroomRaw: 1.699, headroom: 1.699 }),
      state,
      sheddingActive: false,
      deps: makeDepsFloor(),
    });
    expect(result.planDevices.find((d) => d.id === 'dev')?.plannedState).toBe('shed');
  });

  it('admits binary restore when postReserveMarginKw is exactly 0.250 (at floor)', () => {
    const state = createPlanEngineState();
    // headroom = 1.700 → postReserveMarginKw = 1.700 - 1.2 - 0.25 = 0.250 = floor
    const result = applyRestorePlan({
      planDevices: [buildPlanDevice({ id: 'dev', name: 'Heater', currentState: 'off', expectedPowerKw: 1, measuredPowerKw: 0 })],
      context: buildContext({ headroomRaw: 1.7, headroom: 1.7 }),
      state,
      sheddingActive: false,
      deps: makeDepsFloor(),
    });
    expect(result.planDevices.find((d) => d.id === 'dev')?.plannedState).toBe('keep');
  });

  it('rejects target restore when postReserveMarginKw is below floor', () => {
    const state = createPlanEngineState();
    state.lastPlannedShedIds = new Set(['dev-temp']);
    const { applyShedTemperatureHold } = jest.requireActual('../lib/plan/planReasons') as typeof import('../lib/plan/planReasons');
    // This exercises the target-restore headroom path via applyShedTemperatureHold
    const result = applyShedTemperatureHold({
      planDevices: [buildPlanDevice({
        id: 'dev-temp',
        name: 'Thermostat',
        currentState: 'keep',
        plannedState: 'keep',
        currentTarget: 16,
        plannedTarget: 20,
        currentOn: true,
        shedAction: 'set_temperature',
        shedTemperature: 16,
        expectedPowerKw: 1.0,
        powerKw: 1.0,
      })],
      state,
      shedReasons: new Map(),
      inShedWindow: false,
      inCooldown: false,
      activeOvershoot: false,
      availableHeadroom: 1.699,
      restoredOneThisCycle: false,
      restoredThisCycle: new Set(),
      shedCooldownRemainingSec: null,
      holdDuringRestoreCooldown: false,
      restoreCooldownSeconds: 60,
      restoreCooldownRemainingSec: null,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16, stepId: null }),
    });
    const device = result.planDevices.find((d) => d.id === 'dev-temp');
    expect(device?.plannedTarget).toBe(16);
    expect(device?.reason).toContain('insufficient headroom');
  });

  it('rejects stepped restore when postReserveMarginKw is below floor', () => {
    const state = createPlanEngineState();
    const deviceMap = new Map([
      ['dev-step', steppedPlanDevice({
        id: 'dev-step',
        name: 'Tank',
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'off',
        desiredStepId: undefined,
        measuredPowerKw: 0,
      })],
    ]);

    // low step = 1.25kW, buffer≈0.225, needed≈1.475, reserve=0.25, floor=0.25 → min=1.975kW
    // Use 1.974 → postReserveMarginKw = 1.974 - 1.475 - 0.25 = 0.249 < floor
    planRestoreForSteppedDevice({
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: {
        activeOvershoot: false, inCooldown: false, inRestoreCooldown: false,
        inStartupStabilization: false, restoreCooldownSeconds: 60,
        shedCooldownRemainingSec: null, restoreCooldownRemainingSec: null,
        startupStabilizationRemainingSec: null,
      },
      availableHeadroom: 1.974,
      restoredOneThisCycle: false,
      logDebug: jest.fn(),
    });

    const dev = deviceMap.get('dev-step')!;
    expect(dev.desiredStepId).toBeUndefined();
    expect(dev.reason).toContain('insufficient headroom');
  });

  it('admits stepped restore when postReserveMarginKw is exactly at the floor', () => {
    const state = createPlanEngineState();
    const deviceMap = new Map([
      ['dev-step', steppedPlanDevice({
        id: 'dev-step',
        name: 'Tank',
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'off',
        desiredStepId: undefined,
        measuredPowerKw: 0,
      })],
    ]);

    // needed≈1.475, reserve=0.25, floor=0.25 → exact min = 1.975kW
    planRestoreForSteppedDevice({
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: {
        activeOvershoot: false, inCooldown: false, inRestoreCooldown: false,
        inStartupStabilization: false, restoreCooldownSeconds: 60,
        shedCooldownRemainingSec: null, restoreCooldownRemainingSec: null,
        startupStabilizationRemainingSec: null,
      },
      availableHeadroom: 1.975,
      restoredOneThisCycle: false,
      logDebug: jest.fn(),
    });

    expect(deviceMap.get('dev-step')!.desiredStepId).toBe('low');
  });
});

describe('stepped-load shed invariant', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const makeShedTiming = () => ({
    activeOvershoot: false,
    inCooldown: false,
    inRestoreCooldown: false,
    inStartupStabilization: false,
    restoreCooldownSeconds: 60,
    shedCooldownRemainingSec: null as null,
    restoreCooldownRemainingSec: null as null,
    startupStabilizationRemainingSec: null as null,
  });

  it('rejects stepped upgrade from medium to max while another device is shed', () => {
    const state = createPlanEngineState();
    const shedDevice = { ...require('./utils/planTestUtils').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true, powerKw: 1 }) };
    const steppedDev = steppedPlanDevice({
      id: 'dev-step',
      name: 'Tank',
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'medium',
    });
    const deviceMap = new Map([
      ['binary-shed', shedDevice],
      ['dev-step', steppedDev],
    ]);

    planRestoreForSteppedDevice({
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: jest.fn(),
    });

    const dev = deviceMap.get('dev-step')!;
    // desiredStepId must NOT be changed to 'max' — shed invariant blocks the upgrade
    expect(dev.desiredStepId).toBe('medium');
    expect(dev.reason).toMatch(/shed invariant/);
  });

  it('allows restore from off to low (lowest non-zero step) while another device is shed', () => {
    const state = createPlanEngineState();
    const shedDevice = { ...require('./utils/planTestUtils').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true }) };
    const steppedDev = steppedPlanDevice({
      id: 'dev-step',
      name: 'Tank',
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: undefined,
      measuredPowerKw: 0,
    });
    const deviceMap = new Map([
      ['binary-shed', shedDevice],
      ['dev-step', steppedDev],
    ]);

    planRestoreForSteppedDevice({
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: jest.fn(),
    });

    // off → low is allowed because low IS the lowest non-zero step
    expect(deviceMap.get('dev-step')!.desiredStepId).toBe('low');
  });

  it('allows restore from off to medium when medium is the lowest non-zero step while another device is shed', () => {
    // Simulate: selectedStepId='off' with a profile where medium is the lowestNonZeroStep.
    // getSteppedLoadNextRestoreStep returns medium (lowest non-zero step when device is off).
    // This verifies the invariant is enforced at the correct profile boundary:
    // off→medium is allowed because medium IS the lowest non-zero step in this profile.
    const state = createPlanEngineState();
    const shedDevice = { ...require('./utils/planTestUtils').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true }) };

    // Use a profile where steps go: off(0), medium(2000), max(3000) — no 'low' step.
    // The restore step is then 'medium' (lowest non-zero), so off→medium is allowed.
    // This verifies the invariant cap works at the correct profile boundary.
    const profileNoLow = {
      model: 'stepped_load' as const,
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'medium', planningPowerW: 2000 },
        { id: 'max', planningPowerW: 3000 },
      ],
    };
    const steppedDev = steppedPlanDevice({
      id: 'dev-step',
      name: 'Tank',
      currentState: 'off',
      plannedState: 'keep',
      steppedLoadProfile: profileNoLow,
      selectedStepId: 'off',
      desiredStepId: undefined,
      measuredPowerKw: 0,
    });
    const deviceMap = new Map([
      ['binary-shed', shedDevice],
      ['dev-step', steppedDev],
    ]);

    planRestoreForSteppedDevice({
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: jest.fn(),
    });

    // 'medium' is the lowestNonZeroStep for this profile, so off→medium is allowed
    expect(deviceMap.get('dev-step')!.desiredStepId).toBe('medium');
  });

  it('allows stepped upgrade from medium to max after all shed devices are restored', () => {
    const state = createPlanEngineState();
    // No shed devices in the map
    const steppedDev = steppedPlanDevice({
      id: 'dev-step',
      name: 'Tank',
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'medium',
    });
    const deviceMap = new Map([['dev-step', steppedDev]]);

    planRestoreForSteppedDevice({
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: jest.fn(),
    });

    // No shed devices → upgrade to max is allowed
    expect(deviceMap.get('dev-step')!.desiredStepId).toBe('max');
  });

  it('restore_stepped_rejected event is emitted with blockedByShedInvariant=true on upgrade block', () => {
    const state = createPlanEngineState();
    const shedDevice = { ...require('./utils/planTestUtils').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true }) };
    const steppedDev = steppedPlanDevice({
      id: 'dev-step',
      name: 'Tank',
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'medium',
    });
    const deviceMap = new Map([
      ['binary-shed', shedDevice],
      ['dev-step', steppedDev],
    ]);
    const structuredLog = { info: jest.fn(), debug: jest.fn() };

    planRestoreForSteppedDevice({
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: jest.fn(),
      structuredLog: structuredLog as any,
    });

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_stepped_rejected',
      blockedByShedInvariant: true,
      shedDeviceCount: 1,
      currentStepId: 'medium',
      requestedStepId: 'max',
      lowestNonZeroStepId: 'low',
      allowedMaxStepId: 'low',
      rejectionReason: 'shed_invariant',
    }));
  });

  it('upward step action is never emitted while shed devices exist (end-to-end via applyRestorePlan)', () => {
    const state = createPlanEngineState();
    const result = applyRestorePlan({
      planDevices: [
        require('./utils/planTestUtils').buildPlanDevice({
          id: 'binary-shed',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'shed',
          controllable: true,
          powerKw: 2,
        }),
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'on',
          plannedState: 'keep',
          selectedStepId: 'medium',
          desiredStepId: 'medium',
        }),
      ],
      context: buildContext({ headroomRaw: 5, headroom: 5 }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        logDebug: jest.fn(),
      },
    });

    const steppedDev = result.planDevices.find((d) => d.id === 'dev-step');
    // desiredStepId must not have been upgraded to 'max' — binary-shed device is still shed
    expect(steppedDev?.desiredStepId).toBe('medium');
    expect(steppedDev?.reason).toMatch(/shed invariant/);
  });
});
