import { createPlanEngineState } from '../lib/plan/planState';
import {
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  ACTIVATION_SETBACK_RESTORE_BLOCK_MS,
  ACTIVATION_BACKOFF_STICK_WINDOW_MS,
  recordActivationAttemptStart,
  recordActivationSetback,
  syncActivationPenaltyState,
} from '../lib/plan/planActivationBackoff';
import type { PlanContext } from '../lib/plan/planContext';
import type { DevicePlanDevice } from '../lib/plan/planTypes';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import { applyRestorePlan } from '../lib/plan/planRestore';
import { evaluateHeadroomForDevice, syncHeadroomCardState } from '../lib/plan/planHeadroomDevice';

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

const buildPlanDevice = (overrides: Partial<DevicePlanDevice> = {}): DevicePlanDevice => ({
  id: 'dev',
  name: 'Device',
  currentState: 'off',
  plannedState: 'keep',
  currentTarget: null,
  plannedTarget: null,
  ...overrides,
});

describe('activation backoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-08T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('bumps penalty only once per activation attempt', () => {
    const state = createPlanEngineState();
    const now = Date.now();

    expect(recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: now,
    })).toMatchObject({ started: true, stateChanged: true });

    const first = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now + 60 * 1000,
    });
    const second = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now + 61 * 1000,
    });

    expect(first.bumped).toBe(true);
    expect(first.penaltyLevel).toBe(1);
    expect(second.bumped).toBe(false);
    expect(second.penaltyLevel).toBe(1);
  });

  it('does not bump after the stick window and clears after the clear window when observed active', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60 * 1000,
    });

    const secondAttemptStart = start + 2 * 60 * 1000;
    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: secondAttemptStart,
    });

    const stuckInfo = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: secondAttemptStart + ACTIVATION_BACKOFF_STICK_WINDOW_MS,
      observation: { currentOn: true, available: true, measuredPowerKw: 2 },
    });
    expect(stuckInfo.penaltyLevel).toBe(1);
    expect(stuckInfo.stickReached).toBe(true);

    const setbackAfterStick = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: secondAttemptStart + ACTIVATION_BACKOFF_STICK_WINDOW_MS + 60 * 1000,
    });
    expect(setbackAfterStick.bumped).toBe(false);
    expect(setbackAfterStick.penaltyLevel).toBe(1);

    const thirdAttemptStart = secondAttemptStart + ACTIVATION_BACKOFF_STICK_WINDOW_MS + 2 * 60 * 1000;
    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: thirdAttemptStart,
    });

    const notClearedWithoutObservation = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: thirdAttemptStart + ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
    });
    expect(notClearedWithoutObservation.penaltyLevel).toBe(1);
    expect(notClearedWithoutObservation.attemptOpen).toBe(true);

    const notClearedWithoutActiveObservation = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: thirdAttemptStart + ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
      observation: { available: true, currentState: 'unknown', measuredPowerKw: 0 },
    });
    expect(notClearedWithoutActiveObservation.penaltyLevel).toBe(1);
    expect(notClearedWithoutActiveObservation.attemptOpen).toBe(true);

    const clearedInfo = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: thirdAttemptStart + ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
      observation: { currentOn: true, available: true, measuredPowerKw: 1.5 },
    });
    expect(clearedInfo.penaltyLevel).toBe(0);
    expect(clearedInfo.attemptOpen).toBe(false);
  });

  it('preserves penalty when a tracked device disappears from snapshot cleanup', () => {
    const state = createPlanEngineState();
    const now = Date.now();
    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      startedMs: now,
      source: 'tracked_step_up',
      stickReached: false,
    };
    state.headroomCardByDevice['dev-1'] = { lastObservedKw: 1.8 };

    expect(syncHeadroomCardState({
      state,
      devices: [],
      nowTs: now + 5_000,
      cleanupMissingDevices: true,
    })).toBe(true);

    expect(state.activationAttemptByDevice['dev-1']).toEqual({ penaltyLevel: 2 });
  });

  it('uses penalty level in restore decisions', () => {
    const state = createPlanEngineState();
    state.activationAttemptByDevice['dev-1'] = { penaltyLevel: 2 };

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          measuredPowerKw: 0,
          powerKw: 2,
        }),
      ],
      context: buildContext({
        headroomRaw: 2.9,
        headroom: 2.9,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    expect(result.restoredOneThisCycle).toBe(false);
    expect(result.planDevices[0]?.plannedState).toBe('shed');
    expect(result.planDevices[0]?.reason).toContain('insufficient headroom');
  });

  it('blocks restore for a cooldown window after a fresh activation setback', () => {
    const state = createPlanEngineState();
    const now = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: now - 30_000,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now - 5_000,
    });

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-1',
          name: 'Heater',
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
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    expect(result.restoredOneThisCycle).toBe(false);
    expect(result.planDevices[0]?.plannedState).toBe('shed');
    expect(result.planDevices[0]?.reason).toContain('activation backoff');
  });

  it('allows restore again once the activation setback window expires', () => {
    const state = createPlanEngineState();
    const now = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: now - ACTIVATION_SETBACK_RESTORE_BLOCK_MS - 60_000,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now - ACTIVATION_SETBACK_RESTORE_BLOCK_MS - 1_000,
    });

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-1',
          name: 'Heater',
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
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null }),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    });

    expect(result.restoredOneThisCycle).toBe(true);
    expect(result.restoredThisCycle.has('dev-1')).toBe(true);
    expect(result.planDevices[0]?.plannedState).toBe('keep');
  });

  it('applies penalty level to the headroom flow decision after a failed tracked reactivation', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    const offDevice = {
      id: 'dev-1',
      currentOn: false,
      available: true,
      expectedPowerKw: 0,
      measuredPowerKw: 0,
      powerKw: 0,
    };

    expect(evaluateHeadroomForDevice({
      state,
      devices: [offDevice],
      deviceId: 'dev-1',
      device: offDevice,
      headroom: 0.5,
      requiredKw: 0.1,
      nowTs: start,
    })?.penaltyLevel).toBe(0);

    const steppedUpDevice = {
      ...offDevice,
      currentOn: true,
      expectedPowerKw: 3.2,
      measuredPowerKw: 3.2,
      powerKw: 3.2,
    };
    evaluateHeadroomForDevice({
      state,
      devices: [steppedUpDevice],
      deviceId: 'dev-1',
      device: steppedUpDevice,
      headroom: 0.3,
      requiredKw: 3.2,
      nowTs: start + 60 * 1000,
    });

    const steppedDownDevice = {
      ...steppedUpDevice,
      expectedPowerKw: 1,
      measuredPowerKw: 1,
      powerKw: 1,
    };
    const setbackDecision = evaluateHeadroomForDevice({
      state,
      devices: [steppedDownDevice],
      deviceId: 'dev-1',
      device: steppedDownDevice,
      headroom: 0.3,
      requiredKw: 1.1,
      nowTs: start + 2 * 60 * 1000,
    });
    expect(setbackDecision?.cooldownSource).toBe('step_down');
    expect(state.activationAttemptByDevice['dev-1']?.penaltyLevel).toBe(1);

    const recoveredDevice = {
      ...steppedUpDevice,
      expectedPowerKw: 3.2,
      measuredPowerKw: 3.2,
      powerKw: 3.2,
    };
    const recoveredDecision = evaluateHeadroomForDevice({
      state,
      devices: [recoveredDevice],
      deviceId: 'dev-1',
      device: recoveredDevice,
      headroom: 0.2,
      requiredKw: 3.2,
      nowTs: start + 3 * 60 * 1000 + 1,
    });

    expect(recoveredDecision?.penaltyLevel).toBe(1);
    expect(recoveredDecision?.requiredKwWithPenalty).toBeGreaterThan(3.2);
    expect(recoveredDecision?.allowed).toBe(false);
  });
});
