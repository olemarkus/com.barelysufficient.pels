import type { AppContext } from '../../lib/app/appContext';
import type { StarvationRescueDevice } from '../../packages/contracts/src/starvationRescue';
import { hasOpenDeferredObjective } from '../../lib/objectives/deferredObjectives';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';

/**
 * Multi-home v1 scope predicate shared by EVERY smart-task surface: the app's
 * candidate list + create validation (`app.ts`), the device-scoped write op's
 * defence-in-depth gate (`buildDeferredObjectiveDeviceWriteDeps`), the
 * set-deadline flow-card autocompletes (`registerAppFlowCards`), and — negated
 * — the decoration controller's diagnostics honesty (`createPlanEngine`).
 *
 * Smart tasks are planned against the MAIN home's meter budget (hard cap,
 * daily-budget overlay, concurrent-eligible sharing), so a device in a
 * separate-meter sub-home is out of scope. Before the membership service is
 * wired (boot window / bare test contexts) — and whenever no sub-homes are
 * configured, since membership then resolves main for everything — every
 * device counts as main-home, preserving exact single-home behavior. One
 * definition so the surfaces can never disagree.
 */
export const isSmartTaskDeviceInMainHome = (ctx: AppContext, deviceId: string): boolean => {
  const homeId = ctx.homeMembership?.getHomeIdForDevice(deviceId);
  // `undefined` = membership service not wired (boot window / bare test
  // contexts). `null` is OUTSIDE the HomeMembershipPort contract
  // (`getHomeIdForDevice` fail-safes unknown devices to main, never null) —
  // but if an upstream contract ever slips, an unknown membership must resolve
  // MAIN, loudly by this comment rather than silently by `!==` fallthrough:
  // treating it as sub-home would flip every smart-task gate to rejection on a
  // plain single-home install, breaking the identity-when-no-sub-homes
  // invariant. Mirrors the membership resolver's own fail-safe direction.
  return homeId === undefined || homeId === null || homeId === MAIN_HOME_ID;
};

// Map a refused device-scoped write outcome onto the app create-lane reject
// union: the write op's own sub-home gate (defence-in-depth — normally caught
// earlier by `resolveValidatedObjectiveEntry`) keeps its honest typed reason,
// while the transient refusals (un-confirmable migration / untrustworthy
// absence read) collapse to the retryable `write_refused` lane.
export const mapObjectiveWriteRefusalReason = (
  reason: 'device_in_sub_home' | 'migration_deferred' | 'untrusted_absence',
): 'device_in_sub_home' | 'write_refused' => (
  reason === 'device_in_sub_home' ? 'device_in_sub_home' : 'write_refused'
);

// Currently-starved devices for the starvation-rescue widget (the app's
// `getStarvedRescueDevices` delegate). Sourced from the diagnostics service's
// live starvation state (`getStarvedRescueEntries`, which mirrors the overview
// `getOverviewStarvation` freshness/eligibility gate) and joined against the
// runtime-planned snapshot for the device name — a starved device is by
// definition managed + capacity-controlled, so it is in `latestTargetSnapshot`.
// The `cause` is the producer-resolved flat value; the widget never re-derives
// it. Entries are dropped when the device is no longer in the snapshot (e.g.
// removed mid-cycle — never shown with a stale name) and (multi-home v1) when
// it is in a sub-home: the rescue IS a smart-task create (main-home-only), so
// a listed row would dead-end on the create gate's `device_in_sub_home`
// rejection — same predicate as the create-candidate list so the two surfaces
// can't disagree.
export const buildStarvedRescueDevices = (ctx: AppContext): StarvationRescueDevice[] => {
  const entries = ctx.deviceDiagnosticsService?.getStarvedRescueEntries?.() ?? [];
  // Index the snapshot by id once (O(N+M)) instead of an O(N×M) `find` per
  // entry — the live snapshot can be sizeable on busy installs.
  const snapshotById = new Map(ctx.latestTargetSnapshot.map((device) => [device.id, device]));
  const nowMs = ctx.getNow().getTime();
  return entries.flatMap((entry): StarvationRescueDevice[] => {
    const device = snapshotById.get(entry.deviceId);
    if (!device || !isSmartTaskDeviceInMainHome(ctx, entry.deviceId)) return [];
    return [{
      deviceId: entry.deviceId,
      deviceName: device.name,
      cause: entry.starvation.cause,
      accumulatedMs: entry.starvation.accumulatedMs,
      intendedNormalTargetC: entry.intendedNormalTargetC,
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
