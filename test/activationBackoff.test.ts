import { createPlanEngineState } from '../lib/plan/planState';
import {
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  ACTIVATION_SETBACK_RESTORE_BLOCK_MS,
  ACTIVATION_BACKOFF_STICK_WINDOW_MS,
  getActivationRestoreBlockRemainingMs,
  recordActivationAttemptStart,
  recordActivationSetback,
  syncActivationPenaltyState,
} from '../lib/plan/planActivationBackoff';
import {
  OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS,
  RESTORE_COOLDOWN_MS,
  SHED_COOLDOWN_MS,
} from '../lib/plan/planConstants';
import type { PlanContext } from '../lib/plan/planContext';
import type { DevicePlanDevice } from '../lib/plan/planTypes';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import { applyRestorePlan } from '../lib/plan/planRestore';
import {
  evaluateHeadroomForDevice,
  syncHeadroomCardState,
  syncHeadroomCardTrackedUsage,
} from '../lib/plan/planHeadroomDevice';
import { emitActivationTransitions } from '../lib/plan/planHeadroomState';
import { reasonText } from './utils/deviceReasonTestUtils';

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

const buildTrackedDevice = (overrides: Record<string, unknown> = {}) => ({
  id: 'dev-1',
  name: 'Heater',
  currentOn: true,
  available: true,
  expectedPowerKw: 0,
  measuredPowerKw: 0,
  powerKw: 0,
  ...overrides,
});

