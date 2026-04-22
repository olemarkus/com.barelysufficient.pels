import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { StructuredDebugEmitter } from '../logging/logger';
import { incPerfCounter } from '../utils/perfCounters';
import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeRestoreBufferKw } from './planRestoreAccounting';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from './planDebugDedupe';
import {
  buildPendingSteppedRestoreHold,
  resolveSteppedRestoreObservedGapKw,
  resolveSteppedRestoreAttemptState,
} from './planSteppedRestorePending';

export function applySteppedRestoreAttemptHold(params: {
  dev: DevicePlanDevice;
  nextStepId: string;
  nextStepPowerKw: number;
  lastRestoreMs?: number;
  measurementTs?: number | null;
  phase: 'startup' | 'runtime';
  state: PlanEngineState;
  restoreDebugKey: string;
  debugStructured?: StructuredDebugEmitter;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  setDevice: (updates: Partial<DevicePlanDevice>) => void;
}): { handled: boolean; availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    nextStepId,
    nextStepPowerKw,
    lastRestoreMs,
    measurementTs = null,
    phase,
    state,
    restoreDebugKey,
    debugStructured,
    availableHeadroom,
    restoredOneThisCycle,
    setDevice,
  } = params;
  const nowMs = Date.now();
  const steppedRestoreAttempt = resolveSteppedRestoreAttemptState(
    dev,
    nextStepId,
    nowMs,
    lastRestoreMs,
    measurementTs,
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
        currentStepId: dev.selectedStepId ?? 'unknown',
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
        currentStepId: dev.selectedStepId ?? 'unknown',
        requestedStepId: nextStepId,
        decision: 'deferred',
        reasonCode: pendingRestoreHold.reasonCode,
      },
      debugStructured,
    });
    return {
      handled: true,
      availableHeadroom: availableHeadroom - needed,
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
    return { handled: true, availableHeadroom, restoredOneThisCycle };
  }

  return { handled: false, availableHeadroom, restoredOneThisCycle };
}
