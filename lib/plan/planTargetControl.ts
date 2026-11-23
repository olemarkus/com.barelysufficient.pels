import type { PendingTargetCommandRead, WantedTargetCommand } from '../ports/pendingTargetCommand';
import type { PlanEngineState } from './planState';
import type {
  DevicePlan,
  DevicePlanDevice,
  PendingTargetCommandSummary,
} from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';

/** The setpoint the plan moves a temperature device to; `undefined` when it moves none. */
function resolvePlanWantedTarget(device: DevicePlanDevice): number | undefined {
  return isTemperaturePlanDevice(device) && device.plannedTarget !== device.currentTarget
    && typeof device.plannedTarget === 'number'
    ? device.plannedTarget
    : undefined;
}

/**
 * Whether the plan still wants the target a pending command is writing: the
 * setpoint the plan moves the device to is the value the command is waiting to
 * see. One answer for the three readers that keep, expose, or attribute the
 * pending command.
 */
export function planStillWantsPendingTarget(
  device: DevicePlanDevice,
  pending: PendingTargetCommandRead,
): boolean {
  return resolvePlanWantedTarget(device) === pending.desired;
}

/**
 * Desired setpoint changes cancel ordinary retries; lifecycle commands have
 * their own store. A device the plan moves to no setpoint stays in the map with
 * its name, which the prune log names it by.
 */
export function resolveWantedPendingTargetCommands(plan: DevicePlan): ReadonlyMap<string, WantedTargetCommand> {
  return new Map(plan.devices.map((device): [string, WantedTargetCommand] => {
    const desired = resolvePlanWantedTarget(device);
    return [device.id, desired === undefined
      ? { kind: 'none', name: device.name }
      : { kind: 'target', desired, name: device.name }];
  }));
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

