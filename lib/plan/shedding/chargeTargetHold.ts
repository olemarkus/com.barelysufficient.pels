import type { PlanInputDevice } from '../planTypes';
import type { HeldChargeTarget } from '../../../packages/planner-types/src/planInputDevice';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../../packages/shared-domain/src/planReasonSemantics';

/**
 * Standing hold for a charger's target battery level: "charge to N% and stop".
 *
 * The same shape as the start-policy hold (`./startPolicyHold.ts`), and read at
 * the same sites, for the same reasons; read that module's notes first. This one
 * records only where it differs.
 *
 * ## What decides the hold
 *
 * The producer resolves the setting, the observed level and the plug state into
 * `PlanInputDevice.chargeTargetHold` (`projectChargeTargetHold`,
 * `lib/planInput/chargeTargetHold.ts`), including the command-authority gate: a
 * charger PELS only watches resolves to `none`. Nothing here reads the setting
 * or the level.
 *
 * The hold is OFF, not the owner's power-limiting floor: a stepped charger parked
 * at its lowest current keeps charging past the target. The shed-behaviour
 * override in `planDevicesBase` turns it off through {@link isChargeTargetHeldDevice},
 * whatever else sheds it the same cycle.
 *
 * Correction lands at the next meter reading, as for every standing posture: a
 * level that crosses the target is a device observation, and an observation
 * never rebuilds the plan (`lib/plan/planRebuildTrigger.ts`).
 *
 * ## Only a driving smart task lifts it
 *
 * `PlanInputDevice.chargeTargetHoldLifted` is stamped by deferred admission on a
 * `planned` decision: the task booked this hour and may charge past the target.
 * `idle` and `inactive` decisions leave the hold in place. A task whose car has
 * no battery level is `inactive`, so it never lifts a hold that waits for one.
 *
 * ## Not capacity pressure
 *
 * Off because its owner set a target, not because the house is short of power:
 * it does not count toward the keep-invariant stepped clamp, is not
 * "recovering", and its reduction stamps no capacity clocks. A held charger is
 * at its target, so it is never starved either: starvation counts only a
 * `below_target` charger that capacity or budget keeps limited.
 *
 * Its two reasons are byte-stable: `chargeTargetReached` carries the owner's
 * target percent (configuration, which moves only when the owner edits it, and
 * a real transition when it does), `awaitingBatteryLevel` carries nothing.
 *
 * Where both this hold and the start policy hold a charger, this reason wins the
 * card: it says what the device needs, where the start policy's says nothing.
 */
export type ChargeTargetHoldResult = {
  holdIds: Set<string>;
  reasonById: Map<string, DeviceReason>;
};

export function resolveChargeTargetHold(
  devices: readonly PlanInputDevice[],
): ChargeTargetHoldResult {
  const holdIds = new Set<string>();
  const reasonById = new Map<string, DeviceReason>();
  for (const device of devices) {
    const held = resolveHeldChargeTarget(device);
    if (!held) continue;
    holdIds.add(device.id);
    reasonById.set(device.id, buildChargeTargetHoldReason(held));
  }
  return { holdIds, reasonById };
}

/**
 * The charge target holding this device off RIGHT NOW, or `null` when none
 * does. THE single definition: {@link resolveChargeTargetHold},
 * {@link isChargeTargetHeldDevice}, and the `chargeTargetHeld` stamp
 * `buildBasePlanDevice` puts on the plan device for the output-side reader
 * (`getInactiveReason`) all answer from it.
 *
 * Reads no control posture: the producer already resolved a device without
 * standing authority to `none`.
 */
// `chargeTargetHoldLifted` is read here and stamped in
// `applyDeferredAdmissionToInput` from its own `planned` test rather than through
// a shared predicate, for the reason recorded on `isStartPolicyHeldDevice`: the
// two backend readers cannot import each other (`no-objectives-to-peer`), and
// shared-domain needs a real browser consumer.
export function resolveHeldChargeTarget(device: PlanInputDevice): HeldChargeTarget | null {
  const hold = device.chargeTargetHold;
  if (device.chargeTargetHoldLifted === true) return null;
  return hold.kind === 'target_reached' || hold.kind === 'awaiting_level' ? hold : null;
}

/** Is this device held off by its charge target RIGHT NOW? See {@link resolveHeldChargeTarget}. */
export function isChargeTargetHeldDevice(device: PlanInputDevice): boolean {
  return resolveHeldChargeTarget(device) !== null;
}

/** The per-device reason a held charge target writes. */
export function buildChargeTargetHoldReason(held: HeldChargeTarget): DeviceReason {
  return held.kind === 'target_reached'
    ? { code: PLAN_REASON_CODES.chargeTargetReached, targetPercent: held.targetPercent }
    : { code: PLAN_REASON_CODES.awaitingBatteryLevel };
}

/** Is this reason one a charge target hold writes? */
function isChargeTargetHoldReason(reason: DeviceReason): boolean {
  return reason.code === PLAN_REASON_CODES.chargeTargetReached
    || reason.code === PLAN_REASON_CODES.awaitingBatteryLevel;
}

/**
 * Is THIS CYCLE's shed of this device its charge target hold, rather than
 * capacity pressure? The twin of `isStartPolicyHoldShed`, with the same "own
 * reason" arm for the silent-meter pass: a fresh capacity reason means real
 * pressure (it counts toward the stepped clamp); no fresh reason, or this hold's
 * own reason, means the hold. Whether it is turned off does not depend on this:
 * a held charger is always turned off (`resolveEffectiveShedBehavior`).
 */
export function isChargeTargetHoldShed(
  device: PlanInputDevice,
  shedReasons: ReadonlyMap<string, DeviceReason>,
): boolean {
  if (!isChargeTargetHeldDevice(device)) return false;
  const reason = shedReasons.get(device.id);
  return reason === undefined || isChargeTargetHoldReason(reason);
}
