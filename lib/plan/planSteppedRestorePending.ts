import type { DevicePlanDevice } from './planTypes';
import { buildMeterSettlingReason, buildRestorePendingReason } from './planReasonStrings';
import { resolveSteppedLoadCommandPendingMs } from './planObservationPolicy';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import { RESTORE_COOLDOWN_MS } from './planConstants';

export type SteppedRestoreAttemptState = {
  status: 'awaiting_confirmation' | 'awaiting_power_settle' | 'retry_backoff';
  requestedStepId: string;
  requestedPowerKw: number;
  baselinePowerKw: number;
  deltaKw: number;
  remainingSec: number;
  countdownStartedAtMs?: number;
  countdownTotalSec?: number;
};

export type PendingSteppedRestoreHold = {
  reason: ReturnType<typeof buildRestorePendingReason> | ReturnType<typeof buildMeterSettlingReason>;
  remainingSec: number;
  reasonCode: 'waiting_confirmation' | 'meter_settling';
};

type SteppedRestoreAttemptOptions = {
  lastRestoreMs?: number;
  measurementTs?: number | null;
  powerSettleWindowMs?: number;
};

export function resolveSteppedRestoreAttemptState(
  dev: DevicePlanDevice,
  requestedStepId: string,
  nowMs: number = Date.now(),
  options: SteppedRestoreAttemptOptions = {},
): SteppedRestoreAttemptState | null {
  const {
    lastRestoreMs,
    measurementTs = null,
    powerSettleWindowMs = RESTORE_COOLDOWN_MS,
  } = options;
  const baseAttempt = resolveSteppedRestoreBaseAttempt(dev, requestedStepId);
  if (!baseAttempt) return null;
  const pendingAttempt = resolvePendingOrBackoffAttempt(dev, baseAttempt, nowMs);
  if (pendingAttempt) return pendingAttempt;

  if (!baseAttempt.reservation) return null;

  const powerSettleRemainingSec = resolveSteppedRestorePowerSettleRemainingSec({
    dev,
    lastRestoreMs,
    measurementTs,
    nowMs,
    powerSettleWindowMs,
  });
  if (powerSettleRemainingSec !== null) {
    return {
      status: 'awaiting_power_settle',
      requestedStepId: baseAttempt.requestedStepId,
      requestedPowerKw: baseAttempt.reservation.requestedPowerKw,
      baselinePowerKw: baseAttempt.reservation.baselinePowerKw,
      deltaKw: baseAttempt.reservation.deltaKw,
      remainingSec: powerSettleRemainingSec,
      countdownStartedAtMs: lastRestoreMs,
      countdownTotalSec: Math.ceil(powerSettleWindowMs / 1000),
    };
  }

  return null;
}

export function resolveActiveSteppedRestoreReservation(
  dev: DevicePlanDevice,
  requestedStepId: string,
  nowMs: number = Date.now(),
  options: SteppedRestoreAttemptOptions = {},
): SteppedRestoreAttemptState | null {
  const attempt = resolveSteppedRestoreAttemptState(
    dev,
    requestedStepId,
    nowMs,
    options,
  );
  return attempt && attempt.status !== 'retry_backoff' && attempt.deltaKw > 0 ? attempt : null;
}

export function buildPendingSteppedRestoreHold(
  attempt: SteppedRestoreAttemptState | null,
): PendingSteppedRestoreHold | null {
  if (!attempt || attempt.status === 'retry_backoff') return null;
  return {
    reason: attempt.status === 'awaiting_confirmation'
      ? buildRestorePendingReason(attempt.remainingSec, {
        countdownStartedAtMs: attempt.countdownStartedAtMs,
        countdownTotalSec: attempt.countdownTotalSec,
      })
      : buildMeterSettlingReason(attempt.remainingSec, {
        countdownStartedAtMs: attempt.countdownStartedAtMs,
        countdownTotalSec: attempt.countdownTotalSec,
      }),
    remainingSec: attempt.remainingSec,
    reasonCode: attempt.status === 'awaiting_confirmation'
      ? 'waiting_confirmation'
      : 'meter_settling',
  };
}

