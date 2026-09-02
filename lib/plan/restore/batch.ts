import { RESTORE_BATCH_HEADROOM_FRACTION, RESTORE_BATCH_MAX_DEVICES } from '../planConstants';
import type { RestoreTiming } from './timing';
import type { RestoreBatchState } from './types';

export function buildRestoreBatchState(params: {
  timing: RestoreTiming;
  availableHeadroom: number;
}): RestoreBatchState {
  const { timing, availableHeadroom } = params;
  const enabled = availableHeadroom > 0
    && !timing.inCooldown
    && !timing.inRestoreCooldown
    && !timing.inStartupStabilization
    && !timing.activeOvershoot;
  return {
    enabled,
    maxDevices: RESTORE_BATCH_MAX_DEVICES,
    maxNeedKw: Math.max(0, availableHeadroom * RESTORE_BATCH_HEADROOM_FRACTION),
    admittedCount: 0,
    admittedNeedKw: 0,
  };
}

// One-at-a-time admission: the exempt restore lane runs while shedding is
// latched, where batch continuation must stay off even in the hysteresis band
// (activeOvershoot false) — so it gets an explicitly-disabled batch state
// rather than relying on buildRestoreBatchState's overshoot conjunct.
export function buildDisabledRestoreBatchState(): RestoreBatchState {
  return {
    enabled: false,
    maxDevices: RESTORE_BATCH_MAX_DEVICES,
    maxNeedKw: 0,
    admittedCount: 0,
    admittedNeedKw: 0,
  };
}

export function canAttemptBatchContinuation(batchState: RestoreBatchState): boolean {
  return batchState.enabled && batchState.admittedCount > 0 && batchState.admittedCount < batchState.maxDevices;
}

export function canAdmitWithinBatch(batchState: RestoreBatchState, neededKw: number): boolean {
  return batchState.admittedNeedKw + neededKw <= batchState.maxNeedKw;
}

export function recordBatchAdmission(batchState: RestoreBatchState, neededKw: number): void {
  Object.assign(batchState, {
    admittedCount: batchState.admittedCount + 1,
    admittedNeedKw: batchState.admittedNeedKw + neededKw,
  });
}
