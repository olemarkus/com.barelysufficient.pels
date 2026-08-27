import { resolveSteppedCommandAttempt } from '../../lib/executor/steppedCommandAttempt';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

const steppedLoadProfile: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 800 },
    { id: 'high', planningPowerW: 2000 },
  ],
};

const NOW = 1_000_000;

const resolve = (
  overrides: Partial<Parameters<typeof resolveSteppedCommandAttempt>[0]> = {},
) => resolveSteppedCommandAttempt({
  requestedStepId: 'low',
  lastDesiredStepId: 'low',
  steppedLoadProfile,
  stepCommandPending: false,
  stepCommandStatus: 'idle',
  nextStepCommandRetryAtMs: undefined,
  nowMs: NOW,
  ...overrides,
});

describe('resolveSteppedCommandAttempt', () => {
  it('reports awaiting_confirmation while a command for that step is in flight', () => {
    expect(resolve({ stepCommandPending: true })).toEqual({
      status: 'awaiting_confirmation',
      requestedStepId: 'low',
    });
  });

  it('reports retry_backoff while a stale command still has a scheduled retry', () => {
    expect(resolve({
      stepCommandStatus: 'stale',
      nextStepCommandRetryAtMs: NOW + 5_000,
    })).toEqual({ status: 'retry_backoff', requestedStepId: 'low' });
  });

  it('is clear once the retry time has passed', () => {
    expect(resolve({
      stepCommandStatus: 'stale',
      nextStepCommandRetryAtMs: NOW,
    })).toBeNull();
  });

  it('is clear when nothing is outstanding', () => {
    expect(resolve({ stepCommandStatus: 'success' })).toBeNull();
  });

  // The whole point of the step id: a command in flight for a DIFFERENT step says
  // nothing about this one, and holding against it would defer a legitimate command.
  it('ignores an in-flight command issued for a different step', () => {
    expect(resolve({ lastDesiredStepId: 'high', stepCommandPending: true })).toBeNull();
  });

  it('has no attempt when no step is requested', () => {
    expect(resolve({ requestedStepId: undefined, stepCommandPending: true })).toBeNull();
  });

  // Driver swap remapped the ladder mid-session: the observed step id no longer
  // names a known step, so there is nothing coherent to hold a command against.
  it('ignores a step the current profile no longer knows', () => {
    expect(resolve({
      requestedStepId: 'medium',
      lastDesiredStepId: 'medium',
      stepCommandPending: true,
    })).toBeNull();
  });

  // `Infinity` passes a `typeof === 'number'` check and makes `now < deadline`
  // permanently true — the device's step commands would be suppressed forever.
  it.each([Infinity, Number.NaN])('ignores a non-finite retry deadline (%s)', (deadline) => {
    expect(resolve({
      stepCommandStatus: 'stale',
      nextStepCommandRetryAtMs: deadline,
    })).toBeNull();
  });

  it('prefers the in-flight command over a stale retry window', () => {
    expect(resolve({
      stepCommandPending: true,
      stepCommandStatus: 'stale',
      nextStepCommandRetryAtMs: NOW + 5_000,
    })).toEqual({ status: 'awaiting_confirmation', requestedStepId: 'low' });
  });
});
