import type { PlanInputDevice } from '../planTypes';
import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';

/** A physical/owner power-range conflict stays off, including during smart tasks. */
export function isOperatingPowerHeldDevice(device: PlanInputDevice): boolean {
  return device.operatingPowerRange === 'below_minimum' && device.control.managed && device.control.commandAuthority;
}

export function resolveOperatingPowerHold(devices: readonly PlanInputDevice[]): {
  holdIds: Set<string>; reasonById: Map<string, DeviceReason>;
} {
  const held = devices.filter(isOperatingPowerHeldDevice);
  return {
    holdIds: new Set(held.map((device) => device.id)),
    reasonById: new Map(held.map((device) => [device.id, { code: PLAN_REASON_CODES.powerLimitBelowMinimum }])),
  };
}

export function isOperatingPowerHoldShed(device: PlanInputDevice, reasons: ReadonlyMap<string, DeviceReason>): boolean {
  if (!isOperatingPowerHeldDevice(device)) return false;
  const reason = reasons.get(device.id);
  return reason === undefined || reason.code === PLAN_REASON_CODES.powerLimitBelowMinimum;
}
