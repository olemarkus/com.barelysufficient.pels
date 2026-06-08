import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import type { PlanInputDevice, TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';
import type { DevicePlanDevice, TemperatureKind } from './planTypes';

/**
 * Temperature-variant type-guard for the plan device types (temperature-variant
 * slice of the discriminated-types refactor).
 *
 * Temperature is ORTHOGONAL to the stepped axis: an air-treatment unit can also
 * be stepped-controlled. So, like `isEvPlanDevice` (and unlike
 * `isSteppedLoadDevice`, which narrows to one union member), this guard narrows
 * by INTERSECTING the temperature field cluster back onto whatever the device
 * already is — `isTemperaturePlanDevice(steppedDevice)` yields
 * `SteppedPlanDevice & TemperatureKind`, which is sound.
 *
 * The runtime predicate is the browser-safe `isTemperatureControlDevice`
 * boolean (`deviceType === 'temperature'`). Delegating keeps exactly one
 * definition of "is this a temperature device", and shared-domain stays
 * browser-safe (it never imports the plan device types — the narrowing overloads
 * live here, in the plan layer). The producer stamps `deviceType` flat on both
 * the input and output plan devices (mirroring how `deviceClass` rides on both
 * for the EV guard), so the predicate reads identically on either flat type.
 *
 * Dedicated overloads narrow the two flat plan device types; the generic
 * overload preserves any structural caller's variable type and intersects it
 * with the matching temperature cluster.
 */
export function isTemperaturePlanDevice(device: DevicePlanDevice): device is DevicePlanDevice & TemperatureKind;
export function isTemperaturePlanDevice(device: PlanInputDevice): device is PlanInputDevice & TemperaturePlanInputKind;
export function isTemperaturePlanDevice<T extends { deviceType?: string }>(
  device: T,
): device is T & (T extends PlanInputDevice ? TemperaturePlanInputKind : TemperatureKind);
export function isTemperaturePlanDevice(
  device: { deviceType?: string },
): boolean {
  return isTemperatureControlDevice(device);
}
