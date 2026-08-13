/**
 * Detection seam for "Leave off until turned on again": decides whether an
 * observed binary change was an outside-off action PELS must respect, or its
 * release.
 *
 * WHY HERE. This runs at the realtime-reconcile gate, immediately before PELS
 * would otherwise queue a reconcile from the stale plan. That is the
 * one point where every required fact is available at once — the observed state,
 * the observed transition, and the owning home's pending commands — and it
 * covers both push ingest routes (`realtime_capability` and
 * `device_update` each dispatch through `plan_reconcile`).
 *
 * A HOLD NEEDS A TRANSITION, NOT A LEVEL. The single most dangerous mistake here
 * is reading "device is off while the plan says keep" as a user action: that is
 * ALSO what PELS failing to turn a device ON looks like. A slow device (cloud,
 * Zigbee, flow-backed) that takes longer than its command-confirmation window to confirm a
 * restore emits exactly that shape, so a level-based test fabricates a hold on
 * the first shed/restore cycle and strands the device. `startHold` therefore
 * requires an observed ON→OFF transition on the control capability, which PELS's
 * unconfirmed ON can never produce.
 *
 * PROVENANCE. The observer-owned pending-command store answers "was this OFF
 * ours?" for native and Flow-backed control alike. It is consulted for a
 * pending command in EITHER direction: mid-command is mid-command, and a
 * pending ON is precisely the slow-restore case above. A recently confirmed
 * OFF remains attributable briefly so duplicate/reordered observations cannot
 * be mistaken for a user action.
 *
 * PLAN-INDEPENDENT. A genuine outside OFF starts the hold regardless of whether
 * the current plan says keep, shed, or inactive, and regardless of availability,
 * control mode, or simulation. The only domain carve-out is an EV session
 * becoming unplugged/discharging: that can fold the observed control to OFF but
 * is not an explicit outside OFF action.
 *
 * RELEASE IS THE SAFE DIRECTION and is deliberately looser than detection: it
 * needs no transition, no opt-in, and no provenance. `releaseExternalOffHoldsForObservedOn`
 * additionally sweeps the pull path, so a hold cannot outlive a device that is
 * observably running just because its ON arrived while the live feed was down.
 */

