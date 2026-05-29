import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan } from '../plan/planTypes';
import type { PlanEngineState } from '../plan/planState';
import type {
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
} from './executablePlan';
import { isObservedOff } from '../observer/observedState';
import { isSteppedLoadDevice, resolveSteppedKeepDesiredStepId } from '../plan/planSteppedLoad';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import {
  allowsSteppedLoadKeepInvariantRestore,
  isRestoreAdmissionHoldReason,
} from '../planContract/planDecisionSemantics';

export function resolveConfirmedBinaryCommandReasonCode(
  pending: PlanEngineState['pendingBinaryCommands'][string],
): string {
  if (!pending.desired) {
    if (pending.lifecycleRelease) return 'lifecycle_release';
    return pending.reason ? 'shed_with_reason' : 'shedding';
  }
  if (pending.logContext === 'capacity_control_off') {
    return 'capacity_control_off_restore';
  }
  if (pending.actuationMode === 'reconcile') {
    return 'reconcile_restore';
  }
  return pending.restoreSource ?? 'current_plan';
}

export function hasStableUncontrolledRestoreActuation(
  dev: DevicePlan['devices'][number],
  state: PlanEngineState,
): boolean {
  return dev.controllable === false
    && dev.plannedState === 'keep'
    && isObservedOff(dev)
    && Boolean(state.lastDeviceShedMs[dev.id]);
}

export function hasStableEvDeadlineActuation(dev: DevicePlan['devices'][number]): boolean {
  if (dev.binaryCommandPending === true) return false;
  if (dev.deferredReleaseIntent === 'ev_resume') {
    return dev.evChargingState === 'plugged_in_paused';
  }
  if (dev.deferredReleaseIntent === 'ev_pause') {
    return dev.evChargingState === 'plugged_in_charging';
  }
  return false;
}

export function isSteppedLoadRestoreFromOff(
  intent: ExecutableSteppedLoadIntent | null,
  action: ExecutableSteppedLoadDevice | null,
): boolean {
  return Boolean(intent?.purpose === 'keep' && action?.current.on === false);
}

export function hasStableSteppedLoadStepActuation(dev: DevicePlan['devices'][number]): boolean {
  if (!isSteppedLoadDevice(dev) || dev.plannedState !== 'keep' || !dev.steppedLoadProfile) return false;
  const desiredStepId = resolveSteppedKeepDesiredStepId(dev);
  if (!desiredStepId || !dev.selectedStepId || desiredStepId === dev.selectedStepId) return false;
  if (hasEquivalentSteppedLoadCommandHold(dev, desiredStepId)) return false;

  const selectedStep = getSteppedLoadStep(dev.steppedLoadProfile, dev.selectedStepId);
  const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, desiredStepId);
  if (!selectedStep || !desiredStep) return false;
  if (desiredStep.planningPowerW < selectedStep.planningPowerW) {
    return !isObservedOff(dev)
      || !isRestoreHoldReason(dev.reason);
  }
  return desiredStep.planningPowerW > selectedStep.planningPowerW
    && allowsSteppedLoadKeepInvariantRestore(dev.reason);
}

export function hasEquivalentSteppedLoadCommandHold(
  dev: DevicePlan['devices'][number],
  desiredStepId: string,
): boolean {
  const lastDesiredStepId = dev.lastDesiredStepId ?? dev.desiredStepId;
  const sameCommand = lastDesiredStepId === desiredStepId;
  if (!sameCommand) return false;
  if (dev.stepCommandPending === true) return true;
  return dev.stepCommandStatus === 'stale'
    && typeof dev.nextStepCommandRetryAtMs === 'number'
    && Date.now() < dev.nextStepCommandRetryAtMs;
}

export function resolveFlowBackedBinaryTriggerCardId(
  capabilityId: 'onoff' | 'evcharger_charging',
  desired: boolean,
): string {
  if (capabilityId === 'evcharger_charging') {
    return desired
      ? 'flow_backed_device_start_charging_requested'
      : 'flow_backed_device_stop_charging_requested';
  }
  return desired
    ? 'flow_backed_device_turn_on_requested'
    : 'flow_backed_device_turn_off_requested';
}

export function isRestoreHoldReason(reason: DeviceReason | undefined): boolean {
  return reason ? isRestoreAdmissionHoldReason(reason) : false;
}
