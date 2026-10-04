/**
 * Executor-owned target-command retry: the send / retry / skip verdict and the
 * attempt bookkeeping that backs it off.
 *
 * Split out of `planTargetControl.test.ts` when the implementation moved to
 * `lib/executor/targetCommandRetry.ts` — a spec named for the planner module was
 * the last thing still filing this behaviour under the planner.
 */
import { describe, expect, it } from 'vitest';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import {
  getPendingTargetCommandDecision,
  recordTargetCommandAttempt,
} from '../../lib/executor/targetCommandRetry';

describe('recordTargetCommandAttempt', () => {
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

    const pending = recordTargetCommandAttempt(state, 'dev-1', 18, Date.now(), 'waiting_confirmation', undefined);

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

    const pending = recordTargetCommandAttempt(state, 'dev-1', 18, Date.now(), 'temporary_unavailable', 21);

    expect(pending).toMatchObject({
      target: 'temperature',
      desired: 18,
      retryCount: 0,
      status: 'temporary_unavailable',
      lastObservedValue: 21,
    });
  });
});

describe('target attempt outcomes', () => {
  it('keeps the retry timeline and observation evidence across failed and successful dispatches', () => {
    const state = createPlanEngineState();
    const first = recordTargetCommandAttempt(state, 'heater', 21, 1_000, 'waiting_confirmation', 18);
    expect(first.nextRetryAtMs).toBe(1_000 + 90_000);
    first.lastObservedSource = 'realtime_capability';
    first.lastObservedAtMs = 2_000;
    first.lastWaitingLogAtMs = 3_000;

    const failed = recordTargetCommandAttempt(state, 'heater', 21, 91_000, 'temporary_unavailable', undefined);
    expect(failed).toMatchObject({
      startedMs: 1_000, retryCount: 1, nextRetryAtMs: 91_000 + 120_000,
      status: 'temporary_unavailable', lastObservedValue: 18,
      lastObservedSource: 'realtime_capability', lastObservedAtMs: 2_000,
    });
    expect(failed.lastWaitingLogAtMs).toBeUndefined();
    failed.lastWaitingLogAtMs = 40_000;

    const retried = recordTargetCommandAttempt(state, 'heater', 21, 211_000, 'waiting_confirmation', 19);
    expect(retried).toMatchObject({
      startedMs: 1_000, retryCount: 2, nextRetryAtMs: 211_000 + 300_000,
      status: 'waiting_confirmation', lastObservedValue: 19,
      lastObservedSource: 'realtime_capability', lastObservedAtMs: 2_000,
      lastWaitingLogAtMs: 40_000,
    });
    expect(state.pendingTargetCommands.heater).toBe(retried);
  });

  it('backs off an initial failed dispatch and starts a new confirmation window when intent changes', () => {
    const state = createPlanEngineState();
    const failed = recordTargetCommandAttempt(state, 'heater', 21, 1_000, 'temporary_unavailable', 18);
    expect(failed.nextRetryAtMs).toBe(1_000 + 30_000);
    failed.lastObservedSource = 'realtime_capability';
    failed.lastObservedAtMs = 2_000;
    failed.lastWaitingLogAtMs = 3_000;

    const changed = recordTargetCommandAttempt(state, 'heater', 20, 4_000, 'waiting_confirmation', null);
    expect(changed).toMatchObject({
      startedMs: 4_000, retryCount: 0, nextRetryAtMs: 4_000 + 90_000,
      lastObservedValue: null,
    });
    expect(changed.lastObservedSource).toBeUndefined();
    expect(changed.lastObservedAtMs).toBeUndefined();
    expect(changed.lastWaitingLogAtMs).toBeUndefined();
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
    recordTargetCommandAttempt(s, 'dev-1', 19, 1_000, 'waiting_confirmation', undefined);
    expect(getPendingTargetCommandDecision({
      state: s, deviceId: 'dev-1', desired: 21, nowMs: 1_000,
    })).toEqual({ type: 'send' });
  });

  it('skips while the retry window has not elapsed, and reports the remaining wait', () => {
    const s = state();
    const pending = recordTargetCommandAttempt(s, 'dev-1', 21, 1_000, 'waiting_confirmation', undefined);
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
    const pending = recordTargetCommandAttempt(s, 'dev-1', 21, 1_000, 'waiting_confirmation', undefined);
    expect(getPendingTargetCommandDecision({
      state: s, deviceId: 'dev-1', desired: 21, nowMs: pending.nextRetryAtMs,
    })).toEqual({ type: 'retry', pending });
  });
});