import type { ExternalOffHoldPolicy } from '../lib/observer/externalOffHold';
import type { StructuredDebugEmitter } from '../lib/logging/logger';
import { isEvSessionInactive } from '../packages/shared-domain/src/evPlugState';
import { isEvObserved } from '../packages/shared-domain/src/evObservedState';
import type {
  EvObservedProbe,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';

/**
 * `started` — a hold was created; the caller must suppress this reconcile (it
 * would turn the device back on) and rebuild instead.
 * `cleared` — the device was turned on again; the caller must ALSO suppress,
 * because the stale plan still says inactive and reconciling it would command the
 * device straight back off. The rebuild re-plans it under current conditions.
 * `none` — nothing to do; the caller proceeds with its usual drift handling.
 */
export type ExternalOffHoldSyncOutcome = 'started' | 'cleared' | 'none';

/** One observed capability change, as carried on the reconcile event. */
export type ObservedBinaryChange = {
  capabilityId?: string;
  observedCapabilityId?: string;
  previousValue?: string;
  nextValue?: string;
};

/**
 * Narrow observer projection consumed by hold detection. It deliberately stays
 * outside `PlanInputDevice`: affirmative axis evidence and outside-action
 * provenance are observation concerns, and detection must also cover devices
 * filtered out of the current home's plan input.
 */
export type ExternalOffHoldObservedDevice = {
  id: string;
  binaryObservationCapabilityId?: string;
  binaryAxisOn: boolean;
  binaryAxisObservedAtMs?: number;
  evSessionInactive: boolean;
};

export function toExternalOffHoldObservedDevice(
  device: (TargetDeviceSnapshot & EvObservedProbe) | undefined,
): ExternalOffHoldObservedDevice | undefined {
  if (!device) return undefined;
  return {
    id: device.id,
    binaryObservationCapabilityId: device.binaryControlObservation?.capabilityId,
    binaryAxisOn: device.binaryControl?.on === true,
    binaryAxisObservedAtMs: device.binaryControlObservation?.observedAtMs,
    // The device's own session question, asked directly of the decided
    // plug-state — this seam wants only that bit, not a whole commandability
    // resolution it would then throw away.
    evSessionInactive: isEvObserved(device) && isEvSessionInactive(device.evChargingState),
  };
}

/**
 * Per-home seams the reconcile wrapper binds for the device's OWNING home.
 * Both are wrong if taken from main for a sub-home device: its pending commands
 * live in its own engine, and its rebuild belongs to its own service.
 */
export type ExternalOffHoldReconcileHooks = {
  hasPendingBinaryCommand: (deviceId: string) => boolean;
  clearRecentBinaryOffCommand: (deviceId: string) => void;
  rebuild: (reason: string) => Promise<unknown>;
};

export type ExternalOffHoldSyncDeps = {
  policy: ExternalOffHoldPolicy | undefined;
  /**
   * Pending-command lookup for the device's OWNING home. Main and each sub-home
   * keep their own store, so asking main's about a sub-home device would report
   * "no pending command" for PELS's own write and fabricate a hold.
   */
  hasPendingBinaryCommand: (deviceId: string) => boolean;
  clearRecentBinaryOffCommand: (deviceId: string) => void;
  debugStructured?: StructuredDebugEmitter;
};

/**
 * The observation carried a genuine ON→OFF transition on the control capability.
 * Both push routes stamp `previousValue`/`nextValue` via `formatBinaryState`
 * ('on' | 'off' | 'unknown'); an event without such a change — including the
 * binary settle-window timeout that fires while PELS is still trying to turn the
 * device ON — is not a user action.
 */
function sawOnToOffTransition(
  changes: readonly ObservedBinaryChange[] | undefined,
  capabilityId: string,
): boolean {
  return (changes ?? []).some((change) => (
    change.capabilityId === capabilityId
    && change.previousValue === 'on'
    && change.nextValue === 'off'
  ));
}

function sawRawControlOnToOffTransition(
  changes: readonly ObservedBinaryChange[] | undefined,
  capabilityId: string,
): boolean {
  return (changes ?? []).some((change) => (
    change.capabilityId === capabilityId
    && (change.observedCapabilityId ?? change.capabilityId) === capabilityId
    && change.previousValue === 'on'
    && change.nextValue === 'off'
  ));
}

function sawRawControlOffToOnTransition(
  changes: readonly ObservedBinaryChange[] | undefined,
  capabilityId: string,
): boolean {
  return (changes ?? []).some((change) => (
    change.capabilityId === capabilityId
    && (change.observedCapabilityId ?? change.capabilityId) === capabilityId
    && change.previousValue === 'off'
    && change.nextValue === 'on'
  ));
}

/**
 * Every precondition for CREATING a hold. Split out from the sync entry point so
 * the release path stays visibly unconditional above it — release must never
 * acquire a gate, or a missed release strands the device.
 */
function shouldStartHold(params: {
  deps: ExternalOffHoldSyncDeps;
  device: ExternalOffHoldObservedDevice;
  deviceId: string;
  capabilityId: string;
  changes: readonly ObservedBinaryChange[] | undefined;
}): boolean {
  const {
    deps, device, deviceId, capabilityId, changes,
  } = params;
  if (!sawOnToOffTransition(changes, capabilityId)) return false;
  if (deps.policy?.isEnabledForDevice(deviceId) !== true) return false;
  // A charger becoming unplugged or entering discharge also folds its binary
  // control to OFF, but that is a session-state transition rather than an
  // external request to leave the charger off after reconnect. All other device
  // availability, planning, and control postures are deliberately irrelevant.
  if (
    device.evSessionInactive === true
    && !sawRawControlOnToOffTransition(changes, capabilityId)
  ) return false;
  return !deps.hasPendingBinaryCommand(deviceId);
}

/**
 * Starts or releases the external-off hold for one device.
 *
 * Ordering matters: the release check runs before every eligibility gate, so
 * turning the device on always hands control back — even if the opt-in was
 * switched off, the device went unavailable, or Power-limit control was disabled
 * while the hold was active.
 */
export function syncExternalOffHoldForDevice(params: {
  deps: ExternalOffHoldSyncDeps;
  deviceId: string;
  observedDevice: ExternalOffHoldObservedDevice | undefined;
  changes?: readonly ObservedBinaryChange[];
}): ExternalOffHoldSyncOutcome {
  const {
    deps, deviceId, observedDevice: device, changes,
  } = params;
  const { policy } = deps;
  if (!policy) return 'none';

  if (!device || device.id !== deviceId) return 'none';
  // v1 is binary-capability only. A step-only stepped load has no affirmative
  // binary-axis evidence, so a step change must not read as an outside OFF.
  const { binaryObservationCapabilityId: capabilityId } = device;
  if (capabilityId === undefined) return 'none';

  if (device.binaryAxisOn) {
    // An affirmative outside ON ends both the hold and the older PELS-OFF
    // attribution. The level alone may be the stale pre-OFF observation, so
    // provenance clears only on an explicit raw-axis OFF→ON action; the pull
    // sweep has its own timestamp comparison.
    if (sawRawControlOffToOnTransition(changes, capabilityId)) {
      deps.clearRecentBinaryOffCommand(deviceId);
    }
    if (!policy.isHeld(deviceId)) return 'none';
    policy.clearHold(deviceId);
    deps.debugStructured?.({
      event: 'external_off_hold_cleared', deviceId, capabilityId, cause: 'observed_on',
    });
    return 'cleared';
  }

  // Note the ordering: the device is off, and we go straight to the start gates
  // WITHOUT first asking `isHeld`. While the persisted state is unavailable
  // `isHeld` answers a fail-closed guess for every opted-in device, and gating on
  // it would swallow a genuine ON→OFF transition arriving in that window — the
  // guess then evaporates when the read recovers and the device is resumed. The
  // gates make the short-circuit unnecessary anyway: a duplicate off observation
  // carries no ON→OFF transition, and `startHold` is itself idempotent, so an
  // already-recorded hold reports `none` and triggers no write and no rebuild.
  if (!shouldStartHold({
    deps, device, deviceId, capabilityId, changes,
  })) return 'none';
  if (!policy.startHold(deviceId)) return 'none';

  deps.debugStructured?.({ event: 'external_off_hold_started', deviceId, capabilityId });
  return 'started';
}

/**
 * Pull-path release sweep: drops any hold whose device is currently observed ON.
 *
 * Detection is push-only (a full snapshot refresh never dispatches
 * `plan_reconcile`), and that is the safe direction for STARTING a hold. Release
 * is the opposite: if the ON that should have released a hold arrives while the
 * live feed is down — or is swallowed because a pull already wrote `on: true`, so
 * the realtime event carries no change — the hold would survive on a running
 * device and strand it at the next capacity shed, under a reason line that reads
 * like the feature working. Sweeping every plan cycle closes that. O(holds), which
 * is zero for everyone who has not opted in.
 */
/**
 * Affirmative ON evidence for RELEASING a hold.
 *
 * Deliberately not `resolveCurrentOn`, which answers the weaker "not known to be
 * off" and therefore reads absent binary state as ON. A partial device update
 * that transiently drops the capability would then release a hold nobody
 * touched, and PELS would resume the device once the capability returned.
 * Starting a hold may lean on inference; ending one may not.
 */
export const isAffirmativelyOn = (
  device: {
    binaryControl?: { on?: boolean };
    evCharging?: boolean;
    evChargingState?: unknown;
  } | undefined,
): boolean => (
  device?.evChargingState !== undefined
    ? device.evCharging === true
    : device?.binaryControl?.on === true
);

export function releaseExternalOffHoldsForObservedOn(params: {
  policy: ExternalOffHoldPolicy | undefined;
  /**
   * Every device this home is about to plan. Swept ALONGSIDE the recorded holds
   * rather than instead of them: while the persisted state cannot be read the
   * store has no ids to enumerate, so a hold released in that window would leave
   * no trace and the recovered read would revive it — on a device PELS may have
   * legitimately limited by then, which the observed-ON sweep can no longer
   * reach. "Observed ON ⇒ not held" is true regardless of what we can read, and
   * clearing an absent hold is a no-op.
   */
  deviceIds: readonly string[];
  isObservedOn: (deviceId: string) => boolean;
  onObservedOn?: (deviceId: string) => void;
  debugStructured?: StructuredDebugEmitter;
}): string[] {
  const {
    policy, deviceIds, isObservedOn, onObservedOn, debugStructured,
  } = params;
  if (!policy) return [];
  const observedOn = Array.from(new Set([...policy.heldDeviceIds(), ...deviceIds]))
    .filter((deviceId) => isObservedOn(deviceId));
  for (const deviceId of observedOn) onObservedOn?.(deviceId);
  const released = observedOn.filter((deviceId) => policy.clearHold(deviceId));
  for (const deviceId of released) {
    debugStructured?.({ event: 'external_off_hold_cleared', deviceId, cause: 'observed_on_sweep' });
  }
  return released;
}
