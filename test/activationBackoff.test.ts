import { createPlanEngineState } from '../lib/plan/planState';
import {
  ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  ACTIVATION_SETBACK_RESTORE_BLOCK_MS,
  closeActivationAttemptForShed,
  getActivationRestoreBlockRemainingMs,
  recordActivationAttemptStart,
  recordActivationSetback,
  syncConfirmedRestoreAttributionState,
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
  syncHeadroomUsageObservation,
} from '../lib/plan/planHeadroomDevice';
import { emitActivationTransitions } from '../lib/plan/planHeadroomState';
import { getPerfSnapshot } from '../lib/utils/perfCounters';
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

  it('closes attempts quietly once the attribution window expires without clearing penalty', () => {
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
      nowTs: secondAttemptStart + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
      observation: { currentOn: true, available: true, measuredPowerKw: 2 },
    });
    expect(stuckInfo.penaltyLevel).toBe(1);
    expect(stuckInfo.attemptOpen).toBe(false);
    expect(stuckInfo.transitions).toEqual([]);
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: secondAttemptStart + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
    })).not.toBeNull();
  });

  it('keeps attempts open inside the attribution window and closes on explicit inactive observation', () => {
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
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS - 1,
      observation: { currentOn: true, available: true, measuredPowerKw: 1.2 },
    });
    expect(firstSync.attemptOpen).toBe(true);
    expect(firstSync.transitions).toEqual([]);

    const secondSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
      observation: { currentOn: true, available: true, measuredPowerKw: 1.2 },
    });
    expect(secondSync.attemptOpen).toBe(false);
    expect(secondSync.transitions).toEqual([]);

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 2 * 60_000,
    });

    const inactiveSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 2 * 60_000 + 5_000,
      observation: { currentOn: false, available: true },
    });
    expect(inactiveSync.attemptOpen).toBe(false);
    expect(inactiveSync.transitions).toMatchObject([{ kind: 'attempt_closed_inactive', deviceId: 'dev-1' }]);
  });

  it('closes a thermostat restore attempt after non-zero load is seen and the next power sample stays clean', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    const firstSync = syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      nowTs: start + 10_000,
      observation: {
        currentOn: true,
        measuredPowerKw: 0.2,
        deviceClass: 'thermostat',
        lastFreshDataMs: start + 10_000,
      },
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: false,
    });
    expect(firstSync.attemptOpen).toBe(true);
    expect(state.activationAttemptByDevice['dev-1']).toMatchObject({
      observedActivePowerAtMs: start + 10_000,
    });

    const secondSync = syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      nowTs: start + 20_000,
      observation: {
        currentOn: true,
        measuredPowerKw: 0.25,
        deviceClass: 'thermostat',
        lastFreshDataMs: start + 20_000,
      },
      wholeHomePowerSampleAtMs: start + 20_000,
      cleanWholeHomeSample: true,
    });
    expect(secondSync.attemptOpen).toBe(false);
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
  });

  it('does not quietly close attribution when the device is already off on the next power sample', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      nowTs: start + 10_000,
      observation: {
        currentOn: true,
        measuredPowerKw: 0.2,
        deviceClass: 'thermostat',
        lastFreshDataMs: start + 10_000,
      },
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: false,
    });

    const closeAttemptSync = syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      nowTs: start + 20_000,
      observation: {
        currentOn: false,
        deviceClass: 'thermostat',
        lastFreshDataMs: start + 20_000,
      },
      wholeHomePowerSampleAtMs: start + 20_000,
      cleanWholeHomeSample: false,
    });
    expect(closeAttemptSync.attemptOpen).toBe(true);

    const inactiveSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + 20_000,
      observation: { currentOn: false, available: true },
    });
    expect(inactiveSync.attemptOpen).toBe(false);
    expect(inactiveSync.transitions).toMatchObject([{ kind: 'attempt_closed_inactive', deviceId: 'dev-1' }]);
  });

  it('ignores stale non-zero measured power when deciding whether attribution can close', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    const stalePowerSync = syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      nowTs: start + 10_000,
      observation: {
        currentOn: true,
        measuredPowerKw: 0.2,
        deviceClass: 'thermostat',
        observationStale: true,
        lastFreshDataMs: start - 5_000,
      },
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: false,
    });
    expect(stalePowerSync.attemptOpen).toBe(true);
    expect(state.activationAttemptByDevice['dev-1']).not.toHaveProperty('observedActivePowerAtMs');

    const nextSampleSync = syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      nowTs: start + 20_000,
      observation: {
        currentOn: true,
        measuredPowerKw: 0.2,
        deviceClass: 'thermostat',
        observationStale: true,
        lastFreshDataMs: start - 5_000,
      },
      wholeHomePowerSampleAtMs: start + 20_000,
      cleanWholeHomeSample: false,
    });
    expect(nextSampleSync.attemptOpen).toBe(true);
  });

  it('records observed load time from fresh telemetry so delayed rebuilds can still close attribution', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    const delayedObservationSync = syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      nowTs: start + 30_000,
      observation: {
        currentOn: true,
        measuredPowerKw: 0.2,
        deviceClass: 'thermostat',
        lastFreshDataMs: start + 10_000,
      },
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: false,
    });
    expect(delayedObservationSync.attemptOpen).toBe(true);
    expect(state.activationAttemptByDevice['dev-1']).toMatchObject({
      observedActivePowerAtMs: start + 10_000,
    });

    const cleanSampleSync = syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      nowTs: start + 30_000,
      observation: {
        currentOn: true,
        measuredPowerKw: 0.2,
        deviceClass: 'thermostat',
        lastFreshDataMs: start + 10_000,
      },
      wholeHomePowerSampleAtMs: start + 20_000,
      cleanWholeHomeSample: true,
    });
    expect(cleanSampleSync.attemptOpen).toBe(false);
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
  });

  it('preserves penalty when a tracked device disappears from snapshot cleanup', () => {
    const state = createPlanEngineState();
    const now = Date.now();
    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      startedMs: now,
      source: 'tracked_step_up',
    };
    state.headroomCardByDevice['dev-1'] = { lastUsageKw: 1.8 };

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

  it('does not record a setback once the attribution window has expired', () => {
    const state = createPlanEngineState();
    const now = Date.now();
    state.activationAttemptByDevice['dev-1'] = { penaltyLevel: 1 };

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: now - ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS - 30_000,
    });

    syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: now - 10_000,
      observation: { currentOn: true, available: true },
    });

    const setback = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now - 5_000,
    });

    expect(setback.bumped).toBe(false);
    expect(setback.transition).toBeUndefined();
    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-1', nowTs: now }))
      .toBeNull();
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
    expect(setbackDecision?.cooldownSource).toBeNull();
    expect(setbackDecision?.observedKwSource).toBe('measuredPowerKw');
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
    expect(setbackDecision?.allowed).toBe(true);

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

    expect(syncHeadroomUsageObservation({
      state,
      deviceId: 'dev-1',
      usageObservation: { kw: 1.0 },
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

  it('preserves diagnostics names for tracked step-downs without treating them as failed activations', () => {
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

    expect(syncHeadroomUsageObservation({
      state,
      deviceId: 'dev-1',
      usageObservation: { kw: 1.0 },
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
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
  });

  it('stores override usage when a direct usage observation sync runs', () => {
    const state = createPlanEngineState();

    syncHeadroomUsageObservation({
      state,
      deviceId: 'dev-1',
      usageObservation: { kw: 2.4 },
      nowTs: Date.now(),
    });

    expect(state.headroomCardByDevice['dev-1']).toMatchObject({
      lastUsageKw: 2.4,
    });
  });

  it('skips unchanged snapshot-refresh tracked usage and increments the noop counter instead of replaying churn', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    syncHeadroomCardState({
      state,
      devices: [
        buildTrackedDevice({ id: 'dev-1', name: 'Heater A', expectedPowerKw: 3.2, powerKw: 3.2, lastFreshDataMs: start + 1_000 }),
        buildTrackedDevice({ id: 'dev-2', name: 'Heater B', expectedPowerKw: 2.4, powerKw: 2.4, lastFreshDataMs: start + 1_500 }),
        buildTrackedDevice({ id: 'dev-3', name: 'Heater C', expectedPowerKw: 1.8, powerKw: 1.8, lastFreshDataMs: start + 2_000 }),
      ] as any,
      nowTs: start,
    });
    const before = getPerfSnapshot();

    expect(syncHeadroomCardState({
      state,
      devices: [
        buildTrackedDevice({ id: 'dev-1', name: 'Heater A', expectedPowerKw: 3.2, powerKw: 3.2, lastFreshDataMs: start + 4_000 }),
        buildTrackedDevice({ id: 'dev-2', name: 'Heater B', expectedPowerKw: 2.4, powerKw: 2.4, lastFreshDataMs: start + 4_500 }),
        buildTrackedDevice({ id: 'dev-3', name: 'Heater C', expectedPowerKw: 1.8, powerKw: 1.8, lastFreshDataMs: start + 5_000 }),
      ] as any,
      nowTs: start + 5_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics: diagnostics as any,
    })).toBe(false);

    const after = getPerfSnapshot();
    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
    expect(state.headroomCardByDevice['dev-1']?.lastUsageFreshnessMs).toBe(start + 4_000);
    expect(state.headroomCardByDevice['dev-2']?.lastUsageFreshnessMs).toBe(start + 4_500);
    expect(state.headroomCardByDevice['dev-3']?.lastUsageFreshnessMs).toBe(start + 5_000);
    expect((after.counts.tracked_usage_update_skipped_noop || 0) - (before.counts.tracked_usage_update_skipped_noop || 0))
      .toBe(3);
  });

  it('ignores older tracked usage inputs when a trusted merged freshness is newer', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        expectedPowerKw: 1.2,
        powerKw: 1.2,
        lastFreshDataMs: start + 5_000,
      })] as any,
      nowTs: start,
    });
    const before = getPerfSnapshot();

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        expectedPowerKw: 0.2,
        powerKw: 0.2,
        lastFreshDataMs: start + 1_000,
      })] as any,
      nowTs: start + 6_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics: diagnostics as any,
    })).toBe(false);

    const after = getPerfSnapshot();
    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
    expect(state.headroomCardByDevice['dev-1']).toMatchObject({
      lastUsageKw: 1.2,
      lastUsageFreshnessMs: start + 5_000,
    });
    expect((after.counts.tracked_usage_update_skipped_noop || 0) - (before.counts.tracked_usage_update_skipped_noop || 0))
      .toBe(1);
  });

  it('ignores stale snapshot-refresh observations before they can close an open activation attempt', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        currentOn: true,
        currentState: 'on',
        expectedPowerKw: 1.2,
        powerKw: 1.2,
        lastFreshDataMs: start + 5_000,
      })] as any,
      nowTs: start,
    });

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start + 6_000,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        currentOn: false,
        currentState: 'off',
        expectedPowerKw: 0,
        powerKw: 0,
        lastFreshDataMs: start + 1_000,
      })] as any,
      nowTs: start + 7_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics: diagnostics as any,
    })).toBe(false);

    expect(state.activationAttemptByDevice['dev-1']).toEqual({
      startedMs: start + 6_000,
      source: 'pels_restore',
    });
    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
  });

  it('does not let an untrusted usage observation override a trusted merged observation', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        currentOn: true,
        currentState: 'on',
        expectedPowerKw: 1.2,
        powerKw: 1.2,
        lastFreshDataMs: start + 5_000,
      })] as any,
      nowTs: start,
    });
    const before = getPerfSnapshot();

    expect(syncHeadroomUsageObservation({
      state,
      deviceId: 'dev-1',
      usageObservation: { kw: 2.4 },
      nowTs: start + 6_000,
      diagnostics: diagnostics as any,
    })).toBe(false);

    const after = getPerfSnapshot();
    expect(state.headroomCardByDevice['dev-1']).toMatchObject({
      lastUsageKw: 1.2,
      lastUsageFreshnessMs: start + 5_000,
    });
    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
    expect((after.counts.tracked_usage_update_skipped_noop || 0) - (before.counts.tracked_usage_update_skipped_noop || 0))
      .toBe(1);
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

  it('closes an open attempt on shed without changing the existing penalty level', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      startedMs: start - 30_000,
      source: 'pels_restore',
    };

    const result = closeActivationAttemptForShed({
      state,
      deviceId: 'dev-1',
      nowTs: start,
    });

    expect(result.stateChanged).toBe(true);
    expect(result.transition).toMatchObject({
      kind: 'attempt_closed_by_shed',
      deviceId: 'dev-1',
      penaltyLevel: 2,
      source: 'pels_restore',
    });
    expect(state.activationAttemptByDevice['dev-1']).toEqual({ penaltyLevel: 2 });
  });
});