function resolveSteppedRestoreReservation(
  dev: DevicePlanDevice,
  requestedStepId: string,
): { requestedPowerKw: number; baselinePowerKw: number; deltaKw: number } | null {
  if (!isSteppedLoadDevice(dev) || !dev.steppedLoadProfile) return null;
  if (dev.lastDesiredStepId !== requestedStepId) return null;

  const requestedStep = getSteppedLoadStep(dev.steppedLoadProfile, requestedStepId);
  if (!requestedStep || requestedStep.planningPowerW <= 0) return null;

  const effectiveCurrentOn = resolveEffectiveCurrentOn(dev);
  const baselineStepId = effectiveCurrentOn === false
    ? undefined
    : (dev.previousStepId ?? dev.selectedStepId);
  const baselineStep = baselineStepId
    ? getSteppedLoadStep(dev.steppedLoadProfile, baselineStepId)
    : null;
  const baselinePowerKw = effectiveCurrentOn === false
    ? 0
    : Math.max(0, (baselineStep?.planningPowerW ?? 0) / 1000);
  const requestedPowerKw = requestedStep.planningPowerW / 1000;
  const deltaKw = Math.max(0, requestedPowerKw - baselinePowerKw);
  if (deltaKw <= 0) return null;

  return { requestedPowerKw, baselinePowerKw, deltaKw };
}

function resolveSteppedRestoreBaseAttempt(
  dev: DevicePlanDevice,
  requestedStepId: string,
): {
  requestedStepId: string;
  requestedPowerKw: number;
  baselinePowerKw: number;
  deltaKw: number;
  reservation: { requestedPowerKw: number; baselinePowerKw: number; deltaKw: number } | null;
} | null {
  if (!isSteppedLoadDevice(dev) || !dev.steppedLoadProfile) return null;
  if (dev.lastDesiredStepId !== requestedStepId) return null;

  const requestedStep = getSteppedLoadStep(dev.steppedLoadProfile, requestedStepId);
  if (!requestedStep) return null;
  const reservation = resolveSteppedRestoreReservation(dev, requestedStepId);
  const requestedPowerKw = requestedStep.planningPowerW / 1000;
  return {
    requestedStepId,
    requestedPowerKw,
    baselinePowerKw: reservation?.baselinePowerKw ?? requestedPowerKw,
    deltaKw: reservation?.deltaKw ?? 0,
    reservation,
  };
}

function resolvePendingOrBackoffAttempt(
  dev: DevicePlanDevice,
  baseAttempt: {
    requestedStepId: string;
    requestedPowerKw: number;
    baselinePowerKw: number;
    deltaKw: number;
  },
  nowMs: number,
): SteppedRestoreAttemptState | null {
  if (dev.stepCommandPending === true) {
    const pendingWindowMs = resolveSteppedLoadCommandPendingMs(dev.communicationModel);
    const issuedAtMs = typeof dev.lastStepCommandIssuedAt === 'number'
      ? dev.lastStepCommandIssuedAt
      : nowMs;
    const remainingSec = Math.max(1, Math.ceil((issuedAtMs + pendingWindowMs - nowMs) / 1000));
    return {
      status: 'awaiting_confirmation',
      ...baseAttempt,
      remainingSec,
      countdownStartedAtMs: issuedAtMs,
      countdownTotalSec: Math.ceil(pendingWindowMs / 1000),
    };
  }

  if (
    dev.stepCommandStatus !== 'stale'
    || typeof dev.nextStepCommandRetryAtMs !== 'number'
    || nowMs >= dev.nextStepCommandRetryAtMs
  ) {
    return null;
  }

  return {
    status: 'retry_backoff',
    ...baseAttempt,
    remainingSec: Math.max(1, Math.ceil((dev.nextStepCommandRetryAtMs - nowMs) / 1000)),
  };
}

function resolveSteppedRestorePowerSettleRemainingSec(params: {
  dev: DevicePlanDevice;
  lastRestoreMs?: number;
  measurementTs: number | null;
  nowMs: number;
  powerSettleWindowMs: number;
}): number | null {
  const {
    dev,
    lastRestoreMs,
    measurementTs,
    nowMs,
    powerSettleWindowMs,
  } = params;
  if (dev.stepCommandStatus !== 'success') return null;
  if (typeof lastRestoreMs !== 'number') return null;
  if (measurementTs !== null && measurementTs > lastRestoreMs) return null;
  const remainingMs = (lastRestoreMs + powerSettleWindowMs) - nowMs;
  if (remainingMs <= 0) return null;
  return Math.ceil(remainingMs / 1000);
}

export function resolveSteppedRestoreObservedGapKw(
  dev: DevicePlanDevice,
  reservation: Pick<SteppedRestoreAttemptState, 'baselinePowerKw' | 'deltaKw'>,
): number {
  const actualKw = Math.max(0, dev.measuredPowerKw ?? 0);
  const observedIncrementKw = Math.max(0, actualKw - reservation.baselinePowerKw);
  return Math.max(0, reservation.deltaKw - observedIncrementKw);
}
