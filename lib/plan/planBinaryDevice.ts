import type { BinaryPlanInputKind, PlanInputDevice } from '../../packages/planner-types/src/planInputDevice';
import type { DevicePlanDevice, BinaryControlKind } from './planTypes';

/**
 * Binary-control type-guard for the plan device types (binary-variant slice of
 * the discriminated-types refactor).
 *
 * Binary control is ORTHOGONAL to the stepped axis (a stepped device also has an
 * onoff control). So unlike `isSteppedLoadDevice` (which narrows to one union
 * member), this guard narrows by INTERSECTING the binary cluster back onto
 * whatever the device already is — `isBinaryPlanDevice(steppedDevice)` yields
 * `SteppedPlanDevice & BinaryControlKind` (a stepped binary device), which is
 * sound. Dedicated overloads narrow the output `DevicePlanDevice` and the input
 * `PlanInputDevice`; the generic overload preserves a structural caller's type.
 *
 * The runtime predicate is `controlCapabilityId !== undefined`: capability
 * presence is the source of truth for binary status. A device whose control
 * capability is absent THIS cycle (e.g. a transient capability drop) is NOT a
 * binary device this cycle — the guard returns false and the binary cluster is
 * unreachable. This pairs with `withBinaryDiscriminant` in `planTypes.ts`, which
 * omits the cluster on the same predicate, so the guard never asserts a field the
 * producer did not attach.
 */
export function isBinaryPlanDevice(device: DevicePlanDevice): device is DevicePlanDevice & BinaryControlKind;
export function isBinaryPlanDevice(device: PlanInputDevice): device is PlanInputDevice & BinaryPlanInputKind;
export function isBinaryPlanDevice<T extends { controlCapabilityId?: string }>(
  device: T,
): device is T & (T extends PlanInputDevice ? BinaryPlanInputKind : BinaryControlKind);
export function isBinaryPlanDevice(device: { controlCapabilityId?: string }): boolean {
  return device.controlCapabilityId !== undefined;
}
