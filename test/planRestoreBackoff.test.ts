import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PlanContext } from '../lib/plan/planContext';
import { PLAN_REASON_CODES } from '../packages/shared-domain/src/planReasonSemantics';
import {
  ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  ACTIVATION_SETBACK_RESTORE_BLOCK_MS,
  getActivationPenaltyLevel,
  getActivationRestoreBlockRemainingMs,
  recordActivationAttemptStart,
  recordActivationSetback,
} from '../lib/plan/planActivationBackoff';
import { RESTORE_ADMISSION_FLOOR_KW, SWAP_TIMEOUT_MS } from '../lib/plan/planConstants';
import { NEUTRAL_STARTUP_HOLD_REASON } from '../lib/plan/planRestoreDevices';
import { planRestoreForSteppedDevice } from '../lib/plan/planRestoreHelpers';
import { applyShedTemperatureHold } from '../lib/plan/planReasons';
import { createPlanEngineState } from '../lib/plan/planState';
import { applyRestorePlan } from '../lib/plan/planRestore';
import { resolveMeterSettlingRemainingSec } from '../lib/plan/planRestoreTiming';
import { getPerfSnapshot } from '../lib/utils/perfCounters';
import { buildPlanDevice, steppedPlanDevice } from './utils/planTestUtils';
import { legacyDeviceReason, reasonText } from './utils/deviceReasonTestUtils';

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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('backs off restore cooldown from 60 to 120, 240, then caps at 300 seconds', () => {
    const state = createPlanEngineState();
    let now = Date.UTC(2024, 0, 1, 0, 0, 0);

    const deps = {
      powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
      getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
      log: vi.fn(),
      logDebug: vi.fn(),
    };

    const step = (advanceMs: number): number => {
      now += advanceMs;
      vi.setSystemTime(now);
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
      log: vi.fn(),
      logDebug: vi.fn(),
    };

    const triggerInstability = (): void => {
      state.lastRestoreMs = now - 2 * 60 * 1000;
      state.lastInstabilityMs = now - 1000;
    };

    triggerInstability();
    vi.setSystemTime(now);
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
    vi.setSystemTime(now);
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
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.swapByDevice = {
      'dev-on': { swappedOutFor: 'stale-target' },
      'stale-target': { pendingTarget: true, timestamp: now - SWAP_TIMEOUT_MS - 1000 },
    };

    const deps = {
      powerTracker: { lastTimestamp: 321 } as PowerTrackerState,
      getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
      log: vi.fn(),
      logDebug: vi.fn(),
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
    expect(reasonText(onDevice?.reason)).toBe('swapped out for Off');
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const binaryDevice = result.planDevices.find((device) => device.id === 'dev-off');
    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(binaryDevice?.plannedState).toBe('shed');
    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(reasonText(steppedDevice?.reason)).toMatch(/shed invariant/);
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const binaryDevice = result.planDevices.find((device) => device.id === 'dev-off');
    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(binaryDevice?.plannedState).toBe('keep');
    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(reasonText(steppedDevice?.reason)).toBe('waiting for other devices to recover');
  });

  it('blocks stepped-load step-up while another ordinary device is swapped out', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(reasonText(steppedDevice?.reason)).toMatch(/shed invariant/);
  });

  it('blocks stepped-load step-up while an ordinary device is still swap pending', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(reasonText(steppedDevice?.reason)).toMatch(/shed invariant/);
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('medium');
    expect(reasonText(steppedDevice?.reason)).toBe('restore low -> medium (need 0.95kW)');
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const tempDevice = result.planDevices.find((device) => device.id === 'dev-temp');
    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(tempDevice?.plannedState).toBe('keep');
    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(reasonText(steppedDevice?.reason)).toBe('waiting for other devices to recover');
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');
    const offDevice = result.planDevices.find((device) => device.id === 'dev-off');

    expect(steppedDevice?.plannedState).toBe('keep');
    expect(offDevice?.plannedState).toBe('shed');
    expect(reasonText(offDevice?.reason)).toBe('waiting for other devices to recover');
  });

  it('does not re-admit the same stepped restore while that step is still awaiting confirmation', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'on',
          selectedStepId: 'low',
          desiredStepId: 'medium',
          lastDesiredStepId: 'medium',
          lastStepCommandIssuedAt: now - 10_000,
          stepCommandPending: true,
          stepCommandStatus: 'pending',
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
      deps: makeDeps(),
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('medium');
    expect(steppedDevice?.expectedPowerKw).toBe(2);
    expect(reasonText(steppedDevice?.reason)).toBe('restore pending (80s remaining)');
    expect(result.availableHeadroom).toBeCloseTo(4.05);
    expect(result.restoredOneThisCycle).toBe(true);
  });

  it('holds a timed-out stepped restore in retry backoff without reserving headroom or surfacing restore pending', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'on',
          selectedStepId: 'low',
          desiredStepId: 'medium',
          lastDesiredStepId: 'medium',
          lastStepCommandIssuedAt: now - 95_000,
          stepCommandPending: false,
          stepCommandStatus: 'stale',
          nextStepCommandRetryAtMs: now + 30_000,
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
      deps: makeDeps(),
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('medium');
    expect(steppedDevice?.expectedPowerKw).toBe(2);
    expect(reasonText(steppedDevice?.reason)).toBe('keep');
    expect(result.availableHeadroom).toBeCloseTo(5);
    expect(result.restoredOneThisCycle).toBe(false);
  });

  it('still reserves confirmed stepped restore headroom without forcing a cooldown reason onto the plan state', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastRestoreMs = now - 10_000;
    state.lastDeviceRestoreMs['dev-step'] = now - 10_000;

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'on',
          currentOn: true,
          selectedStepId: 'medium',
          previousStepId: 'low',
          desiredStepId: 'medium',
          lastDesiredStepId: 'medium',
          stepCommandPending: false,
          stepCommandStatus: 'success',
          measuredPowerKw: 1.25,
          planningPowerKw: 2,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(reasonText(steppedDevice?.reason)).toBe('keep');
    expect(result.availableHeadroom).toBeCloseTo(4.25);
    expect(result.restoredOneThisCycle).toBe(false);
  });

  it('uses current effective draw for an in-flight stepped reservation instead of a stale selected-step baseline', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    const before = getPerfSnapshot();

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'connected-300',
          name: 'Connected 300',
          currentState: 'on',
          selectedStepId: 'low',
          desiredStepId: 'medium',
          lastDesiredStepId: 'medium',
          lastStepCommandIssuedAt: now - 10_000,
          stepCommandPending: true,
          stepCommandStatus: 'pending',
          measuredPowerKw: 2.0,
          planningPowerKw: 1.25,
        }),
      ],
      context: buildContext({
        headroomRaw: 5,
        headroom: 5,
      }),
      state,
      sheddingActive: false,
      deps: makeDeps(),
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'connected-300');
    const after = getPerfSnapshot();

    expect(steppedDevice?.desiredStepId).toBe('medium');
    expect(reasonText(steppedDevice?.reason)).toBe('restore pending (80s remaining)');
    expect(result.availableHeadroom).toBeCloseTo(5);
    expect(result.restoredOneThisCycle).toBe(true);
    expect(
      (after.counts.restore_planning_skipped_inflight || 0) - (before.counts.restore_planning_skipped_inflight || 0),
    ).toBe(1);
  });

  it('reserves headroom for a deferred stepped restore and blocks a second stepped restore in the same cycle', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step-a',
          name: 'Tank A',
          priority: 10,
          currentState: 'on',
          selectedStepId: 'low',
          desiredStepId: 'medium',
          lastDesiredStepId: 'medium',
          lastStepCommandIssuedAt: now - 10_000,
          stepCommandPending: true,
          stepCommandStatus: 'pending',
          measuredPowerKw: 1.25,
          planningPowerKw: 1.25,
        }),
        steppedPlanDevice({
          id: 'dev-step-b',
          name: 'Tank B',
          priority: 20,
          currentState: 'on',
          selectedStepId: 'low',
          desiredStepId: 'low',
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
      deps: makeDeps(),
    });

    const firstSteppedDevice = result.planDevices.find((device) => device.id === 'dev-step-a');
    const secondSteppedDevice = result.planDevices.find((device) => device.id === 'dev-step-b');

    expect(firstSteppedDevice?.desiredStepId).toBe('medium');
    expect(firstSteppedDevice?.expectedPowerKw).toBe(2);
    expect(reasonText(firstSteppedDevice?.reason)).toBe('restore pending (80s remaining)');
    expect(secondSteppedDevice?.desiredStepId).toBe('low');
    expect(result.availableHeadroom).toBeCloseTo(4.05);
    expect(result.restoredOneThisCycle).toBe(true);
  });

  it('re-admits a timed-out stepped restore once retry backoff has expired', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'on',
          selectedStepId: 'low',
          desiredStepId: 'medium',
          lastDesiredStepId: 'medium',
          lastStepCommandIssuedAt: now - 95_000,
          stepCommandPending: false,
          stepCommandStatus: 'stale',
          nextStepCommandRetryAtMs: now - 1_000,
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
      deps: makeDeps(),
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('medium');
    expect(reasonText(steppedDevice?.reason)).toBe('restore low -> medium (need 0.95kW)');
    expect(result.availableHeadroom).toBeCloseTo(4.05);
    expect(result.restoredOneThisCycle).toBe(true);
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const offDevice = result.planDevices.find((device) => device.id === 'dev-off');

    expect(offDevice?.plannedState).toBe('keep');
    expect(offDevice?.reason).toEqual(legacyDeviceReason('keep'));
  });

  it('normalizes an off stepped device back to the lowest non-zero restore step', () => {
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
        headroomRaw: 3.0,
        headroom: 3.0,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(steppedDevice?.desiredStepId).toBe('low');
    expect(reasonText(steppedDevice?.reason)).toBe('restore medium -> low (need 1.48kW)');
  });

  it('normalizes an unknown-step off restore to the lowest non-zero step and can step up later', () => {
    const state = createPlanEngineState();
    const firstRestore = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'off',
          plannedState: 'keep',
          selectedStepId: undefined as unknown as string,
          desiredStepId: 'max',
          measuredPowerKw: 0,
          expectedPowerKw: 3.0,
          planningPowerKw: 3.0,
        }),
      ],
      context: buildContext({
        headroomRaw: 2.0,
        headroom: 2.0,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const restored = firstRestore.planDevices.find((device) => device.id === 'dev-step');
    expect(restored?.desiredStepId).toBe('low');
    expect(restored?.expectedPowerKw).toBeCloseTo(1.25);
    expect(reasonText(restored?.reason)).toBe('restore unknown -> low (need 1.48kW)');

    const secondRestore = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'on',
          plannedState: 'keep',
          selectedStepId: 'low',
          desiredStepId: 'low',
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    expect(secondRestore.planDevices.find((device) => device.id === 'dev-step')?.desiredStepId).toBe('medium');
  });

  it('applies shedding cooldown reason to stepped restore candidates as well as off devices', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const binaryDevice = result.planDevices.find((device) => device.id === 'dev-off');
    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(reasonText(binaryDevice?.reason)).toBe('cooldown (shedding, 55s remaining)');
    expect(reasonText(steppedDevice?.reason)).toBe('cooldown (shedding, 55s remaining)');
    expect(steppedDevice?.desiredStepId).toBe('low');
  });

  it('keeps stepped restore candidates on shed cooldown when shed and restore windows overlap', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastRecoveryMs = now - 5_000;
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');
    expect(reasonText(steppedDevice?.reason)).toBe('cooldown (shedding, 55s remaining)');
  });

  it('applies meter settling only to off keep devices during recent restore cooldown', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastRestoreMs = now - 5_000;

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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const binaryDevice = result.planDevices.find((device) => device.id === 'dev-off');
    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');

    expect(binaryDevice?.plannedState).toBe('keep');
    expect(reasonText(binaryDevice?.reason)).toBe('meter settling (55s remaining)');
    expect(reasonText(steppedDevice?.reason)).not.toBe('meter settling (55s remaining)');
    expect(steppedDevice?.desiredStepId).toBe('low');
  });

  it('applies meter settling to off-like stepped keep devices during recent restore cooldown', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastRestoreMs = now - 5_000;

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'off',
          selectedStepId: 'off',
          desiredStepId: 'low',
          targetStepId: 'low',
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');
    expect(steppedDevice?.plannedState).toBe('keep');
    expect(reasonText(steppedDevice?.reason)).toBe('meter settling (55s remaining)');
    expect(steppedDevice?.desiredStepId).toBe('low');
  });

  it('does not let restore cooldown rewrite a shed stepped device back to keep', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastRestoreMs = now - 5_000;
    state.lastDeviceRestoreMs['dev-step'] = now - 5_000;

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Tank',
          currentState: 'off',
          currentOn: false,
          plannedState: 'shed',
          reason: { code: PLAN_REASON_CODES.hourlyBudget, detail: null },
          selectedStepId: 'off',
          desiredStepId: 'low',
          lastDesiredStepId: 'low',
          lastStepCommandIssuedAt: now - 10_000,
          stepCommandPending: true,
          stepCommandStatus: 'pending',
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
      deps: makeDeps(),
    });

    const steppedDevice = result.planDevices.find((device) => device.id === 'dev-step');
    expect(steppedDevice?.plannedState).toBe('shed');
    expect(reasonText(steppedDevice?.reason)).toBe('shed due to hourly budget');
  });

  it('keeps the device that restored this cycle on its own reason while later peers get meter settling', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-restored',
          name: 'Priority Heater',
          priority: 1,
          currentState: 'off',
          powerKw: 2,
          expectedPowerKw: 2,
        }),
        buildPlanDevice({
          id: 'dev-waiting',
          name: 'Waiting Heater',
          priority: 2,
          currentState: 'off',
          powerKw: 2,
          expectedPowerKw: 2,
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const restoredDevice = result.planDevices.find((device) => device.id === 'dev-restored');
    const waitingDevice = result.planDevices.find((device) => device.id === 'dev-waiting');

    expect(restoredDevice?.plannedState).toBe('keep');
    expect(restoredDevice?.reason).not.toBe('meter settling (60s remaining)');
    expect(waitingDevice?.plannedState).toBe('keep');
    expect(reasonText(waitingDevice?.reason)).toBe('meter settling (60s remaining)');
  });

  it('falls back to restoreCooldownSeconds when meter settling remaining seconds are unavailable', () => {
    expect(resolveMeterSettlingRemainingSec({
      timing: {
        activeOvershoot: false,
        inRestoreCooldown: true,
        restoreCooldownSeconds: 60,
        restoreCooldownRemainingSec: null,
      },
    })).toBe(60);
  });

  it('keeps never-controlled off devices shed with a neutral startup-hold reason', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-off');
    expect(device?.plannedState).toBe('shed');
    expect(device?.reason).toEqual(NEUTRAL_STARTUP_HOLD_REASON);
  });

  it('shows startup stabilization for off devices PELS controlled before restart', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;
    state.lastDeviceControlledMs['dev-off'] = now - (10 * 60_000);

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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-off');
    expect(device?.plannedState).toBe('shed');
    expect(reasonText(device?.reason)).toBe('startup stabilization');
  });

  it('keeps startup-stabilization reason neutral for never-controlled stepped restores', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-step');
    expect(device?.desiredStepId).toBe('low');
    expect(device?.reason).toEqual(legacyDeviceReason('keep'));
  });

  it('shows startup stabilization for stepped restores PELS controlled before restart', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;
    state.lastDeviceControlledMs['dev-step'] = now - (10 * 60_000);

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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-step');
    expect(device?.desiredStepId).toBe('low');
    expect(reasonText(device?.reason)).toBe('startup stabilization');
  });

  it('keeps off stepped devices shed with a neutral startup-hold reason when never controlled', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step-off',
          name: 'Startup Tank Off',
          currentState: 'off',
          selectedStepId: 'off',
          desiredStepId: 'off',
          measuredPowerKw: 0,
          planningPowerKw: 0,
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-step-off');
    expect(device?.plannedState).toBe('shed');
    expect(device?.reason).toEqual(NEUTRAL_STARTUP_HOLD_REASON);
  });

  it('keeps off stepped devices shed with startup stabilization when previously controlled', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;
    state.lastDeviceControlledMs['dev-step-off'] = now - (10 * 60_000);

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step-off',
          name: 'Startup Tank Off',
          currentState: 'off',
          selectedStepId: 'off',
          desiredStepId: 'off',
          measuredPowerKw: 0,
          planningPowerKw: 0,
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-step-off');
    expect(device?.plannedState).toBe('shed');
    expect(reasonText(device?.reason)).toBe('startup stabilization');
  });

  it('prefers neutral startup hold over cooldown for never-controlled off stepped devices', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;
    state.lastInstabilityMs = now - 5_000;

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step-off',
          name: 'Startup Tank Off',
          currentState: 'off',
          selectedStepId: 'off',
          desiredStepId: 'off',
          measuredPowerKw: 0,
          planningPowerKw: 0,
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-step-off');
    expect(device?.plannedState).toBe('shed');
    expect(device?.reason).toEqual(NEUTRAL_STARTUP_HOLD_REASON);
  });

  it('does not block non-capacity restores during startup stabilization', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-off');
    expect(device?.plannedState).toBe('keep');
    expect(device?.reason).not.toBe('startup stabilization');
  });

  it('returns effective timing for non-capacity restores during startup stabilization', () => {
    const now = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(now);
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
        log: vi.fn(),
        logDebug: vi.fn(),
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
  log: vi.fn(),
  logDebug: vi.fn(),
});


