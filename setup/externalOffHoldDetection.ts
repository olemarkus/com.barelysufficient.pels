/**
 * Detection seam for "Leave off until turned on again": decides whether an
 * observed binary change was an outside-off action PELS must respect, or its
 * release.
 *
 * WHY HERE. This runs at the realtime-reconcile gate, immediately before PELS
 * would otherwise queue the reconcile that turns the device back on. That is the
 * one point where every required fact is available at once — the observed state,
 * the plan's expectation, the observed transition, and the owning home's pending
 * commands — and it covers both push ingest routes (`realtime_capability` and
 * `device_update` each dispatch through `plan_reconcile`).
 *
 * A HOLD NEEDS A TRANSITION, NOT A LEVEL. The single most dangerous mistake here
 * is reading "device is off while the plan says keep" as a user action: that is
 * ALSO what PELS failing to turn a device ON looks like. A slow device (cloud,
 * Zigbee, flow-backed) that takes longer than the 5 s settle window to confirm a
 * restore emits exactly that shape, so a level-based test fabricates a hold on
 * the first shed/restore cycle and strands the device. `startHold` therefore
 * requires an observed ON→OFF transition on the control capability, which PELS's
 * unconfirmed ON can never produce.
 *
 * PROVENANCE. Three mechanisms answer "was this OFF ours?", and two have already
 * run upstream by the time an event arrives here:
 *  1. The 5 s local-write echo map — a matching echo makes the transport DROP the
 *     event outright, so it never reaches us.
 *  2. The 5 s binary settle window — a `settled` outcome emits no reconcile.
 *  3. The pending-command store — the only signal that survives to this point,
 *     and the only one covering a late echo and flow-backed control (which never
 *     calls `setCapability`, so it populates neither of the first two). It is
 *     consulted for a pending command in EITHER direction: mid-command is
 *     mid-command, and a pending ON is precisely the slow-restore case above.
 *
 * PROVENANCE-FREE CONSUMPTION. The eligibility gates read only producer-resolved
 * flat bits off `PlanInputDevice` (`controllable`, `commandableNow`, `currentOn`)
 * — never a raw plug-state string or an evidence source. `commandableNow` is what
 * makes the EV rule exact: it is true only for `plugged_in_paused` and
 * `plugged_in_charging`, so pairing it with `currentOn === false` isolates
 * "connected and explicitly paused" and excludes unplugged, discharging,
 * unknown-state, and unavailable devices in one read.
 *
 * RELEASE IS THE SAFE DIRECTION and is deliberately looser than detection: it
 * needs no transition, no opt-in, and no provenance. `releaseExternalOffHoldsForObservedOn`
 * additionally sweeps the pull path, so a hold cannot outlive a device that is
 * observably running just because its ON arrived while the live feed was down.
 */

import { isBinaryPlanDevice } from '../lib/plan/planBinaryDevice';
import { PLAN_REASON_CODES } from '../packages/shared-domain/src/planReasonSemantics';
import type { ExternalOffHoldPolicy } from '../lib/observer/externalOffHold';
import type { DevicePlan, PlanInputDevice } from '../lib/plan/planTypes';
import type { StructuredDebugEmitter } from '../lib/logging/logger';

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
  previousValue?: string;
  nextValue?: string;
};

/**
 * Per-home seams the reconcile wrapper binds for the device's OWNING home.
 * Both are wrong if taken from main for a sub-home device: its pending commands
 * live in its own engine, and its plan lives in its own service.
 */
export type ExternalOffHoldReconcileHooks = {
  hasPendingBinaryCommand: (deviceId: string, capabilityId: string) => boolean;
  rebuild: (reason: string) => Promise<unknown>;
  isDryRun: () => boolean;
};

export type ExternalOffHoldSyncDeps = {
  policy: ExternalOffHoldPolicy | undefined;
  /**
   * Pending-command lookup for the device's OWNING home. Main and each sub-home
   * keep their own store, so asking main's about a sub-home device would report
   * "no pending command" for PELS's own write and fabricate a hold.
   */
  hasPendingBinaryCommand: (deviceId: string, capabilityId: string) => boolean;
  /** Simulation mode never actuates, so devices legitimately sit off while the
   *  plan says keep. Writing runtime state there would leave the user with
   *  silently unmanaged devices once they switch simulation off. */
  isDryRun: () => boolean;
  nowMs: number;
  debugStructured?: StructuredDebugEmitter;
};

