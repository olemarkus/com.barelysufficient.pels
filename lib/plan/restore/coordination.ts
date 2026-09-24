import type { DevicePlanDevice } from '../planTypes';
import { getInactiveReason, isRestoreLiveEligibleDevice } from './devices';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { isTemperaturePlanDevice } from '../planTemperatureDevice';
import { getSteppedLoadStep } from '../../utils/deviceControlProfiles';
import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { ShedDecisions } from '../shedDecisions';

function isTargetRestorePending(device: DevicePlanDevice): boolean {
  if (!isTemperaturePlanDevice(device)) return false;
  const { currentTarget, plannedTarget } = device;
  return device.shedAction === 'set_temperature'
    && currentTarget !== plannedTarget
    && device.pendingTargetCommand?.status === 'waiting_confirmation'
    && device.pendingTargetCommand?.desired === plannedTarget;
}

function isSteppedRestorePending(device: DevicePlanDevice): boolean {
  if (!isSteppedLoadDevice(device)) return false;
  // In the same plan pass the executor has not published `stepCommandPending`
  // yet. `restoreNeed` is the planner's admission decision; keep other loads
  // behind it until the observed step catches up. This marker also covers an
  // off device whose selected rung already matches its first active rung.
  if (device.reason.code === PLAN_REASON_CODES.restoreNeed) return true;
  if (device.stepCommandPending !== true) return false;
  if (!device.desiredStepId || device.desiredStepId === device.selectedStepId) {
    return false;
  }
  const selectedStep = getSteppedLoadStep(device.steppedLoadProfile, device.selectedStepId);
  const desiredStep = getSteppedLoadStep(device.steppedLoadProfile, device.desiredStepId);
  if (!selectedStep || !desiredStep) return false;
  return desiredStep.planningPowerW > selectedStep.planningPowerW;
}

function isDeviceBlockingSteppedRestore(
  device: DevicePlanDevice,
  shedDecisions: ShedDecisions,
): boolean {
  if (device.plannedState !== 'keep') return false;
  if (
    isTargetRestorePending(device)
    || isSteppedRestorePending(device)
    || device.binaryCommandPending === true
  ) return true;
  // A provisional keep is not yet a recovery: current-cycle candidates still
  // have to pass admission. Only a keep the previous plan made with command
  // authority can be waiting for its observation to confirm recovery here.
  if (!shedDecisions.lastPlannedKeptIds.has(device.id) || !shedDecisions.decidedMs[device.id]) return false;
  return device.currentState === 'off' || device.currentState === 'unknown';
}

function isDeviceUnconfirmedRecoveryInFlight(device: DevicePlanDevice): boolean {
  if (device.plannedState !== 'keep') return false;
  return device.binaryCommandPending === true
    || isTargetRestorePending(device)
    || isSteppedRestorePending(device);
}

export function shouldWaitForOtherRecovery(
  deviceMap: Map<string, DevicePlanDevice>,
  deviceId: string,
  batchContinuation: boolean,
): boolean {
  for (const device of deviceMap.values()) {
    if (device.id === deviceId) continue;
    if (!isRestoreLiveEligibleDevice(device)) continue;
    if (getInactiveReason(device)) continue;
    if (!isDeviceUnconfirmedRecoveryInFlight(device)) continue;
    if (!batchContinuation) return true;
    if (
      isSteppedLoadDevice(device)
      && device.plannedState === 'keep'
      && device.currentState === 'off'
      && device.reason.code === PLAN_REASON_CODES.restoreNeed
      && device.selectedStepId !== undefined
      && device.selectedStepId === device.desiredStepId
    ) return true;
  }
  return false;
}

export function hasOtherDevicesBlockingSteppedRestore(
  deviceMap: Map<string, DevicePlanDevice>,
  steppedDeviceId: string,
  shedDecisions: ShedDecisions,
): boolean {
  for (const device of deviceMap.values()) {
    if (device.id === steppedDeviceId) continue;
    if (!isRestoreLiveEligibleDevice(device)) continue;
    if (getInactiveReason(device)) continue;
    if (isDeviceBlockingSteppedRestore(device, shedDecisions)) return true;
  }
  return false;
}

export function countShedDevices(
  deviceMap: Map<string, DevicePlanDevice>,
  excludeId: string,
  shedDecisions: ShedDecisions,
): number {
  let count = 0;
  for (const device of deviceMap.values()) {
    if (device.id === excludeId) continue;
    if (device.control.commandAuthority === false) continue;
    // Base plan keep is provisional until this pass admits a previous-shed or
    // unplanned candidate. Keep those in the invariant's shed count meanwhile.
    if (device.plannedState === 'shed' || shedDecisions.wasShedOrUnplanned(device.id)) count += 1;
  }
  return count;
}