// Mirrors attributeOvershootToRecentRestores: walks recent restores newest-first and
// attributes overshoot to the first one that still has an open attempt.
const attributeOvershoot = (state: ReturnType<typeof createPlanEngineState>, nowTs: number): void => {
  const recentRestores = Object.entries(state.lastDeviceRestoreMs)
    .filter(([, restoreMs]) => nowTs - restoreMs <= OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS)
    .sort((left, right) => right[1] - left[1]);
  for (const [deviceId] of recentRestores) {
    const result = recordActivationSetback({ state, deviceId, nowTs });
    if (result.transition) return;
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

  it('falls back to an earlier open restore when the latest restore was already closed by shed', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    state.lastDeviceRestoreMs['dev-earlier'] = nowTs - 90_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-earlier', source: 'pels_restore', nowTs: nowTs - 90_000 });

    state.lastDeviceRestoreMs['dev-latest'] = nowTs - 14_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-latest', source: 'pels_restore', nowTs: nowTs - 14_000 });
    closeActivationAttemptForShed({ state, deviceId: 'dev-latest', nowTs: nowTs - 5_000 });

    attributeOvershoot(state, nowTs);

    expect(state.activationAttemptByDevice['dev-latest']).toBeUndefined();
    expect(state.activationAttemptByDevice['dev-earlier']?.penaltyLevel).toBe(1);
  });
});
