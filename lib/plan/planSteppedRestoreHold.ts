import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { incPerfCounter } from '../utils/perfCounters';
import type { DevicePlanDevice, MeteredKind, SteppedPlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeRestoreBufferKw } from './restore/accounting';
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
export function applySteppedRestoreAttemptHold(params: {
  dev: SteppedPlanDevice & MeteredKind;
  nextStepId: string;
  nextStepPowerKw: number;
  lastRestoreMs?: number;
  measurementTs?: number | null;
  phase: 'startup' | 'runtime';
  state: PlanEngineState;
  restoreDebugKey: string;
  availableHeadroom: number | null;
  restoredOneThisCycle: boolean;
  setDevice: (updates: Partial<DevicePlanDevice>) => void;
}): SteppedRestoreAttemptHold {
  const {
    dev,
    nextStepId,
    nextStepPowerKw,
    lastRestoreMs,
    measurementTs = null,
    phase,
    state,
    restoreDebugKey,
    availableHeadroom,
    restoredOneThisCycle,
    setDevice,
  } = params;
  const nowMs = Date.now();
  const steppedRestoreAttempt = resolveSteppedRestoreAttemptState(
    dev,
    nextStepId,
    nowMs,
    {
      lastRestoreMs,
      measurementTs,
    },
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
    setDevice({
      desiredStepId: nextStepId,
      expectedPowerKw: nextStepPowerKw,
      reason: pendingRestoreHold.reason,
    });
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_stepped_deferred',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        currentStepId: dev.selectedStepId,
        requestedStepId: nextStepId,
        decision: 'deferred',
        reasonCode: pendingRestoreHold.reasonCode,
        remainingSec: pendingRestoreHold.remainingSec,
      },
      signaturePayload: {
        event: 'restore_stepped_deferred',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        currentStepId: dev.selectedStepId,
        requestedStepId: nextStepId,
        decision: 'deferred',
        reasonCode: pendingRestoreHold.reasonCode,
      },
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
    setDevice({
      desiredStepId: nextStepId,
      expectedPowerKw: nextStepPowerKw,
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    });
    return { kind: 'retry_backoff', availableHeadroom, restoredOneThisCycle };
  }

  return { kind: 'not_handled', availableHeadroom, restoredOneThisCycle };
}
/* eslint-enable functional/immutable-data */
