import type { MeteredPlanInputKind } from '../../packages/planner-types/src/planInputDevice';

/**
 * Power-axis type-guard for the plan device types.
 *
 * A device has a power axis in the plan when it has a real per-device power
 * reading this cycle. Only such a device can be limited for power, counted in
 * managed usage, or priced as denied demand; the power-limiting logic reaches
 * `currentDrawKw` only through this guard. Plan-device admission drops every
 * device without a reading, including temperature devices, before the planner
 * receives its inputs. See `MeteredPlanInputKind` for the full contract.
 *
 * Like `isBinaryPlanDevice`, the power axis is ORTHOGONAL to the stepped axis,
 * so this narrows by INTERSECTING the cluster onto whatever the device already
 * is. The runtime predicate is key presence with a number, which is what the
 * producer (`toPlanDevice`) and the regrouper (`withMeteredDiscriminant`) key
 * on, so the guard never asserts a field the producer did not attach.
 */
export function isMeteredPlanDevice<T extends object>(
  device: T,
): device is T & MeteredPlanInputKind;
export function isMeteredPlanDevice(device: object): boolean {
  return 'currentDrawKw' in device && typeof device.currentDrawKw === 'number';
}

/** The planner-owned admission set for consumers that persist planner-derived data. */
export function filterMeteredPlanDevices<T extends object>(
  devices: readonly T[],
): Array<T & MeteredPlanInputKind> {
  return devices.filter(isMeteredPlanDevice);
}
