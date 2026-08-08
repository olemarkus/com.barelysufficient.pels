import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { computeBaseRestoreNeed } from './restore/accounting';
import { getSteppedLoadShedTargetStep, isSteppedLoadDevice } from './planSteppedLoad';
import { buildShortfallReason } from './planReasonStrings';
import { getInactiveReason } from './restore/devices';
import type { DevicePlanDevice } from './planTypes';

export function applyOffStateReason(params: {
  planDevice: DevicePlanDevice;
  headroomRaw: number;
  guardInShortfall: boolean;
}): DevicePlanDevice {
  const { planDevice, headroomRaw, guardInShortfall } = params;
  if (!planDevice.controllable) return planDevice;
  if (planDevice.currentState !== 'off') return planDevice;
  const inactiveReason = getInactiveReason(planDevice);
  if (inactiveReason) {
    return {
      ...planDevice,
      plannedState: 'inactive',
      reason: inactiveReason,
    };
  }
  const shouldForceOffStep = guardInShortfall && isSteppedLoadDevice(planDevice);
  const desiredStepId = shouldForceOffStep
    ? getSteppedLoadShedTargetStep({
      device: planDevice,
      shedAction: 'turn_off',
      currentDesiredStepId: planDevice.desiredStepId,
    })?.id ?? planDevice.desiredStepId
    : planDevice.desiredStepId;
  if (planDevice.plannedState === 'shed') {
    return desiredStepId === planDevice.desiredStepId ? planDevice : {
      ...planDevice,
      desiredStepId,
    };
  }
  const { needed: need } = computeBaseRestoreNeed(planDevice);
  if (guardInShortfall) {
    return {
      ...planDevice,
      plannedState: 'shed',
      desiredStepId,
      reason: buildShortfallReason(need, headroomRaw),
    };
  }
  return {
    ...planDevice,
    reason: { code: PLAN_REASON_CODES.keep, detail: null },
  };
}
