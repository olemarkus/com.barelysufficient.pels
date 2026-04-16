import { createPlanEngineState } from '../lib/plan/planState';
import { isPlanConverging } from '../lib/plan/planStateHelpers';

describe('isPlanConverging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for empty state', () => {
    expect(isPlanConverging(null, Date.now())).toBe(false);
    expect(isPlanConverging(undefined, Date.now())).toBe(false);
  });

  it('ignores timestamps in the future', () => {
    const state = createPlanEngineState();
    state.lastInstabilityMs = Date.now() + 1_000;

    expect(isPlanConverging(state, Date.now())).toBe(false);
  });

  it('treats recent instability as convergence', () => {
    const state = createPlanEngineState();
    state.lastInstabilityMs = Date.now() - 1_000;

    expect(isPlanConverging(state, Date.now(), 5_000)).toBe(true);
  });

  it('treats recent device activity as convergence', () => {
    const state = createPlanEngineState();
    state.lastDeviceRestoreMs = { dev1: Date.now() - 1_000 };

    expect(isPlanConverging(state, Date.now(), 5_000)).toBe(true);
  });

  it('treats pending work as convergence', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands = {
      dev1: {
        capabilityId: 'target_temperature',
        desired: 21,
        startedMs: Date.now(),
        lastAttemptMs: Date.now(),
        retryCount: 0,
        nextRetryAtMs: Date.now(),
        status: 'pending',
      },
    };

    expect(isPlanConverging(state, Date.now(), 5_000)).toBe(true);
  });

  it('treats overshoot as convergence', () => {
    const state = createPlanEngineState();
    state.wasOvershoot = true;

    expect(isPlanConverging(state, Date.now(), 5_000)).toBe(true);
  });
});
