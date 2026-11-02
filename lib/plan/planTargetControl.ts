import type { WantedTargetCommand } from '../ports/pendingTargetCommand';
import type { PendingTargetCommandState, PlanEngineState } from './planState';
import type {
  DevicePlan,
  DevicePlanDevice,
  PendingTargetCommandSummary,
} from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';

/**
 * Whether the plan still wants the target a pending command is writing: a
 * temperature device whose planned target moves it and is the value the
 * command is waiting to see. One answer for the three readers that keep,
 * expose, or attribute the pending command.
 */
export function planStillWantsPendingTarget(
  device: DevicePlanDevice,
  pending: PendingTargetCommandState,
): boolean {
  return isTemperaturePlanDevice(device)
    && device.plannedTarget !== device.currentTarget
    && device.plannedTarget === pending.desired;
}

/** Desired setpoint changes cancel ordinary retries; lifecycle commands have their own store. */
export function resolveWantedPendingTargetCommands(plan: DevicePlan): ReadonlyMap<string, WantedTargetCommand> {
  return new Map(plan.devices.map((device): [string, WantedTargetCommand] => [
    device.id,
    isTemperaturePlanDevice(device) && device.plannedTarget !== device.currentTarget
      && typeof device.plannedTarget === 'number'
      ? { kind: 'target', desired: device.plannedTarget, name: device.name }
      : { kind: 'none', name: device.name },
  ]));
}

export function decoratePlanWithPendingTargetCommands(
  state: PlanEngineState,
  plan: DevicePlan,
): DevicePlan {
  const devices = plan.devices.map((device) => {
    const pending = state.pendingTargetCommands[device.id];
    if (!pending || !planStillWantsPendingTarget(device, pending)) {
      if (!device.pendingTargetCommand) return device;
      return {
        ...device,
        pendingTargetCommand: undefined,
      };
    }
    const summary: PendingTargetCommandSummary = {
      desired: pending.desired,
      retryCount: pending.retryCount,
      nextRetryAtMs: pending.nextRetryAtMs,
      status: pending.status,
      lastObservedValue: pending.lastObservedValue,
      lastObservedSource: pending.lastObservedSource,
    };
    return {
      ...device,
      pendingTargetCommand: summary,
    };
  });

  return {
    ...plan,
    devices,
  };
}

