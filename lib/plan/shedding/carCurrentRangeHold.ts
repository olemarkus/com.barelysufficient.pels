import type { PlanInputDevice } from '../planTypes';
import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';

/** A car range with no usable charger level stays off; a smart task cannot lift it. */
export function isCarCurrentRangeHeldDevice(device: PlanInputDevice): boolean {
  return device.carCurrentRangeUnavailable === true && device.control.commandAuthority;
}

export function resolveCarCurrentRangeHold(devices: readonly PlanInputDevice[]): {
  holdIds: Set<string>;
  reasonById: Map<string, DeviceReason>;
} {
  const held = devices.filter(isCarCurrentRangeHeldDevice);
  return {
    holdIds: new Set(held.map((device) => device.id)),
    reasonById: new Map(held.map((device) => [device.id, { code: PLAN_REASON_CODES.carCurrentRangeUnavailable }])),
  };
}

/** A simultaneous capacity cut still counts as capacity pressure, but the end state remains off. */
export function isCarCurrentRangeHoldShed(
  device: PlanInputDevice,
  shedReasons: ReadonlyMap<string, DeviceReason>,
): boolean {
  if (!isCarCurrentRangeHeldDevice(device)) return false;
  const reason = shedReasons.get(device.id);
  return reason === undefined || reason.code === PLAN_REASON_CODES.carCurrentRangeUnavailable;
}
