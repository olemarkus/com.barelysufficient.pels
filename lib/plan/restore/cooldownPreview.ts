import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from '../planTypes';
import { canAdmitWithinBatch, recordBatchAdmission } from './batch';
import { isOffSteppedRestoreCandidate } from './devices';
import { buildOffSteppedRestoreShedUpdate, setRestorePlanDevice } from './planDeviceUpdates';
import type { RestoreAdmissionMode, RestoreBatchState, RestoreLoopState } from './types';

export const shouldApplyInCycleRestoreGate = (
  admissionMode: RestoreAdmissionMode,
  restoredOneThisCycle: boolean,
  batchContinuation: boolean,
): boolean => admissionMode.kind === 'apply' && restoredOneThisCycle && !batchContinuation;

export const shouldRejectBatchContinuation = (
  admissionMode: RestoreAdmissionMode,
  batchContinuation: boolean,
  batchState: RestoreBatchState,
  neededKw: number,
): boolean => admissionMode.kind === 'apply'
  && batchContinuation
  && !canAdmitWithinBatch(batchState, neededKw);

export function applyBinaryCooldownPreviewAdmission(params: {
  admissionMode: RestoreAdmissionMode;
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  availableHeadroom: number;
  neededKw: number;
  restoredOneThisCycle: boolean;
  batchContinuation: boolean;
  batchState: RestoreBatchState;
}): RestoreLoopState | null {
  const { admissionMode } = params;
  if (admissionMode.kind !== 'cooldown_preview') return null;
  const canJoinBatch = params.batchContinuation
    && canAdmitWithinBatch(params.batchState, params.neededKw);
  const selected = !params.restoredOneThisCycle || canJoinBatch;
  setRestorePlanDevice(params.deviceMap, params.dev.id, {
    plannedState: 'shed',
    reason: selected
      ? admissionMode.holdReason
      : { code: PLAN_REASON_CODES.waitingForOtherDevices },
  });
  if (!selected) {
    return {
      availableHeadroom: params.availableHeadroom,
      restoredOneThisCycle: params.restoredOneThisCycle,
    };
  }
  recordBatchAdmission(params.batchState, params.neededKw);
  return {
    availableHeadroom: params.availableHeadroom - params.neededKw,
    restoredOneThisCycle: true,
  };
}

export function applySteppedCooldownPreviewAdmission(params: {
  admissionMode: RestoreAdmissionMode;
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  availableHeadroom: number;
  neededKw: number;
  restoredOneThisCycle: boolean;
}): RestoreLoopState | null {
  const { admissionMode } = params;
  if (admissionMode.kind !== 'cooldown_preview') return null;
  const selected = !params.restoredOneThisCycle;
  setRestorePlanDevice(params.deviceMap, params.dev.id, {
    ...(isOffSteppedRestoreCandidate(params.dev) ? buildOffSteppedRestoreShedUpdate(params.dev) : {}),
    reason: selected
      ? admissionMode.holdReason
      : { code: PLAN_REASON_CODES.waitingForOtherDevices },
  });
  return {
    availableHeadroom: selected
      ? params.availableHeadroom - params.neededKw
      : params.availableHeadroom,
    restoredOneThisCycle: true,
  };
}

export function preservePreviewAdmission(
  result: RestoreLoopState,
  admissionMode: RestoreAdmissionMode,
  restoredOneThisCycle: boolean,
): RestoreLoopState {
  return admissionMode.kind === 'cooldown_preview' && restoredOneThisCycle
    ? { ...result, restoredOneThisCycle: true }
    : result;
}
