import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { computeBaseRestoreNeed } from './restore/accounting';
import { getSteppedLoadShedTargetStep, isSteppedLoadDevice } from './planSteppedLoad';
import { buildShortfallReason } from './planReasonStrings';
import { getInactiveReason } from './restore/devices';
import type { DevicePlanDevice } from './planTypes';

/**
 * Whether the capacity guard is in shortfall this cycle, and — only then —
 * the measured headroom the shortfall reason is written against. The two
 * travel together because the number is meaningful only in the shortfall
 * case: the silent-meter pass has no measurement and passes `inShortfall:
 * false`, and no reader can reach a headroom it was not given.
 */
export type ShortfallOffState =
  | { inShortfall: true; headroomKw: number }
  | { inShortfall: false };

export function resolveShortfallOffState(guardInShortfall: boolean, headroomKw: number): ShortfallOffState {
  return guardInShortfall ? { inShortfall: true, headroomKw } : { inShortfall: false };
}

export function applyOffStateReason(planDevice: DevicePlanDevice, shortfall: ShortfallOffState): DevicePlanDevice {
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
  const shouldForceOffStep = shortfall.inShortfall && isSteppedLoadDevice(planDevice);
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
  if (shortfall.inShortfall) {
    const { needed: need } = computeBaseRestoreNeed(planDevice);
    return {
      ...planDevice,
      plannedState: 'shed',
      desiredStepId,
      reason: buildShortfallReason(need, shortfall.headroomKw),
    };
  }
  return {
    ...planDevice,
    reason: { code: PLAN_REASON_CODES.keep, detail: null },
  };
}
