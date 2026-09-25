import type { PlanInputDevice } from '../planTypes';
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';

/**
 * Is THIS CYCLE's shed of this device its smart task holding it off in a deferred
 * hour, rather than capacity pressure?
 *
 * The hold is decided by the task (`deferredHoldActive`, stamped by deferred
 * admission together with the device's `forceShedSet` membership). A fresh shed
 * decision (`shedReasons`) means capacity took the device down as well, and that
 * is real pressure: it keeps the owner's configured limiting floor and counts
 * toward the keep-invariant stepped clamp. A device shed with no fresh reason is
 * held by its task, and the task wants it off (owner ruling, 2026-09-25) — not
 * at the limiting floor, which still draws, and not as pressure that caps
 * unrelated stepped loads at their lowest step.
 *
 * The same shape as `isStartPolicyHoldShed` (`./startPolicyHold.ts`), for the
 * same reason: one definition read by the shed-behaviour override in
 * `planDevicesBase`, the keep-invariant exclusion in `planDevices`, and through
 * `nonCapacityHoldShed` the restore side and the executor.
 *
 * Unlike the start-policy predicate it has no "own reason" arm, so on the
 * silent-meter fail-closed pass (`planBuilderSilentMeter.ts`), which gives every
 * shed id its directive reason, a held device takes the owner's limiting floor
 * rather than OFF. That is the fail-closed directive winning for the outage, as
 * it did before this hold existed, and the device still sheds.
 */
export function isDeferredHoldShed(
  device: PlanInputDevice,
  shedReasons: ReadonlyMap<string, DeviceReason>,
): boolean {
  return device.deferredHoldActive === true && !shedReasons.has(device.id);
}