/**
 * The plan expected this device to be running. `keep` is the only planned state
 * meaning "PELS wants this on"; `shed` and `inactive` mean PELS already put it
 * (or left it) off, which the spec excludes from starting a hold.
 *
 * A missing plan snapshot returns `false` on purpose: with no expectation there is
 * no contradiction to detect, and guessing from an ambiguous cold-start off state
 * is exactly what v1 must not do.
 */
function planExpectedDeviceOn(plan: DevicePlan | null, deviceId: string): boolean {
  if (!plan) return false;
  const planned = plan.devices.find((device) => device.id === deviceId);
  if (!planned) return false;
  if (planned.plannedState === 'keep') return true;
  // A plan still carrying THIS feature's own inactive posture is the plan from
  // before the release, not a decision to leave the device off: releasing a hold
  // schedules the rebuild asynchronously, so a user who turns the device off
  // again during that window (or after a failed rebuild) would otherwise be read
  // as "PELS already planned it off" — no new hold, and the rebuild that lands a
  // moment later commands the explicitly-off device back on. The pre-hold
  // expectation was ON, so it stays ON until a rebuild says otherwise.
  return planned.plannedState === 'inactive'
    && planned.reason?.code === PLAN_REASON_CODES.externalOffHold;
}

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

/**
 * Every precondition for CREATING a hold. Split out from the sync entry point so
 * the release path stays visibly unconditional above it — release must never
 * acquire a gate, or a missed release strands the device.
 */
function shouldStartHold(params: {
  deps: ExternalOffHoldSyncDeps;
  device: PlanInputDevice & { currentOn: boolean };
  deviceId: string;
  capabilityId: string;
  latestPlanSnapshot: DevicePlan | null;
  changes: readonly ObservedBinaryChange[] | undefined;
}): boolean {
  const {
    deps, device, deviceId, capabilityId, latestPlanSnapshot, changes,
  } = params;
  if (!sawOnToOffTransition(changes, capabilityId)) return false;
  if (deps.policy?.isEnabledForDevice(deviceId) !== true) return false;
  // Power-limit control off is the OTHER opt-out; PELS has no control authority
  // there, so an off state is not an override of anything.
  if (device.controllable !== true) return false;
  // Producer-resolved: excludes unavailable devices, and for an EV excludes
  // unplugged / discharging / not-resumable / unknown plug state.
  if (device.commandableNow !== true) return false;
  if (!planExpectedDeviceOn(latestPlanSnapshot, deviceId)) return false;
  if (deps.hasPendingBinaryCommand(deviceId, capabilityId)) return false;
  return !deps.isDryRun();
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
  liveDevices: PlanInputDevice[];
  latestPlanSnapshot: DevicePlan | null;
  changes?: readonly ObservedBinaryChange[];
}): ExternalOffHoldSyncOutcome {
  const {
    deps, deviceId, liveDevices, latestPlanSnapshot, changes,
  } = params;
  const { policy } = deps;
  if (!policy) return 'none';

  const device = liveDevices.find((entry) => entry.id === deviceId);
  if (!device) return 'none';
  // v1 is binary-capability only. A step-only stepped load resolves its on/off
  // from the step axis, which is weaker evidence than a binary handle and would
  // let a step change read as a deliberate off action. Narrowing here is also
  // what makes `currentOn` readable — it lives on the binary cluster.
  if (!isBinaryPlanDevice(device)) return 'none';
  const { controlCapabilityId: capabilityId } = device;
  if (capabilityId === undefined) return 'none';

  if (device.currentOn) {
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
    deps, device, deviceId, capabilityId, latestPlanSnapshot, changes,
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
  device: { binaryControl?: { on?: boolean } } | undefined,
): boolean => device?.binaryControl?.on === true;

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
  debugStructured?: StructuredDebugEmitter;
}): string[] {
  const { policy, deviceIds, isObservedOn, debugStructured } = params;
  if (!policy) return [];
  const released = Array.from(new Set([...policy.heldDeviceIds(), ...deviceIds]))
    .filter((deviceId) => isObservedOn(deviceId))
    .filter((deviceId) => policy.clearHold(deviceId));
  for (const deviceId of released) {
    debugStructured?.({ event: 'external_off_hold_cleared', deviceId, cause: 'observed_on_sweep' });
  }
  return released;
}
