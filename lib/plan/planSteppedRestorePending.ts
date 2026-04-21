import type { DevicePlanDevice } from './planTypes';
import { buildRestorePendingReason } from './planReasonStrings';
import { resolveSteppedLoadCommandPendingMs } from './planObservationPolicy';

export type SteppedRestoreAttemptState = {
  status: 'awaiting_confirmation' | 'retry_backoff';
  remainingSec: number;
};

export type PendingSteppedRestoreHold = {
  reason: ReturnType<typeof buildRestorePendingReason>;
  remainingSec: number;
  reasonCode: 'waiting_confirmation' | 'retry_backoff';
};

export function resolveSteppedRestoreAttemptState(
  dev: DevicePlanDevice,
  requestedStepId: string,
  nowMs: number = Date.now(),
): SteppedRestoreAttemptState | null {
  if (dev.lastDesiredStepId !== requestedStepId) return null;

  if (dev.stepCommandPending === true) {
    const pendingWindowMs = resolveSteppedLoadCommandPendingMs(dev.communicationModel);
    const issuedAtMs = typeof dev.lastStepCommandIssuedAt === 'number'
      ? dev.lastStepCommandIssuedAt
      : nowMs;
    const remainingSec = Math.max(1, Math.ceil((issuedAtMs + pendingWindowMs - nowMs) / 1000));
    return {
      status: 'awaiting_confirmation',
      remainingSec,
    };
  }

  if (
    dev.stepCommandStatus === 'stale'
    && typeof dev.nextStepCommandRetryAtMs === 'number'
    && nowMs < dev.nextStepCommandRetryAtMs
  ) {
    const remainingSec = Math.max(1, Math.ceil((dev.nextStepCommandRetryAtMs - nowMs) / 1000));
    return {
      status: 'retry_backoff',
      remainingSec,
    };
  }

  return null;
}

export function resolvePendingSteppedRestoreHold(
  dev: DevicePlanDevice,
  requestedStepId: string,
  nowMs: number = Date.now(),
): PendingSteppedRestoreHold | null {
  const attempt = resolveSteppedRestoreAttemptState(dev, requestedStepId, nowMs);
  if (!attempt) return null;
  return {
    reason: buildRestorePendingReason(attempt.remainingSec),
    remainingSec: attempt.remainingSec,
    reasonCode: attempt.status === 'awaiting_confirmation' ? 'waiting_confirmation' : 'retry_backoff',
  };
}
