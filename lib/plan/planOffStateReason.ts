import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { SHORTFALL_REASON } from './planReasonStrings';
import { getSteppedLoadShedTargetStep, isSteppedLoadDevice } from './planSteppedLoad';
import { getInactiveReason } from './restore/devices';
import type { DevicePlanDevice } from './planTypes';

/**
 * `guardInShortfall`: the capacity guard is in shortfall this cycle. The
 * silent-meter pass has no measurement and passes `false`.
 */
export function applyOffStateReason(planDevice: DevicePlanDevice, guardInShortfall: boolean): DevicePlanDevice {
  if (!planDevice.control.commandAuthority) return planDevice;
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
    ? getSteppedLoadShedTargetStep(
      planDevice, 'turn_off', planDevice.desiredStepId,
    )?.id ?? planDevice.desiredStepId
    : planDevice.desiredStepId;
  if (planDevice.plannedState === 'shed') {
    return desiredStepId === planDevice.desiredStepId ? planDevice : {
      ...planDevice,
      desiredStepId,
    };
  }
  if (guardInShortfall) {
    return {
      ...planDevice,
      plannedState: 'shed',
      desiredStepId,
      reason: SHORTFALL_REASON,
    };
  }
  return {
    ...planDevice,
    reason: { code: PLAN_REASON_CODES.keep, detail: null },
  };
}