describe('restore → overshoot attribution → penalty → re-restore block', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pre-stick shed writes lastSetbackMs and blocks restore for 10 minutes', () => {
    // §3.1: Prove restore→overshoot→shed loop is broken when shed happens before stick window.
    const state = createPlanEngineState();
    const deviceId = 'dev-heater';
    const T0 = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(T0);

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
    vi.setSystemTime(T60s);
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
    expect(reasonText(dev?.reason)).toMatch(/activation backoff/);
  });

  it('does not refresh lastSetbackMs once the attribution window has expired', () => {
    const state = createPlanEngineState();
    const deviceId = 'dev-heater';
    const T0 = Date.UTC(2024, 0, 1, 10, 0, 0);

    // Pre-stick setback → L1, lastSetbackMs set at T0+5s
    recordActivationAttemptStart({ state, deviceId, source: 'pels_restore', nowTs: T0 });
    recordActivationSetback({ state, deviceId, nowTs: T0 + 5_000 });

    // New attempt started; the attribution window expires before any explicit failure occurs.
    recordActivationAttemptStart({ state, deviceId, source: 'pels_restore', nowTs: T0 + 65_000 });
    const TPostStick = T0 + 65_000 + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 60_000;
    const setback = recordActivationSetback({ state, deviceId, nowTs: TPostStick });

    expect(setback.bumped).toBe(false);
    expect(setback.transition).toBeUndefined();

    // lastSetbackMs should remain unchanged, so the previous block is not extended.
    expect(state.activationAttemptByDevice[deviceId]?.lastSetbackMs).toBe(T0 + 5_000);

    // The original block should still be running, but it must not be extended.
    const blockRemaining = getActivationRestoreBlockRemainingMs({
      state,
      deviceId,
      nowTs: TPostStick + 1_000,
    });
    expect(blockRemaining).toBe(ACTIVATION_SETBACK_RESTORE_BLOCK_MS - ((TPostStick + 1_000) - (T0 + 5_000)));
  });

  it('block expires after stick window and device is admitted with elevated headroom', () => {
    // §3.3: Full cycle — after block expires, device restores but requires penalty headroom.
    const state = createPlanEngineState();
    const deviceId = 'dev-heater';
    const T0 = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(T0);

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
    vi.setSystemTime(TAfterBlock);
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
    expect(reasonText(devInsufficient?.reason)).toMatch(/insufficient headroom/);

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
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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
    expect(reasonText(dev?.reason)).toMatch(/insufficient headroom/);
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
    expect(reasonText(rejected.planDevices.find((d) => d.id === 'dev')?.reason)).toBe(
      'insufficient headroom to restore after reserves (need 0.72kW, available 1.10kW, '
      + 'post-reserve margin 0.128kW < 0.250kW)',
    );
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
    expect(reasonText(dev?.reason)).toMatch(/insufficient headroom/);
  });

  it('recently shed device needs extra headroom via recent-shed multiplier', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(now);
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
    expect(reasonText(dev?.reason)).toMatch(/insufficient headroom/);
  });

  it('penalty L4 requires approximately double the base needed headroom', () => {
    // §3.4: penalty L4 → applyActivationPenalty gives max(base*2, base+1.2kW)
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    const deviceId = 'dev';

    // Set penalty level 4 with a fresh lastSetbackMs (block expired)
    state.activationAttemptByDevice[deviceId] = {
      penaltyLevel: 4,
      lastSetbackMs: now - ACTIVATION_BACKOFF_CLEAR_WINDOW_MS - 1_000,
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
    expect(reasonText(resultBlocked.planDevices.find((d) => d.id === deviceId)?.reason)).toContain(
      'effective need 4.60kW (base 2.30kW + penalty 2.30kW)',
    );

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
    vi.setSystemTime(now);
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
    expect(reasonText(dev?.reason)).toMatch(/activation backoff/);
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
    expect(reasonText(device?.reason)).toContain('insufficient headroom');
    expect(result.restoredOneThisCycle).toBe(false);
  });

  it('blocks target-based restore on activation setback and logs the rejection', () => {
    const now = Date.UTC(2024, 0, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.lastPlannedShedIds = new Set(['dev-temp']);
    state.activationAttemptByDevice['dev-temp'] = {
      penaltyLevel: 1,
      lastSetbackMs: now - 1_000,
    };
    const debugStructured = vi.fn();

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
      debugStructured,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 18, stepId: null }),
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev-temp');
    expect(device?.plannedTarget).toBe(18);
    expect(reasonText(device?.reason)).toMatch(/activation backoff/);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_rejected',
      restoreType: 'target',
      deviceId: 'dev-temp',
    }));
  });
});

