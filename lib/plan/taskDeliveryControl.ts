import { isRestoreAdmissionHoldReason } from '../planContract/planDecisionSemantics';
import type { TaskDeliveryControl } from '../../packages/contracts/src/taskDelivery';
import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import type { DevicePlanDevice } from './planTypes';

const RESTRICTIONS: Record<DevicePlanDevice['reason']['code'], TaskDeliveryControl> = {
  daily_budget: { kind: 'restricted', cause: 'budget_limited' },
  capacity: { kind: 'restricted', cause: 'capacity_limited' },
  shortfall: { kind: 'restricted', cause: 'capacity_limited' },
  hourly_budget: { kind: 'restricted', cause: 'capacity_limited' },
  insufficient_headroom: { kind: 'restricted', cause: 'capacity_limited' },
  reserved_for_start: { kind: 'restricted', cause: 'priority_limited' },
  swap_pending: { kind: 'restricted', cause: 'priority_limited' },
  swapped_out: { kind: 'restricted', cause: 'priority_limited' },
  activation_backoff: { kind: 'failed' },
  cooldown_shedding: { kind: 'pending' },
  cooldown_restore: { kind: 'pending' },
  meter_settling: { kind: 'pending' },
  restore_pending: { kind: 'pending' },
  restore_throttled: { kind: 'pending' },
  waiting_for_other_devices: { kind: 'pending' },
  startup_stabilization: { kind: 'pending' },
  neutral_startup_hold: { kind: 'pending' },
  shed_invariant: { kind: 'pending' },
  external_off_hold: { kind: 'uncontrolled' },
  awaiting_solar_surplus: { kind: 'uncontrolled' },
  awaiting_pels_start: { kind: 'uncontrolled' },
  deferred_objective_avoid: { kind: 'uncontrolled' },
  inactive: { kind: 'no_decision' },
  keep: { kind: 'permitted' },
  restore_need: { kind: 'permitted' },
  capacity_control_off: { kind: 'permitted' },
};

const isRunningThroughRestoreHold = (
  device: DevicePlanDevice,
  execution: DeviceExecutionState,
): boolean => device.plannedState === 'keep'
  && execution.physicalState === 'on'
  && execution.desiredBinary !== 'off'
  && isRestoreAdmissionHoldReason(device.reason);

/** The decision owner explains imposed ceilings even when a device remains on. */
export const resolveTaskDeliveryControl = (
  device: DevicePlanDevice,
  execution: DeviceExecutionState,
): TaskDeliveryControl => {
  if (execution.externalOffHeld || !device.control.commandAuthority) return { kind: 'uncontrolled' };
  if (!execution.available) return { kind: 'failed' };
  const axes = [execution.binaryProgress, execution.stepProgress, execution.targetProgress];
  if (axes.includes('pending')) return { kind: 'pending' };
  if (axes.includes('unmet')) return { kind: 'failed' };
  if (axes.includes('unobserved')) return { kind: 'pending' };
  const restriction = RESTRICTIONS[device.reason.code];
  // Restore admission can wait for the house meter while this device remains
  // on. The hold suppresses new intents; it does not interrupt delivery already
  // permitted by the kept posture. Actual axis transitions still win above.
  if (restriction.kind === 'pending' && isRunningThroughRestoreHold(device, execution)) {
    return { kind: 'permitted' };
  }
  if (restriction.kind !== 'permitted') return restriction;
  if (execution.desiredBinary === 'off') return { kind: 'uncontrolled' };
  if (axes.every((axis) => axis === 'undriven')) return { kind: 'uncontrolled' };
  return { kind: 'permitted' };
};
