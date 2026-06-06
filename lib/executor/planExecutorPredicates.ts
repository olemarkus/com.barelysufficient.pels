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
import { isCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveBinaryShedReasonCode } from './lifecycleReleaseRecording';

export function resolveConfirmedBinaryCommandReasonCode(
  pending: PlanEngineState['pendingBinaryCommands'][string],
): string {
  if (!pending.desired) {
    return resolveBinaryShedReasonCode(pending.reason, pending.lifecycleRelease);
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
    && Boolean(state.shedDecidedMs[dev.id]);
}

/**
 * Restore-log source label: `shed_state` when the planner still holds the
 * device in capacity-shed posture (decided-shed more recently than it was
 * restored), else `current_plan`. Reads the decision-time `shedDecidedMs`
 * clock so a write-skipped shed is still attributed to the shed state. The
 * result is a log field only — no decision branches on it.
 */
export function resolveRestoreLogSource(
  state: PlanEngineState,
  deviceId: string,
): 'shed_state' | 'current_plan' {
  const shedDecidedMs = state.shedDecidedMs[deviceId];
  if (!shedDecidedMs) return 'current_plan';
  const lastRestoreMs = state.lastDeviceRestoreMs[deviceId];
  return !lastRestoreMs || lastRestoreMs < shedDecidedMs ? 'shed_state' : 'current_plan';
}

export function hasStableBinaryReleaseActuation(dev: DevicePlan['devices'][number]): boolean {
  if (dev.binaryCommandPending === true) return false;
  if (dev.deferredReleaseIntent === 'binary_restore') {
    // Released = off-but-commandable, the only state a restore acts on.
    return dev.binaryControl?.on === false && isCommandableNow(dev);
  }
  if (dev.deferredReleaseIntent === 'binary_release') {
    // On (the consolidated binary truth).
    return dev.binaryControl?.on ?? true;
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
  if (!isSteppedLoadDevice(dev) || dev.plannedState !== 'keep') return false;
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
