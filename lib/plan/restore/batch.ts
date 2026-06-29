import type { PlanContext } from '../planContext';
import { RESTORE_BATCH_HEADROOM_FRACTION, RESTORE_BATCH_MAX_DEVICES } from '../planConstants';
import type { RestoreTiming } from './timing';
import type { RestoreBatchState } from './types';

export function buildRestoreBatchState(params: {
  context: PlanContext;
  timing: RestoreTiming;
  availableHeadroom: number;
}): RestoreBatchState {
  const { context, timing, availableHeadroom } = params;
  const enabled = availableHeadroom > 0
    && !timing.inCooldown
    && !timing.inRestoreCooldown
    && !timing.inStartupStabilization
    && !timing.activeOvershoot
    && context.powerFreshnessState === 'fresh';
  return {
    enabled,
    maxDevices: RESTORE_BATCH_MAX_DEVICES,
    maxNeedKw: Math.max(0, availableHeadroom * RESTORE_BATCH_HEADROOM_FRACTION),
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
