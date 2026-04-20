import type { DevicePlanDevice } from './planTypes';
import { buildRestorePendingReason } from './planReasonStrings';
import { resolveSteppedLoadCommandPendingMs } from './planObservationPolicy';

export type PendingSteppedRestoreHold = {
  reason: ReturnType<typeof buildRestorePendingReason>;
  remainingSec: number;
  reasonCode: 'waiting_confirmation' | 'retry_backoff';
};

export function resolvePendingSteppedRestoreHold(
  dev: DevicePlanDevice,
  requestedStepId: string,
  nowMs: number = Date.now(),
): PendingSteppedRestoreHold | null {
  if (dev.lastDesiredStepId !== requestedStepId) return null;

  if (dev.stepCommandPending === true) {
    const pendingWindowMs = resolveSteppedLoadCommandPendingMs(dev.communicationModel);
    const issuedAtMs = typeof dev.lastStepCommandIssuedAt === 'number'
      ? dev.lastStepCommandIssuedAt
      : nowMs;
    const remainingSec = Math.max(1, Math.ceil((issuedAtMs + pendingWindowMs - nowMs) / 1000));
    return {
      reason: buildRestorePendingReason(remainingSec),
      remainingSec,
      reasonCode: 'waiting_confirmation',
    };
  }

  if (
    dev.stepCommandStatus === 'stale'
    && typeof dev.nextStepCommandRetryAtMs === 'number'
    && nowMs < dev.nextStepCommandRetryAtMs
  ) {
    const remainingSec = Math.max(1, Math.ceil((dev.nextStepCommandRetryAtMs - nowMs) / 1000));
    return {
      reason: buildRestorePendingReason(remainingSec),
      remainingSec,
      reasonCode: 'retry_backoff',
    };
  }

  return null;
}
