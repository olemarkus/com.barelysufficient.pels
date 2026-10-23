import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';
import { resolvePlanRebuildPosture } from '../../lib/plan/planRebuildPosture';
import { buildEmptyCapacityStateSummary } from '../../lib/power/capacityStateSummary';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { isPlanActivelyConverging } from '../../lib/plan/planStateHelpers';

describe('isPlanActivelyConverging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for a state with no pending work and no overshoot', () => {
    expect(isPlanActivelyConverging(createPlanEngineState(), { unactionable: false })).toBe(false);
  });

  it('returns true for active overshoot', () => {
    const state = createPlanEngineState();
    state.overshoot.enter(Date.now());

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(true);
  });

  // Regression: an unwinnable overshoot (all managed devices shed, remaining draw
  // unmanaged) kept convergence true, bypassed every rebuild anti-storm guard, and
  // rebuilt the plan on every power sample until the cpuwarn watchdog killed the app.
  it('returns false for active overshoot when the last plan proved nothing is actionable', () => {
    const state = createPlanEngineState();
    state.overshoot.enter(Date.now());

    expect(isPlanActivelyConverging(state, { unactionable: true })).toBe(false);
  });

  it('returns true for pending work even when the last plan proved nothing is actionable', () => {
    const state = createPlanEngineState();
    state.actuation.beginShed('shed-dev');

    expect(isPlanActivelyConverging(state, { unactionable: true })).toBe(true);
  });

  it('returns true for pending shed and restore work', () => {
    const state = createPlanEngineState();
    state.actuation.beginShed('shed-dev');

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(true);

    state.actuation.endShed('shed-dev');
    state.actuation.beginRestore('restore-dev');

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(true);
  });

  it('returns true for pending target and binary commands', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands = {
      dev1: {
        desired: 21,
        startedMs: Date.now(),
        lastAttemptMs: Date.now(),
        retryCount: 0,
        nextRetryAtMs: Date.now(),
        status: 'waiting_confirmation',
      },
    };

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(true);

    state.pendingTargetCommands = {};
    state.pendingBinaryCommands = {
      dev1: {
        dispatchState: 'accepted',
        desired: true,
        startedMs: Date.now(),
      },
    };

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(true);
  });

  it('stops bypassing rebuild guards exactly when the last binary command expires', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands = {
      heater: { dispatchState: 'accepted', desired: true, startedMs: Date.now() },
    };
    const summary = {
      ...buildEmptyCapacityStateSummary(),
      summarySource: 'plan_input' as const,
      summarySourceAtMs: Date.now(),
      remainingActionableControlledLoad: false,
      remainingReducibleControlledLoad: false,
    };
    vi.advanceTimersByTime(CONTROL_COMMAND_CONFIRMATION_MS - 1);
    expect(resolvePlanRebuildPosture(summary, state).planConvergenceActive).toBe(true);
    vi.advanceTimersByTime(1);
    expect(resolvePlanRebuildPosture(summary, state)).toMatchObject({
      planConvergenceActive: false,
      unactionable: true,
      shortfallUnrecoverable: true,
    });
    expect(Object.keys(state.pendingBinaryCommands)).toEqual(['heater']);
  });

  it('keeps overdue target retries actionable even when binary commands have expired', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands = {
      heater: { dispatchState: 'accepted', desired: true, startedMs: Date.now() - CONTROL_COMMAND_CONFIRMATION_MS },
    };
    state.pendingTargetCommands = {
      thermostat: {
        desired: 21,
        startedMs: Date.now() - CONTROL_COMMAND_CONFIRMATION_MS,
        lastAttemptMs: Date.now() - CONTROL_COMMAND_CONFIRMATION_MS,
        retryCount: 1,
        nextRetryAtMs: Date.now() - 1,
        status: 'temporary_unavailable',
      },
    };
    expect(isPlanActivelyConverging(state, { unactionable: true })).toBe(true);
  });

  it('returns false for recent device shed and restore timestamps alone', () => {
    const state = createPlanEngineState();
    state.actuation.lastDeviceShedMs = { shedDev: Date.now() - 1_000 };
    state.actuation.lastDeviceRestoreMs = { restoreDev: Date.now() - 1_000 };

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(false);
  });

  it('returns false for recent instability, recovery, and restore timestamps alone', () => {
    const state = createPlanEngineState();
    state.restoreBackoff.lastInstabilityMs = Date.now() - 1_000;
    state.restoreBackoff.lastRecoveryMs = Date.now() - 1_000;
    state.actuation.lastRestoreMs = Date.now() - 1_000;

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(false);
  });
});