describe('restore admission floor — 0.250 kW postReserveMarginKw minimum', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const makeDepsFloor = () => ({
    powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
    getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
    logDebug: vi.fn(),
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
    expect(reasonText(device?.reason)).toBe(
      'insufficient headroom to restore after reserves (need 1.20kW, available 1.70kW, '
      + 'post-reserve margin 0.249kW < 0.250kW)',
    );
  });

  it('keeps binary restore summaries non-contradictory when raw available exceeds need', () => {
    const state = createPlanEngineState();
    const debugStructured = vi.fn();
    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev',
          name: 'Termostat barnebad',
          currentState: 'off',
          expectedPowerKw: 0.45,
          measuredPowerKw: 0,
        }),
      ],
      context: buildContext({ headroomRaw: 0.995, headroom: 0.995 }),
      state,
      sheddingActive: false,
      deps: {
        ...makeDepsFloor(),
        debugStructured,
      },
    });

    const device = result.planDevices.find((entry) => entry.id === 'dev');
    expect(reasonText(device?.reason)).toBe(
      'insufficient headroom to restore after reserves (need 0.65kW, available 1.00kW, '
      + 'post-reserve margin 0.095kW < 0.250kW)',
    );
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_rejected',
      restoreType: 'binary',
      availableKw: 0.995,
      neededKw: 0.65,
      postReserveMarginKw: 0.09499999999999997,
      minimumRequiredPostReserveMarginKw: 0.25,
      rejectionReason: 'insufficient_headroom',
    }));
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
      logDebug: vi.fn(),
    });

    const dev = deviceMap.get('dev-step')!;
    expect(dev.desiredStepId).toBeUndefined();
    expect(reasonText(dev.reason)).toContain('insufficient headroom');
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
      logDebug: vi.fn(),
    });

    expect(deviceMap.get('dev-step')!.desiredStepId).toBe('low');
  });

  it('admits binary-only stepped restore from off/low to on/low using the full low-step load', () => {
    const state = createPlanEngineState();
    const deviceMap = new Map([
      ['dev-step', steppedPlanDevice({
        id: 'dev-step',
        name: 'Tank',
        currentState: 'off',
        currentOn: false,
        plannedState: 'keep',
        selectedStepId: 'low',
        desiredStepId: 'low',
        lastDesiredStepId: 'low',
        measuredPowerKw: 0,
        planningPowerKw: 0,
      })],
    ]);

    const result = planRestoreForSteppedDevice({
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: {
        activeOvershoot: false, inCooldown: false, inRestoreCooldown: false,
        inStartupStabilization: false, measurementTs: null,
        restoreCooldownSeconds: 60,
        shedCooldownRemainingSec: null, restoreCooldownRemainingSec: null,
        startupStabilizationRemainingSec: null,
      },
      availableHeadroom: 1.975,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
    });

    const dev = deviceMap.get('dev-step')!;
    expect(dev.desiredStepId).toBe('low');
    expect(dev.expectedPowerKw).toBe(1.25);
    expect(reasonText(dev.reason)).toContain('restore');
    expect(result.availableHeadroom).toBeCloseTo(0.5, 5);
    expect(result.restoredOneThisCycle).toBe(true);
  });
});