describe('activation backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('resets penalty after sustained active success at the stick boundary', () => {
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
    expect(stuckInfo.penaltyLevel).toBe(0);
    expect(stuckInfo.attemptOpen).toBe(false);
    expect(stuckInfo.transitions).toMatchObject([
      { kind: 'stick_reached', deviceId: 'dev-1' },
      { kind: 'penalty_cleared', deviceId: 'dev-1', previousPenaltyLevel: 1 },
    ]);
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: secondAttemptStart + ACTIVATION_BACKOFF_STICK_WINDOW_MS,
    })).toBeNull();
  });

  it('emits stick-reached only once per attempt and closes on explicit inactive observation before recovery', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    const firstSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_BACKOFF_STICK_WINDOW_MS,
      observation: { currentOn: true, available: true, measuredPowerKw: 1.2 },
    });
    expect(firstSync.transitions).toMatchObject([{ kind: 'stick_reached', deviceId: 'dev-1' }]);

    const secondSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_BACKOFF_STICK_WINDOW_MS + 60_000,
      observation: { currentOn: true, available: true, measuredPowerKw: 1.2 },
    });
    expect(secondSync.transitions).toEqual([]);

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start + ACTIVATION_BACKOFF_STICK_WINDOW_MS + 2 * 60_000,
    });

    const inactiveSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_BACKOFF_STICK_WINDOW_MS + 2 * 60_000 + 5_000,
      observation: { currentOn: false, available: true },
    });
    expect(inactiveSync.attemptOpen).toBe(false);
    expect(inactiveSync.transitions).toMatchObject([{ kind: 'attempt_closed_inactive', deviceId: 'dev-1' }]);
  });

  it('preserves penalty when a tracked device disappears from snapshot cleanup', () => {
    const state = createPlanEngineState();
    const now = Date.now();
    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      startedMs: now,
      source: 'tracked_step_up',
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    expect(result.restoredOneThisCycle).toBe(false);
    expect(result.planDevices[0]?.plannedState).toBe('shed');
    expect(reasonText(result.planDevices[0]?.reason)).toContain('insufficient headroom');
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    expect(result.restoredOneThisCycle).toBe(false);
    expect(result.planDevices[0]?.plannedState).toBe('shed');
    expect(reasonText(result.planDevices[0]?.reason)).toContain('activation backoff');
  });

  it('refreshes the restore block even when a setback happens after stick is reached', () => {
    const state = createPlanEngineState();
    const now = Date.now();
    state.activationAttemptByDevice['dev-1'] = { penaltyLevel: 1 };

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: now - ACTIVATION_BACKOFF_STICK_WINDOW_MS - 30_000,
    });

    const setback = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now - 5_000,
    });

    expect(setback.bumped).toBe(false);
    expect(setback.transition).toMatchObject({ kind: 'setback_after_stick', deviceId: 'dev-1' });
    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-1', nowTs: now }))
      .toBe(ACTIVATION_SETBACK_RESTORE_BLOCK_MS - 5_000);
  });

  it('has no cooldown before any failure, then doubles repeated failures and caps at 30 minutes', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-1', nowTs: start })).toBeNull();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60_000,
    });
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60_000,
    })).toBe(ACTIVATION_SETBACK_RESTORE_BLOCK_MS);

    const secondStart = start + ACTIVATION_SETBACK_RESTORE_BLOCK_MS + 61_000;
    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: secondStart,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: secondStart + 60_000,
    });
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: secondStart + 60_000,
    })).toBe(ACTIVATION_SETBACK_RESTORE_BLOCK_MS * 2);

    const thirdStart = secondStart + (ACTIVATION_SETBACK_RESTORE_BLOCK_MS * 2) + 61_000;
    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: thirdStart,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: thirdStart + 60_000,
    });
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: thirdStart + 60_000,
    })).toBe(ACTIVATION_BACKOFF_CLEAR_WINDOW_MS);

    const fourthStart = thirdStart + ACTIVATION_BACKOFF_CLEAR_WINDOW_MS + 61_000;
    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: fourthStart,
    });
    const fourthSetback = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: fourthStart + 60_000,
    });

    expect(fourthSetback.penaltyLevel).toBe(4);
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: fourthStart + 60_000,
    })).toBe(ACTIVATION_BACKOFF_CLEAR_WINDOW_MS);
  });

  it('treats the exact cooldown expiry timestamp as unblocked', () => {
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
      nowTs: start + 60_000,
    });

    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60_000 + ACTIVATION_SETBACK_RESTORE_BLOCK_MS - 1,
    })).toBe(1);
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60_000 + ACTIVATION_SETBACK_RESTORE_BLOCK_MS,
    })).toBeNull();
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
        log: vi.fn(),
        logDebug: vi.fn(),
      },
    });

    expect(result.restoredOneThisCycle).toBe(true);
    expect(result.restoredThisCycle.has('dev-1')).toBe(true);
    expect(result.planDevices[0]?.plannedState).toBe('keep');
  });

  it('does not apply penalty level after a tracked-only rise and drop without a trusted restore', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    const offDevice = {
      id: 'dev-1',
      name: 'Heater',
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
    expect(setbackDecision?.observedKwSource).toBe('measuredPowerKw');
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();

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

    expect(recoveredDecision?.penaltyLevel).toBe(0);
    expect(recoveredDecision?.requiredKwWithPenalty).toBe(3.2);
    expect(recoveredDecision?.allowed).toBe(true);
  });

  it('does not record an activation setback when a restore attempt later sees a tracked drop', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Heater',
        currentOn: true,
        available: true,
        expectedPowerKw: 3.2,
        measuredPowerKw: 3.2,
        powerKw: 3.2,
      }],
      nowTs: start,
    });

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start + 60_000,
    });

    expect(syncHeadroomCardTrackedUsage({
      state,
      deviceId: 'dev-1',
      trackedKw: 1.0,
      nowTs: start + 120_000,
      diagnostics: diagnostics as any,
    })).toBe(true);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledWith({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-1',
      name: 'Heater',
      nowTs: start + 120_000,
      fromKw: 3.2,
      toKw: 1,
    });
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
    expect(state.activationAttemptByDevice['dev-1']).toEqual({
      startedMs: start + 60_000,
      source: 'pels_restore',
    });
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 120_000,
    })).toBeNull();
  });

  it('emits activation transitions when only the stored device name is available', () => {
    const diagnostics = {
      recordActivationTransition: vi.fn(),
    };

    emitActivationTransitions(
      diagnostics as any,
      'Heater',
      [{
        kind: 'attempt_closed_inactive',
        deviceId: 'dev-1',
        source: 'tracked_step_up',
        penaltyLevel: 1,
        elapsedMs: 5_000,
        nowTs: Date.now(),
      }],
    );

    expect(diagnostics.recordActivationTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'attempt_closed_inactive',
        deviceId: 'dev-1',
      }),
      { name: 'Heater' },
    );
  });

  it('preserves diagnostics names for tracked step-downs without a live device object', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Heater',
        currentOn: true,
        available: true,
        expectedPowerKw: 3.2,
        measuredPowerKw: 3.2,
        powerKw: 3.2,
      }],
      nowTs: start,
    });

    expect(syncHeadroomCardTrackedUsage({
      state,
      deviceId: 'dev-1',
      trackedKw: 1.0,
      nowTs: start + 120_000,
      diagnostics: diagnostics as any,
    })).toBe(true);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledWith({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-1',
      name: 'Heater',
      nowTs: start + 120_000,
      fromKw: 3.2,
      toKw: 1,
    });
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
  });

  it('stores expected-power source when tracked usage sync comes from an override', () => {
    const state = createPlanEngineState();

    syncHeadroomCardTrackedUsage({
      state,
      deviceId: 'dev-1',
      trackedKw: 2.4,
      trackedKwSource: 'expectedPowerKw',
      nowTs: Date.now(),
    });

    expect(state.headroomCardByDevice['dev-1']).toMatchObject({
      lastObservedKw: 2.4,
      lastObservedKwSource: 'expectedPowerKw',
    });
  });

  it('tags snapshot-refresh tracked transitions during startup with snapshot_refresh reconciliation', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    syncHeadroomCardState({
      state,
      devices: [
        buildTrackedDevice({ id: 'dev-1', name: 'Heater A', expectedPowerKw: 3.2, powerKw: 3.2 }),
        buildTrackedDevice({ id: 'dev-2', name: 'Heater B', expectedPowerKw: 2.4, powerKw: 2.4 }),
        buildTrackedDevice({ id: 'dev-3', name: 'Heater C', expectedPowerKw: 1.8, powerKw: 1.8 }),
      ] as any,
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [
        buildTrackedDevice({ id: 'dev-1', name: 'Heater A', expectedPowerKw: 0.8, powerKw: 0.8 }),
        buildTrackedDevice({ id: 'dev-2', name: 'Heater B', expectedPowerKw: 0.5, powerKw: 0.5 }),
        buildTrackedDevice({ id: 'dev-3', name: 'Heater C', expectedPowerKw: 0.2, powerKw: 0.2 }),
      ] as any,
      nowTs: start + 5_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics: diagnostics as any,
    })).toBe(true);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledTimes(3);
    expect(diagnostics.recordControlEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-1',
      reconciliation: 'snapshot_refresh',
    }));
    expect(diagnostics.recordControlEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-2',
      reconciliation: 'snapshot_refresh',
    }));
    expect(diagnostics.recordControlEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-3',
      reconciliation: 'snapshot_refresh',
    }));
  });

  it('does not open an activation attempt from a snapshot-refresh tracked rise on a still-shed device', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Nordic S4 REL',
        currentOn: true,
        currentState: 'not_applicable',
        available: true,
        expectedPowerKw: 0,
        measuredPowerKw: 0,
        powerKw: 0,
      }],
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Nordic S4 REL',
        currentOn: true,
        currentState: 'not_applicable',
        available: true,
        expectedPowerKw: 1.0,
        measuredPowerKw: 0,
        powerKw: 0,
      }],
      nowTs: start + 5_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics: diagnostics as any,
    })).toBe(false);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
      reconciliation: 'snapshot_refresh',
    }));
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();

    expect(syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Nordic S4 REL',
        currentOn: true,
        currentState: 'not_applicable',
        available: true,
        expectedPowerKw: 0,
        measuredPowerKw: 0,
        powerKw: 0,
      }],
      nowTs: start + 24_000,
      diagnostics: diagnostics as any,
    })).toBe(true);

    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 24_000,
    })).toBeNull();
  });

  it('tags tracked step-ups after a recent restore as post_actuation reconciliation', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    state.appStartedAtMs = start - (Math.max(SHED_COOLDOWN_MS, RESTORE_COOLDOWN_MS) + 1);
    state.lastDeviceRestoreMs['dev-1'] = start;

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()] as any,
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, powerKw: 1.0, measuredPowerKw: 1.0 })] as any,
      nowTs: start + 5_000,
      diagnostics: diagnostics as any,
    })).toBe(false);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
      reconciliation: 'post_actuation',
    }));
  });

  it('leaves steady-state tracked transitions untagged outside reconciliation windows', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    state.appStartedAtMs = start - (Math.max(SHED_COOLDOWN_MS, RESTORE_COOLDOWN_MS) + 1);

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()] as any,
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, powerKw: 1.0, measuredPowerKw: 1.0 })] as any,
      nowTs: start + (2 * 60 * 1000),
      diagnostics: diagnostics as any,
    })).toBe(false);

    const [event] = diagnostics.recordControlEvent.mock.calls[0];
    expect(event).toMatchObject({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
    });
    expect(event.reconciliation).toBeUndefined();
  });

  it('treats the reconciliation-window boundary as inclusive', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()] as any,
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, powerKw: 1.0, measuredPowerKw: 1.0 })] as any,
      nowTs: start + Math.max(SHED_COOLDOWN_MS, RESTORE_COOLDOWN_MS),
      diagnostics: diagnostics as any,
    })).toBe(false);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
      reconciliation: 'startup',
    }));
  });

  it('ends startup reconciliation when startup stabilization ends early', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    state.startupRestoreBlockedUntilMs = start + 30_000;

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()] as any,
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, powerKw: 1.0, measuredPowerKw: 1.0 })] as any,
      nowTs: start + 45_000,
      diagnostics: diagnostics as any,
    })).toBe(false);

    const [event] = diagnostics.recordControlEvent.mock.calls[0];
    expect(event).toMatchObject({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
    });
    expect(event.reconciliation).toBeUndefined();
  });

  it('ends startup reconciliation after startup stabilization is explicitly cleared', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    state.startupRestoreBlockedUntilMs = start + 60_000;

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()] as any,
      nowTs: start,
    });

    state.startupRestoreBlockedUntilMs = start + 4_999;

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, powerKw: 1.0, measuredPowerKw: 1.0 })] as any,
      nowTs: start + 5_000,
      diagnostics: diagnostics as any,
    })).toBe(false);

    const [event] = diagnostics.recordControlEvent.mock.calls[0];
    expect(event).toMatchObject({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
    });
    expect(event.reconciliation).toBeUndefined();
  });
});

