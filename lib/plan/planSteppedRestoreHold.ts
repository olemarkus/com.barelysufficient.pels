import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { SteppedLoadStep } from '../../packages/contracts/src/types';
import { incPerfCounter } from '../utils/perfCounters';
import type { MeteredKind, SteppedPlanDevice } from './planTypes';
import { computeRestoreBufferKw } from './restore/accounting';
import { setRestorePlanDevice } from './restore/planDeviceUpdates';
import type { RestoreCycle, RestoreLoopState } from './restore/types';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from './planDebugDedupe';
import {
  buildPendingSteppedRestoreHold,
  resolveSteppedRestoreObservedGapKw,
  resolveSteppedRestoreAttemptState,
} from './planSteppedRestorePending';

export type SteppedRestoreAttemptHold =
  | { kind: 'pending'; availableHeadroom: number | null; restoredOneThisCycle: true }
  | { kind: 'retry_backoff'; availableHeadroom: number | null; restoredOneThisCycle: boolean }
  | { kind: 'not_handled'; availableHeadroom: number | null; restoredOneThisCycle: boolean };

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function applySteppedRestoreAttemptHold(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice & MeteredKind,
  loop: RestoreLoopState,
  nextStep: SteppedLoadStep,
): SteppedRestoreAttemptHold {
  const { state, timing, phase, deviceMap } = cycle;
  const { availableHeadroom, restoredOneThisCycle } = loop;
  const nextStepId = nextStep.id;
  const nextStepPowerKw = nextStep.planningPowerW / 1000;
  const restoreDebugKey = `stepped:${dev.id}`;
  const nowMs = Date.now();
  const steppedRestoreAttempt = resolveSteppedRestoreAttemptState(
    dev, nextStepId, nowMs, state.actuation.lastDeviceRestoreMs[dev.id], timing.measurementTs,
  );
  const pendingRestoreHold = buildPendingSteppedRestoreHold(steppedRestoreAttempt);
  if (pendingRestoreHold) {
    delete state.steppedRestoreRejectedByDevice[dev.id];
    incPerfCounter('restore_planning_skipped_inflight');
    let reservationGapKw = 0;
    if (steppedRestoreAttempt) {
      reservationGapKw = steppedRestoreAttempt.status === 'awaiting_power_settle'
        ? steppedRestoreAttempt.deltaKw
        : resolveSteppedRestoreObservedGapKw(dev, steppedRestoreAttempt);
    }
    const needed = reservationGapKw > 0 ? computeRestoreBufferKw(reservationGapKw) : 0;
    setRestorePlanDevice(deviceMap, dev.id, {
      desiredStepId: nextStepId,
      expectedPowerKw: nextStepPowerKw,
      reason: pendingRestoreHold.reason,
    });
    emitRestoreDebugEventOnChange(state, restoreDebugKey, {
      event: 'restore_stepped_deferred',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId,
      requestedStepId: nextStepId,
      decision: 'deferred',
      reasonCode: pendingRestoreHold.reasonCode,
      remainingSec: pendingRestoreHold.remainingSec,
    }, {
      event: 'restore_stepped_deferred',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId,
      requestedStepId: nextStepId,
      decision: 'deferred',
      reasonCode: pendingRestoreHold.reasonCode,
    });
    return {
      kind: 'pending',
      availableHeadroom: availableHeadroom === null ? null : availableHeadroom - needed,
      restoredOneThisCycle: true,
    };
  }

  if (steppedRestoreAttempt?.status === 'retry_backoff') {
    delete state.steppedRestoreRejectedByDevice[dev.id];
    clearRestoreDebugEvent(state, restoreDebugKey);
    setRestorePlanDevice(deviceMap, dev.id, {
      desiredStepId: nextStepId,
      expectedPowerKw: nextStepPowerKw,
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    });
    return { kind: 'retry_backoff', availableHeadroom, restoredOneThisCycle };
  }

  return { kind: 'not_handled', availableHeadroom, restoredOneThisCycle };
}
/* eslint-enable functional/immutable-data */
