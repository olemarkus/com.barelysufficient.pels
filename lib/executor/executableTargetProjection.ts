import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { isRestoreAdmissionHoldReason } from '../planContract/planDecisionSemantics';
import { isTemperaturePlanDevice } from '../plan/planTemperatureDevice';
import type { DevicePlan, ShedAction } from '../plan/planTypes';
import type {
  ExecutableObservedDeviceState,
  ExecutableTargetCommand,
  ExecutableTargetIntent,
  ExecutableTargetUpdate,
} from './executablePlan';

type PlanDevice = DevicePlan['devices'][number];

export function buildExecutableTargetIntent(dev: PlanDevice): ExecutableTargetIntent | null {
  const plannedTarget = isTemperaturePlanDevice(dev) ? dev.plannedTarget : undefined;
  if (typeof plannedTarget !== 'number') return null;
  if (dev.reason?.code === PLAN_REASON_CODES.swapPending && dev.reason.targetName === null) return null;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return null;
  return {
    deviceId: dev.id,
    name: dev.name,
    desired: plannedTarget,
    purpose: dev.plannedState === 'shed' && dev.shedAction === 'set_temperature'
      ? 'shed_temperature'
      : 'target_update',
  };
}

export function buildExecutableTargetUpdate(
  intent: ExecutableTargetIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null },
): ExecutableTargetUpdate | null {
  if (!intent) return null;
  const command = buildExecutableTargetCommand(intent, observed);
  if (!command) return null;
  if (Object.is(command.observedValue, command.desired)) return null;

  return {
    ...command,
    isRestoring: isTargetRestore({
      intent,
      observedValue: command.observedValue,
      getShedBehavior,
    }),
  };
}

export function buildExecutableTargetCommand(
  intent: ExecutableTargetIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
): ExecutableTargetCommand | null {
  if (!intent || !observed?.target) return null;
  return {
    deviceId: intent.deviceId,
    name: intent.name,
    targetCap: observed.target.targetCap,
    desired: intent.desired,
    observedValue: observed.target.observedValue,
  };
}

const isTargetRestore = (params: {
  intent: ExecutableTargetIntent;
  observedValue: unknown;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
}): boolean => {
  const { intent, observedValue, getShedBehavior } = params;
  if (typeof observedValue !== 'number') return false;
  const shedBehavior = getShedBehavior(intent.deviceId);
  return shedBehavior.action === 'set_temperature'
    && shedBehavior.temperature !== null
    && observedValue === shedBehavior.temperature
    && intent.desired > observedValue;
};