// Mirrors attributeOvershootToRecentRestores: finds the single most-recently-restored
// device within the attribution window and records a setback for it.
const attributeOvershoot = (state: ReturnType<typeof createPlanEngineState>, nowTs: number): void => {
  let latestDeviceId: string | null = null;
  let latestRestoreMs = 0;
  for (const [deviceId, restoreMs] of Object.entries(state.lastDeviceRestoreMs)) {
    if (nowTs - restoreMs > OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS) continue;
    if (restoreMs > latestRestoreMs) {
      latestRestoreMs = restoreMs;
      latestDeviceId = deviceId;
    }
  }
  if (latestDeviceId !== null) {
    recordActivationSetback({ state, deviceId: latestDeviceId, nowTs });
  }
};

describe('overshoot-after-restore attribution', () => {
  it('records a setback for the most recently restored device within the attribution window', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    state.lastDeviceRestoreMs['dev-a'] = nowTs - 14_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-a', source: 'pels_restore', nowTs: nowTs - 14_000 });

    attributeOvershoot(state, nowTs);

    expect(state.activationAttemptByDevice['dev-a']?.penaltyLevel).toBe(1);
    expect(state.activationAttemptByDevice['dev-a']?.lastSetbackMs).toBe(nowTs);
    const block = getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-a', nowTs });
    expect(block).not.toBeNull();
    expect(block).toBeGreaterThan(9 * 60 * 1000);
  });

  it('does not attribute overshoot to a device restored outside the attribution window', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    // Restore happened 3 minutes ago — outside the 2-minute window
    state.lastDeviceRestoreMs['dev-b'] = nowTs - 3 * 60 * 1000;
    recordActivationAttemptStart({ state, deviceId: 'dev-b', source: 'pels_restore', nowTs: nowTs - 3 * 60 * 1000 });

    attributeOvershoot(state, nowTs);

    expect(state.activationAttemptByDevice['dev-b']?.penaltyLevel).toBeUndefined();
    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-b', nowTs })).toBeNull();
  });

  it('does not attribute overshoot to a device with no open activation attempt', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    // Restore timestamp is recent but no activation attempt was started (e.g., manually turned on)
    state.lastDeviceRestoreMs['dev-c'] = nowTs - 10_000;

    attributeOvershoot(state, nowTs);

    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-c', nowTs })).toBeNull();
  });

  it('only penalizes the most recently restored device when multiple are in the window', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    // dev-earlier was restored 90s ago — within window, but not the marginal restore
    state.lastDeviceRestoreMs['dev-earlier'] = nowTs - 90_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-earlier', source: 'pels_restore', nowTs: nowTs - 90_000 });

    // dev-latest was restored 14s ago — the one that tipped headroom negative
    state.lastDeviceRestoreMs['dev-latest'] = nowTs - 14_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-latest', source: 'pels_restore', nowTs: nowTs - 14_000 });

    attributeOvershoot(state, nowTs);

    // Only dev-latest gets penalized
    expect(state.activationAttemptByDevice['dev-latest']?.penaltyLevel).toBe(1);
    expect(state.activationAttemptByDevice['dev-earlier']?.penaltyLevel).toBeUndefined();
    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-earlier', nowTs })).toBeNull();
  });
});
