import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { isRestoreAdmissionHoldReason } from '../planContract/planDecisionSemantics';
import type { PlannedTargetCommand } from '../planContract/targetCommand';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import type { DevicePlanDevice } from './planTypes';

/** Select the target axis after all stages have settled this build's decision. */
export function buildPlannedTargetCommand(
  device: DevicePlanDevice,
  recordRestoreOnTargetApply: boolean,
): PlannedTargetCommand | undefined {
  if (!isTemperaturePlanDevice(device)) return undefined;
  if (device.waitingForTaskPlan && device.plannedShedTargetKind !== 'target_value') return undefined;
  if (device.externalThermostatRole && device.temperatureBindingGeneration === undefined) return undefined;
  if (device.reason?.code === PLAN_REASON_CODES.swapPending && device.reason.targetName === null) return undefined;
  if (device.reason && isRestoreAdmissionHoldReason(device.reason)) return undefined;
  return {
    deviceId: device.id,
    name: device.name,
    desired: device.plannedTarget,
    ...(device.temperatureBindingGeneration === undefined ? {} : {
      temperatureBindingGeneration: device.temperatureBindingGeneration,
    }),
    purpose: device.plannedShedTargetKind === 'target_value' ? 'shed_temperature' : 'target_update',
    recordRestoreOnTargetApply,
    restoreFromTarget: device.currentTarget,
  };
}
