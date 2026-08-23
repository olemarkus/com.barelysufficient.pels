import type { AppContext } from '../../lib/app/appContext';
import type { StarvationRescueDevice } from '../../packages/contracts/src/starvationRescue';
import { hasOpenDeferredObjective } from '../../lib/objectives/deferredObjectives';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';
import type { SmartTaskHomeScope } from '../../packages/contracts/src/smartTaskHomeScope';
import type { CreateSmartTaskCandidateDevicesRead } from '../../packages/contracts/src/widgetHostApi';
import { isRuntimePlannedDevice } from '../appDeviceSupport';
import type { ObjectiveDeviceExclusion } from '../../lib/objectives/deferredObjectives/deviceExclusion';

/**
 * Multi-home v1 scope predicate shared by EVERY smart-task surface: the app's
 * candidate list + create validation (`appSmartTaskApi.ts`), the device-scoped write op's
 * defence-in-depth gate (`buildDeferredObjectiveDeviceWriteDeps`), the
 * set-deadline flow-card autocompletes (`registerAppFlowCards`), and — negated
 * — the decoration controller's diagnostics honesty (`createPlanEngine`).
 *
 * Smart tasks are planned against the MAIN home's meter budget (hard cap,
 * daily-budget overlay, priority-ordered reservations), so a device in a
 * separate-meter sub-home is out of scope. This predicate deliberately answers
 * durable MEMBERSHIP only: provisional/global authority fences must not look
 * like relocation, because lifecycle consumers negate this result to diagnose
 * and disarm tasks that genuinely moved behind another meter.
 */
export const isSmartTaskDeviceInMainHome = (ctx: AppContext, deviceId: string): boolean => {
  const membership = ctx.homeMembership;
  // Unknown/provisional membership is NOT evidence of durable relocation.
  // Treat it as Main here so existing tasks remain intact; every new promise
  // and device write additionally requires `hasMainHomeSmartTaskAuthority`.
  if (
    membership?.isOwnershipReady() !== true
    || membership.hasPendingOwnershipGeneration?.() !== false
  ) return true;
  return membership.getHomeIdForDevice(deviceId) === MAIN_HOME_ID;
};

/**
 * Why a task's device sits outside the main planning lane, for the diagnostics
 * seam that must not call every such device "missing". Both arms are durable,
 * owner-visible facts about a device that still EXISTS; a device PELS genuinely
 * cannot find keeps `objective_missing_device`.
 *
 * Sub-home membership is checked first: it is the more fundamental scope
 * statement (smart tasks are main-home-only), and a relocated device that is
 * also unmanaged should still read as out of scope.
 *
 * The managed arm asks the app's OWN definition (`resolveManagedState`, the
 * same one `appSnapshotHelpers` stamps onto the snapshot the planner filters
 * with `isRuntimePlannedDevice`) rather than re-deriving one here. An explicit
 * `false` and a never-toggled device are both dropped from the planned set, so
 * both must read as un-managed — testing only for `=== false` would leave the
 * never-toggled case reporting the missing-device lie this seam exists to kill.
 *
 * The only fence is EMPTINESS, and the distinction matters. `ctx.managedDevices`
 * is `{}` until `loadCapacitySettings` runs, and an empty map is the one state
 * that carries no owner answer about any device. A fence on "some device is
 * opted in" (`isManagedFilterActive`) would instead silence the whole pause in
 * the commonest case there is — the owner un-managing their ONLY managed
 * device, leaving a map of all-`false` — and hand that task straight back to
 * the missing-device lie. Ordering already makes the empty case unreachable
 * here (the `loadCapacitySettings` startup step precedes `initDeviceManager`,
 * and the snapshot warmup gate holds the first rebuild until a snapshot lands),
 * so this is a cheap guard against a future reordering, not a live condition.
 *
 * The limit of the honesty: a device that has LEFT Homey keeps whatever flag it
 * had, so the ordinary removal (flag still `true`) still reports as missing.
 * One that was un-managed or data-purged first and then removed reads as
 * un-managed, because from the settings alone the two are indistinguishable —
 * PELS has no cheap presence oracle for a device its own managed filter has
 * already dropped from the runtime snapshot.
 */
export const resolveSmartTaskDeviceExclusion = (
  ctx: AppContext,
  deviceId: string,
): ObjectiveDeviceExclusion | null => {
  if (!isSmartTaskDeviceInMainHome(ctx, deviceId)) return 'sub_home';
  if (ctx.resolveManagedState(deviceId)) return null;
  return Object.keys(ctx.managedDevices).length === 0 ? null : 'unmanaged';
};

/**
 * Full authority for a NEW Main-home smart-task promise or terminal command.
 * Unlike the membership-only predicate above, this closes on every producer
 * fence: first-read suspect stores, no-tree active sub-homes,
 * unresolved/colliding Main meter ownership, a configured meter source, or a
 * real sub-home membership. The reason-bearing scope keeps a configured source
 * durable so lifecycle consumers disarm it instead of retrying forever.
 */
