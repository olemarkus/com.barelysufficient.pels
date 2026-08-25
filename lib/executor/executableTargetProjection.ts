import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { isRestoreAdmissionHoldReason } from '../planContract/planDecisionSemantics';
import { isTemperaturePlanDevice } from '../plan/planTemperatureDevice';
import type { DevicePlan } from '../plan/planTypes';
import type {
  ExecutableObservedDeviceState,
  ExecutableTargetCommand,
  ExecutableTargetIntent,
  ExecutableTargetUpdate,
} from './executablePlan';

type PlanDevice = DevicePlan['devices'][number];

export function buildExecutableTargetIntent(dev: PlanDevice): ExecutableTargetIntent | undefined {
  if (!isTemperaturePlanDevice(dev)) return undefined;
  if (dev.reason?.code === PLAN_REASON_CODES.swapPending && dev.reason.targetName === null) return undefined;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return undefined;
  const intent: ExecutableTargetIntent = {
    deviceId: dev.id,
    name: dev.name,
    desired: dev.plannedTarget,
    communicationModel: dev.communicationModel,
    // `shed_temperature` when the setpoint the plan wants written IS this
    // device's shed end state, rather than an ordinary target update.
    purpose: dev.plannedShedTargetKind === 'target_value'
      ? 'shed_temperature'
      : 'target_update',
    recordRestoreOnTargetApply: dev.recordRestoreOnTargetApply,
  };
  return intent;
}

export function buildExecutableTargetUpdate(
  intent: ExecutableTargetIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
): ExecutableTargetUpdate | null {
  if (!intent) return null;
  const command = buildExecutableTargetCommand(intent, observed);
  if (!command) return null;
  if (Object.is(command.observedValue, command.desired)) return null;

  return {
    ...command,
    // Planner-resolved, raise-guarded in the diff domain the executor owns:
    // the plan's verdict is frozen at build time, so if the observation moved
    // ABOVE the desired value before apply, this write LOWERS the setpoint —
    // advancing the restore clocks for it would delay legitimate restores by
    // the backoff. The guard compares only desired vs observed (no config,
    // no policy — the owner ruling stands); why the write is a restore was
    // decided where the setpoint was chosen.
    isRestoring: intent.recordRestoreOnTargetApply
      && typeof command.observedValue === 'number'
      && command.desired > command.observedValue,
  };
}

export function buildExecutableTargetCommand(
  intent: ExecutableTargetIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
): ExecutableTargetCommand | null {
  if (!intent || !observed?.target) return null;
  return {
    deviceId: intent.deviceId,
    name: intent.name,
    target: 'temperature',
    desired: intent.desired,
    observedValue: observed.target.observedValue,
    communicationModel: intent.communicationModel,
  };
}
