import { createPlanEngineState } from '../../lib/plan/planState';
import { isPlanActivelyConverging } from '../../lib/plan/planStateHelpers';

describe('isPlanActivelyConverging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for empty state', () => {
    expect(isPlanActivelyConverging(null, { unactionable: false })).toBe(false);
    expect(isPlanActivelyConverging(undefined, { unactionable: false })).toBe(false);
  });

  it('returns true for active overshoot', () => {
    const state = createPlanEngineState();
    state.wasOvershoot = true;

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(true);
  });

  // Regression: an unwinnable overshoot (all managed devices shed, remaining draw
  // unmanaged) kept convergence true, bypassed every rebuild anti-storm guard, and
  // rebuilt the plan on every power sample until the cpuwarn watchdog killed the app.
  it('returns false for active overshoot when the last plan proved nothing is actionable', () => {
    const state = createPlanEngineState();
    state.wasOvershoot = true;

    expect(isPlanActivelyConverging(state, { unactionable: true })).toBe(false);
  });

  it('returns true for pending work even when the last plan proved nothing is actionable', () => {
    const state = createPlanEngineState();
    state.pendingSheds.add('shed-dev');

    expect(isPlanActivelyConverging(state, { unactionable: true })).toBe(true);
  });

  it('returns true for pending shed and restore work', () => {
    const state = createPlanEngineState();
    state.pendingSheds.add('shed-dev');

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(true);

    state.pendingSheds.clear();
    state.pendingRestores.add('restore-dev');

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(true);
  });

  it('returns true for pending target and binary commands', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands = {
      dev1: {
        capabilityId: 'target_temperature',
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
        capabilityId: 'onoff',
        desired: true,
        startedMs: Date.now(),
      },
    };

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(true);
  });

  it('returns false for recent device shed and restore timestamps alone', () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs = { shedDev: Date.now() - 1_000 };
    state.lastDeviceRestoreMs = { restoreDev: Date.now() - 1_000 };

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(false);
  });

  it('returns false for recent instability, recovery, and restore timestamps alone', () => {
    const state = createPlanEngineState();
    state.lastInstabilityMs = Date.now() - 1_000;
    state.lastRecoveryMs = Date.now() - 1_000;
    state.lastRestoreMs = Date.now() - 1_000;

    expect(isPlanActivelyConverging(state, { unactionable: false })).toBe(false);
  });
});
