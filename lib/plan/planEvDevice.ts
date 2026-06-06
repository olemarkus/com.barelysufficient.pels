import { isEvDevice } from '../../packages/shared-domain/src/commandableNow';
import type { EvPlanInputKind, PlanInputDevice } from '../../packages/planner-types/src/planInputDevice';
import type { DevicePlanDevice, EvKind } from './planTypes';

/**
 * EV-variant type-guard for the plan device types (EV-variant slice of the
 * discriminated-types refactor).
 *
 * EV is ORTHOGONAL to the stepped axis: an EV charger can also be
 * stepped-controlled. So unlike `isSteppedLoadDevice` (which narrows to one
 * union member), this guard narrows by INTERSECTING the EV field cluster back
 * onto whatever the device already is — `isEvPlanDevice(steppedDevice)` yields
 * `SteppedPlanDevice & EvKind` (a stepped EV), which is sound.
 *
 * The runtime predicate is the same disjunction the browser-safe
 * `isEvDevice` boolean uses (`deviceClass === 'evcharger'` OR
 * `controlCapabilityId === 'evcharger_charging'`). A type-guard whose predicate
 * is a disjunction is fine: TS trusts the `is` annotation regardless of how the
 * boolean is computed. The runtime predicate is delegated to `isEvDevice` so
 * there is exactly one definition of "is this an EV device", and shared-domain
 * stays browser-safe (it never imports the plan device types — the narrowing
 * overloads live here, in the plan layer).
 *
 * Dedicated overloads narrow the two flat plan device types; the generic
 * overload preserves any structural caller's variable type and intersects it
 * with the matching EV cluster.
 */
export function isEvPlanDevice(device: DevicePlanDevice): device is DevicePlanDevice & EvKind;
export function isEvPlanDevice(device: PlanInputDevice): device is PlanInputDevice & EvPlanInputKind;
export function isEvPlanDevice<T extends { deviceClass?: string; controlCapabilityId?: string }>(
  device: T,
): device is T & (T extends PlanInputDevice ? EvPlanInputKind : EvKind);
export function isEvPlanDevice(
  device: { deviceClass?: string; controlCapabilityId?: string },
): boolean {
  return isEvDevice(device);
}