describe('stepped-load shed invariant', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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
    const shedDevice = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true, powerKw: 1 }) };
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
      logDebug: vi.fn(),
    });

    const dev = deviceMap.get('dev-step')!;
    // desiredStepId must NOT be changed to 'max' — shed invariant blocks the upgrade
    expect(dev.desiredStepId).toBe('medium');
    expect(reasonText(dev.reason)).toMatch(/shed invariant/);
  });

  it('allows restore from off to low (lowest non-zero step) while another device is shed', () => {
    const state = createPlanEngineState();
    const shedDevice = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true }) };
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
      logDebug: vi.fn(),
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
    const shedDevice = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true }) };

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
      logDebug: vi.fn(),
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
      logDebug: vi.fn(),
    });

    // No shed devices → upgrade to max is allowed
    expect(deviceMap.get('dev-step')!.desiredStepId).toBe('max');
  });

  it('restore_stepped_rejected event is emitted with blockedByShedInvariant=true on upgrade block', () => {
    const state = createPlanEngineState();
    const shedDevice = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true }) };
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
    const debugStructured = vi.fn();

    planRestoreForSteppedDevice({
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    });

    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
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

  it('restore_stepped_rejected is suppressed when rejection params are unchanged on repeated rebuilds', () => {
    const state = createPlanEngineState();
    const shedDevice = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true }) };
    const steppedDev = steppedPlanDevice({
      id: 'dev-step', name: 'Tank', currentState: 'on', plannedState: 'keep',
      selectedStepId: 'medium', desiredStepId: 'medium',
    });
    const deviceMap = new Map([['binary-shed', shedDevice], ['dev-step', steppedDev]]);
    const debugStructured = vi.fn();

    const callArgs = {
      dev: deviceMap.get('dev-step')!,
      deviceMap,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    };

    // First call: emits
    planRestoreForSteppedDevice(callArgs);
    expect(debugStructured).toHaveBeenCalledTimes(1);

    // Second call with identical params: suppressed
    planRestoreForSteppedDevice({ ...callArgs, dev: deviceMap.get('dev-step')! });
    expect(debugStructured).toHaveBeenCalledTimes(1);
  });

  it('restore_stepped_rejected re-emits when shed count changes', () => {
    const state = createPlanEngineState();
    const shed1 = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'shed-1', name: 'Heater1', currentState: 'off', plannedState: 'shed', controllable: true }) };
    const shed2 = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'shed-2', name: 'Heater2', currentState: 'off', plannedState: 'shed', controllable: true }) };
    const steppedDev = steppedPlanDevice({
      id: 'dev-step', name: 'Tank', currentState: 'on', plannedState: 'keep',
      selectedStepId: 'medium', desiredStepId: 'medium',
    });
    const debugStructured = vi.fn();

    // First call with 1 shed device
    const map1 = new Map([['shed-1', shed1], ['dev-step', steppedDev]]);
    planRestoreForSteppedDevice({
      dev: map1.get('dev-step')!,
      deviceMap: map1,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    });
    expect(debugStructured).toHaveBeenCalledTimes(1);

    // Second call with 2 shed devices: different shed count → re-emits
    const map2 = new Map([['shed-1', shed1], ['shed-2', shed2], ['dev-step', steppedDev]]);
    planRestoreForSteppedDevice({
      dev: map2.get('dev-step')!,
      deviceMap: map2,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    });
    expect(debugStructured).toHaveBeenCalledTimes(2);
    expect(debugStructured).toHaveBeenLastCalledWith(expect.objectContaining({
      event: 'restore_stepped_rejected',
      shedDeviceCount: 2,
    }));
  });

  it('restore_stepped_rejected re-emits after device was unblocked and shed resumes', () => {
    const state = createPlanEngineState();
    const shedDevice = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true }) };
    const restoredDevice = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'on', plannedState: 'keep', controllable: true }) };
    const steppedDev = steppedPlanDevice({
      id: 'dev-step', name: 'Tank', currentState: 'on', plannedState: 'keep',
      selectedStepId: 'medium', desiredStepId: 'medium',
    });
    const debugCalls: unknown[] = [];
    const debugStructured = (payload: unknown) => debugCalls.push(payload);
    const rejectedCalls = () => debugCalls.filter((c: any) => c?.event === 'restore_stepped_rejected');

    // First: blocked, emits
    const mapShed = new Map([['binary-shed', shedDevice], ['dev-step', steppedDev]]);
    planRestoreForSteppedDevice({
      dev: mapShed.get('dev-step')!,
      deviceMap: mapShed,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    });
    expect(rejectedCalls()).toHaveLength(1);

    // Second: no shed devices → not blocked, tracking cleared (restore_stepped_admitted may fire)
    const mapClear = new Map([['binary-shed', restoredDevice], ['dev-step', steppedDev]]);
    planRestoreForSteppedDevice({
      dev: mapClear.get('dev-step')!,
      deviceMap: mapClear,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    });

    // Third: shed resumes → first rejection again, must re-emit
    planRestoreForSteppedDevice({
      dev: mapShed.get('dev-step')!,
      deviceMap: mapShed,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    });
    expect(rejectedCalls()).toHaveLength(2);
  });

  it('tracking cleared when shed resolves during cooldown, so next shed episode re-emits', () => {
    const state = createPlanEngineState();
    const shedDevice = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', controllable: true }) };
    const restoredDevice = { ...require('./utils/planTestUtils.ts').buildPlanDevice({ id: 'binary-shed', name: 'Heater', currentState: 'on', plannedState: 'keep', controllable: true }) };
    const steppedDev = steppedPlanDevice({
      id: 'dev-step', name: 'Tank', currentState: 'on', plannedState: 'keep',
      selectedStepId: 'medium', desiredStepId: 'medium',
    });
    const debugStructured = vi.fn();
    const activeCooldownTiming = { ...makeShedTiming(), inRestoreCooldown: true, restoreCooldownRemainingSec: 30 };

    // Round 1: shed active, blocked by invariant → emits
    const mapShed = new Map([['binary-shed', shedDevice], ['dev-step', steppedDev]]);
    planRestoreForSteppedDevice({
      dev: mapShed.get('dev-step')!,
      deviceMap: mapShed,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    });
    expect(debugStructured).toHaveBeenCalledTimes(1);

    // Round 2: shed cleared BUT cooldown active — early return before invariant check
    // Without the early-clear fix, tracking would survive here
    const mapClear = new Map([['binary-shed', restoredDevice], ['dev-step', steppedDev]]);
    planRestoreForSteppedDevice({
      dev: mapClear.get('dev-step')!,
      deviceMap: mapClear,
      state,
      timing: activeCooldownTiming,
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    });

    // Round 3: new shed episode starts → must re-emit (tracking was cleared in round 2)
    planRestoreForSteppedDevice({
      dev: mapShed.get('dev-step')!,
      deviceMap: mapShed,
      state,
      timing: makeShedTiming(),
      availableHeadroom: 5,
      restoredOneThisCycle: false,
      logDebug: vi.fn(),
      debugStructured,
    });
    expect(debugStructured).toHaveBeenCalledTimes(2);
  });

  it('upward step action is never emitted while shed devices exist (end-to-end via applyRestorePlan)', () => {
    const state = createPlanEngineState();
    const result = applyRestorePlan({
      planDevices: [
        require('./utils/planTestUtils.ts').buildPlanDevice({
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
        logDebug: vi.fn(),
      },
    });

    const steppedDev = result.planDevices.find((d) => d.id === 'dev-step');
    // desiredStepId must not have been upgraded to 'max' — binary-shed device is still shed
    expect(steppedDev?.desiredStepId).toBe('medium');
    expect(reasonText(steppedDev?.reason)).toMatch(/shed invariant/);
  });
});
