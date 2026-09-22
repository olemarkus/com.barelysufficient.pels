import type { MeteredPlanInputKind, PlanInputDevice } from '../../packages/planner-types/src/planInputDevice';
import type { DevicePlanDevice, MeteredKind } from './planTypes';

/**
 * Power-axis type-guard for the plan device types.
 *
 * A device has a power axis in the plan when it has a real per-device power
 * reading this cycle. Only such a device can be limited for power, counted in
 * managed usage, or priced as denied demand; the power-limiting logic reaches
 * `currentDrawKw` only through this guard, so a temperature device planned
 * without a reading (mode targets and the price shift still apply) can never
 * reach it. See `MeteredPlanInputKind` for the full contract.
 *
 * Like `isBinaryPlanDevice`, the power axis is ORTHOGONAL to the stepped axis,
 * so this narrows by INTERSECTING the cluster onto whatever the device already
 * is. The runtime predicate is key presence with a number, which is what the
 * producer (`toPlanDevice`) and the regrouper (`withMeteredDiscriminant`) key
 * on, so the guard never asserts a field the producer did not attach.
 */
export function isMeteredPlanDevice(device: DevicePlanDevice): device is DevicePlanDevice & MeteredKind;
export function isMeteredPlanDevice(device: PlanInputDevice): device is PlanInputDevice & MeteredPlanInputKind;
export function isMeteredPlanDevice<T extends object>(
  device: T,
): device is T & (T extends PlanInputDevice ? MeteredPlanInputKind : MeteredKind);
export function isMeteredPlanDevice(device: object): boolean {
  return 'currentDrawKw' in device && typeof device.currentDrawKw === 'number';
}
