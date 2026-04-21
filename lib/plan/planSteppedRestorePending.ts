import type { DevicePlanDevice } from './planTypes';
import { buildRestorePendingReason } from './planReasonStrings';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import { resolveSteppedLoadCommandPendingMs } from './planObservationPolicy';
import { resolveSteppedLoadPlanningKw } from './planSteppedLoad';

export type SteppedRestoreAttemptState = {
  status: 'awaiting_confirmation' | 'retry_backoff';
  remainingSec: number;
};

export type PendingSteppedRestoreHold = {
  reason: ReturnType<typeof buildRestorePendingReason>;
  remainingSec: number;
  reasonCode: 'waiting_confirmation' | 'retry_backoff';
};

export type PendingSteppedRestoreReservation = PendingSteppedRestoreHold & {
  reservationKw: number;
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

export function resolvePendingSteppedRestoreReservation(
  dev: DevicePlanDevice,
  requestedStepId: string,
  nowMs: number = Date.now(),
): PendingSteppedRestoreReservation | null {
  const hold = resolvePendingSteppedRestoreHold(dev, requestedStepId, nowMs);
  if (!hold) return null;

  const targetKw = resolveSteppedLoadPlanningKw(dev, requestedStepId);
  const currentPlanningKw = resolveEffectiveCurrentOn(dev) === false
    ? 0
    : resolveSteppedLoadPlanningKw(dev, dev.selectedStepId);
  const measuredKw = typeof dev.measuredPowerKw === 'number' && Number.isFinite(dev.measuredPowerKw)
    ? Math.max(0, dev.measuredPowerKw)
    : 0;
  const effectiveCurrentKw = Math.min(targetKw, Math.max(currentPlanningKw, measuredKw));

  return {
    ...hold,
    reservationKw: Math.max(0, targetKw - effectiveCurrentKw),
  };
}
