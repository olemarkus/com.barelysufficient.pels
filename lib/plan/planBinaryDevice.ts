import type { DevicePlanDevice, BinaryControlKind } from './planTypes';

/**
 * Binary-control type-guard for the plan device types (binary-variant slice of
 * the discriminated-types refactor).
 *
 * Binary control is ORTHOGONAL to the stepped axis (a stepped device also has an
 * onoff control). So unlike `isSteppedLoadDevice` (which narrows to one union
 * member), this guard narrows by INTERSECTING `BinaryControlKind` back onto
 * whatever the device already is — `isBinaryPlanDevice(steppedDevice)` yields
 * `SteppedPlanDevice & BinaryControlKind` (a stepped binary device), which is
 * sound.
 *
 * The runtime predicate is `controlCapabilityId !== undefined`: capability
 * presence is the source of truth for binary status. A device whose control
 * capability is absent THIS cycle (e.g. a transient capability drop) is NOT a
 * binary device this cycle — the guard returns false and the binary cluster is
 * unreachable. This pairs with `withBinaryDiscriminant` in `planTypes.ts`, which
 * omits the cluster on the same predicate, so the guard never asserts a field the
 * producer did not attach.
 */
export function isBinaryPlanDevice(device: DevicePlanDevice): device is DevicePlanDevice & BinaryControlKind {
  return device.controlCapabilityId !== undefined;
}
