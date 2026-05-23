import {
  formatDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { computeBaseRestoreNeed } from './restore/accounting';
import { getSteppedLoadShedTargetStep, isSteppedLoadDevice } from './planSteppedLoad';
import { buildRestoreNeedReason, buildShortfallReason } from './planReasonStrings';
import { getInactiveReason, getEvRestoreStateBlockReason } from './restore/devices';
import type { DevicePlanDevice } from './planTypes';

function resolveEvPhysicalBlockInactiveReason(planDevice: DevicePlanDevice): string | null {
  const { evChargingState } = planDevice;
  if (evChargingState !== 'plugged_out' && evChargingState !== 'plugged_in_discharging') return null;
  return getEvRestoreStateBlockReason(planDevice) ?? null;
}

export function applyOffStateReason(params: {
  planDevice: DevicePlanDevice;
  headroomRaw: number;
  guardInShortfall: boolean;
}): DevicePlanDevice {
  const { planDevice, headroomRaw, guardInShortfall } = params;
  if (!planDevice.controllable) return planDevice;
  const physicalBlockReason = resolveEvPhysicalBlockInactiveReason(planDevice);
  if (physicalBlockReason) {
    return {
      ...planDevice,
      plannedState: 'inactive',
      reason: { code: PLAN_REASON_CODES.inactive, detail: physicalBlockReason },
    };
  }
  if (planDevice.currentState !== 'off') return planDevice;
  // Full inactive check (including power-unknown) is safe once the device is confirmed off.
  const inactiveReason = getInactiveReason(planDevice);
  if (inactiveReason) {
    return { ...planDevice, plannedState: 'inactive', reason: inactiveReason };
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
    candidateReasons: {
      ...planDevice.candidateReasons,
      offStateAnalysis: formatDeviceReason(buildRestoreNeedReason(need, headroomRaw)),
    },
  };
}
