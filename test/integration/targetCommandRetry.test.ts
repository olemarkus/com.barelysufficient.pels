/**
 * Executor-owned target-command retry: the send / retry / skip verdict and the
 * attempt bookkeeping that backs it off.
 *
 * Split out of `planTargetControl.test.ts` when the implementation moved to
 * `lib/executor/targetCommandRetry.ts` — a spec named for the planner module was
 * the last thing still filing this behaviour under the planner.
 */
import { describe, expect, it } from 'vitest';
import { createPlanEngineState } from '../../lib/plan/planState';
import {
  getPendingTargetCommandDecision,
  recordFailedPendingTargetCommandAttempt,
  recordPendingTargetCommandAttempt,
} from '../../lib/executor/targetCommandRetry';

describe('recordPendingTargetCommandAttempt', () => {
  it('does not carry stale observed metadata into a fresh non-retry pending command', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      target: 'temperature',
      desired: 23,
      startedMs: Date.now() - 10_000,
      lastAttemptMs: Date.now() - 10_000,
      retryCount: 1,
      nextRetryAtMs: Date.now() + 20_000,
      status: 'waiting_confirmation',
      lastObservedValue: 27,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 1_000,
    };

    const pending = recordPendingTargetCommandAttempt({
      state,
      deviceId: 'dev-1',
      target: 'temperature',
      desired: 18,
      nowMs: Date.now(),
    });

    expect(pending).toMatchObject({
      target: 'temperature',
      desired: 18,
      retryCount: 0,
    });
    expect(pending.lastObservedValue).toBeUndefined();
    expect(pending.lastObservedSource).toBeUndefined();
    expect(pending.lastObservedAtMs).toBeUndefined();
  });

  it('records failed target commands as temporarily unavailable with retry backoff', () => {
    const state = createPlanEngineState();

    const pending = recordFailedPendingTargetCommandAttempt({
      state,
      deviceId: 'dev-1',
      target: 'temperature',
      desired: 18,
      nowMs: Date.now(),
      observedValue: 21,
    });

    expect(pending).toMatchObject({
      target: 'temperature',
      desired: 18,
      retryCount: 0,
      status: 'temporary_unavailable',
      lastObservedValue: 21,
    });
  });
});

describe('getPendingTargetCommandDecision', () => {
  const state = () => createPlanEngineState();

  it('sends when nothing is pending for the device', () => {
    expect(getPendingTargetCommandDecision({
      state: state(), deviceId: 'dev-1', desired: 21, nowMs: 1_000,
    })).toEqual({ type: 'send' });
  });

  it('sends when the pending command is for a different desired value', () => {
    const s = state();
    recordPendingTargetCommandAttempt({
      state: s, deviceId: 'dev-1', target: 'temperature', desired: 19, nowMs: 1_000,
    });
    expect(getPendingTargetCommandDecision({
      state: s, deviceId: 'dev-1', desired: 21, nowMs: 1_000,
    })).toEqual({ type: 'send' });
  });

  it('skips while the retry window has not elapsed, and reports the remaining wait', () => {
    const s = state();
    const pending = recordPendingTargetCommandAttempt({
      state: s, deviceId: 'dev-1', target: 'temperature', desired: 21, nowMs: 1_000,
    });
    const decision = getPendingTargetCommandDecision({
      state: s, deviceId: 'dev-1', desired: 21, nowMs: 1_500,
    });
    expect(decision).toEqual({
      type: 'skip',
      pending,
      remainingMs: pending.nextRetryAtMs - 1_500,
    });
  });

  it('retries once the window has elapsed', () => {
    const s = state();
    const pending = recordPendingTargetCommandAttempt({
      state: s, deviceId: 'dev-1', target: 'temperature', desired: 21, nowMs: 1_000,
    });
    expect(getPendingTargetCommandDecision({
      state: s, deviceId: 'dev-1', desired: 21, nowMs: pending.nextRetryAtMs,
    })).toEqual({ type: 'retry', pending });
  });
});