export const hasMainHomeSmartTaskAuthority = (
  ctx: AppContext,
  deviceId: string,
): boolean => resolveSmartTaskHomeScope(ctx, deviceId) === 'main';

/** Reason-bearing authority gate for candidate/preview/create/write surfaces. */
export const resolveSmartTaskHomeScope = (
  ctx: AppContext,
  deviceId: string,
): SmartTaskHomeScope => {
  const membership = ctx.homeMembership;
  // Readiness FIRST: the cached map may contain a fail-safe Main/sub-home
  // resolution built from constructor defaults after a first suspect store
  // read. It is not durable relocation evidence until both stores are proven.
  if (
    membership?.isOwnershipReady() !== true
    || membership.hasPendingOwnershipGeneration?.() !== false
  ) return 'unavailable';
  // Resolve source authority before membership/global fencing: once the active
  // source set itself is authoritative, source identity is durable even when
  // that meter belongs to a sub-home or creates a Main-meter ownership
  // collision. An unavailable source read still wins and remains retryable.
  const meterSources = membership.getConfiguredMeterSources();
  if (meterSources.state === 'unavailable') return 'unavailable';
  if (meterSources.deviceIds.has(deviceId)) return 'source_device';
  if (membership.getHomeIdForDevice(deviceId) !== MAIN_HOME_ID) return 'sub_home';
  if (membership.isMainHomeActuationFenced()) return 'unavailable';
  return 'main';
};

export const readCreateSmartTaskCandidateDevices = (
  ctx: AppContext,
): CreateSmartTaskCandidateDevicesRead => {
  const membership = ctx.homeMembership;
  if (!membership || membership.isMainHomeActuationFenced()) {
    return { state: 'unavailable' };
  }
  const meterSources = membership.getConfiguredMeterSources();
  if (meterSources.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: 'ready',
    devices: ctx.latestTargetSnapshot.filter(isRuntimePlannedDevice)
      .filter((device) => isSmartTaskDeviceInMainHome(ctx, device.id))
      .filter((device) => !meterSources.deviceIds.has(device.id)),
  };
};

// Map a refused device-scoped write outcome onto the app create-lane reject
// union: the write op's durable sub-home/source-device gates (defence-in-depth
// — normally caught earlier by `resolveValidatedObjectiveEntry`) keep their
// honest typed reasons, while transient refusals (un-confirmable migration /
// untrustworthy absence read) collapse to the retryable `write_refused` lane.
export const mapObjectiveWriteRefusalReason = (
  reason: 'device_in_sub_home' | 'device_not_planned'
    | 'migration_deferred' | 'untrusted_absence' | 'ownership_unavailable',
): 'device_in_sub_home' | 'device_not_planned' | 'write_refused' => (
  reason === 'device_in_sub_home' || reason === 'device_not_planned'
    ? reason
    : 'write_refused'
);

// Currently-starved devices for the starvation-rescue widget (the app's
// `getStarvedRescueDevices` delegate). Sourced from the diagnostics service's
// live starvation state (`getStarvedRescueEntries`, which mirrors the overview
// `getOverviewStarvation` freshness/eligibility gate) and joined against the
// runtime-planned snapshot for the device name — a starved device is by
// definition managed + capacity-controlled, so it is in `latestTargetSnapshot`.
// Entries are dropped when the device is no longer in the snapshot (e.g.
// removed mid-cycle — never shown with a stale name) and when it is durably in
// a sub-home or is an active source device. A transient Main authority fence
// keeps the diagnostic row visible but marks its rescue unavailable.
export const buildStarvedRescueDevices = (ctx: AppContext): StarvationRescueDevice[] => {
  const entries = ctx.deviceDiagnosticsService?.getStarvedRescueEntries?.() ?? [];
  // Index the snapshot by id once (O(N+M)) instead of an O(N×M) `find` per
  // entry — the live snapshot can be sizeable on busy installs.
  const snapshotById = new Map(ctx.latestTargetSnapshot.map((device) => [device.id, device]));
  const nowMs = ctx.getNow().getTime();
  return entries.flatMap((entry): StarvationRescueDevice[] => {
    const device = snapshotById.get(entry.deviceId);
    const smartTaskHomeScope = resolveSmartTaskHomeScope(ctx, entry.deviceId);
    if (
      !device
      || smartTaskHomeScope === 'sub_home'
      || smartTaskHomeScope === 'source_device'
    ) return [];
    return [{
      deviceId: entry.deviceId,
      deviceName: device.name,
      accumulatedMs: entry.starvation.accumulatedMs,
      intendedNormalTargetC: entry.intendedNormalTargetC,
      smartTaskHomeScope,
      // A device with an open smart task stays VISIBLE in the held-back list
      // but is not rescuable (the widget suppresses its button): the rescue is
      // a fresh one-shot task and must never replace the device's own active
      // or paused future task. A disabled task whose deadline is already in the
      // past no longer blocks rescue; it is history, not an open task. Same
      // open-task predicate as the app's `hasDeferredObjectiveForDevice`.
      hasSmartTask: hasOpenDeferredObjective(ctx.homey.settings, entry.deviceId, nowMs),
    }];
  });
};
