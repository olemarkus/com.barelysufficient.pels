import type { AppContext } from '../../lib/app/appContext';
import type {
  StarvationNotListedDevice,
  StarvationRescueDevice,
} from '../../packages/contracts/src/starvationRescue';
import {
  hasOpenDeferredObjective,
  isDeviceInSmartTaskMainHome,
  readCreateSmartTaskCandidates,
  resolveDeviceSmartTaskHomeScope,
} from '../../lib/objectives/deferredObjectives';
import type { SmartTaskHomeScope } from '../../packages/contracts/src/smartTaskHomeScope';
import type { CreateSmartTaskCandidateDevicesRead } from '../../packages/contracts/src/widgetHostApi';
import type { ObjectiveDeviceExclusion } from '../../lib/objectives/deferredObjectives/deviceExclusion';
import { requireDeviceDiagnosticsService } from './contextGuards';

// The smart-task scope rules live in `lib/objectives/deferredObjectives/smartTaskHomeScope.ts`.
// Membership is wired at startup and cleared at teardown; outside that window
// there is no evidence of relocation and no authority for a new promise.
export const isSmartTaskDeviceInMainHome = (ctx: AppContext, deviceId: string): boolean => {
  const membership = ctx.homeMembership;
  return membership ? isDeviceInSmartTaskMainHome(membership, deviceId) : true;
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
 * The only fence is EMPTINESS, and the distinction matters. The managed map
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
  return Object.keys(ctx.deviceControlSettings.managedDevices).length === 0 ? null : 'unmanaged';
};

/** Full authority for a NEW Main-home smart-task promise or terminal command. */
export const hasMainHomeSmartTaskAuthority = (
  ctx: AppContext,
  deviceId: string,
): boolean => resolveSmartTaskHomeScope(ctx, deviceId) === 'main';

export const resolveSmartTaskHomeScope = (ctx: AppContext, deviceId: string): SmartTaskHomeScope => {
  const membership = ctx.homeMembership;
  return membership ? resolveDeviceSmartTaskHomeScope(membership, deviceId) : 'unavailable';
};

export const readCreateSmartTaskCandidateDevices = (
  ctx: AppContext,
  readModeTargetC: (deviceId: string) => number | null,
): CreateSmartTaskCandidateDevicesRead => {
  const membership = ctx.homeMembership;
  return membership
    ? readCreateSmartTaskCandidates(membership, ctx.getPlanInputSnapshot(), readModeTargetC)
    : { state: 'unavailable' };
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

// The smart-task scope a held-back widget row is shown under, or null for a
// device the widget leaves out: durably in a sub-home, or an active source
// device. One filter for both of the widget's lists, so they cover the same
// devices. A transient Main authority fence keeps the row (scope `unavailable`).
const resolveHeldBackWidgetScope = (
  ctx: AppContext,
  deviceId: string,
): Exclude<SmartTaskHomeScope, 'sub_home' | 'source_device'> | null => {
  const scope = resolveSmartTaskHomeScope(ctx, deviceId);
  return scope === 'sub_home' || scope === 'source_device' ? null : scope;
};

// Currently-starved devices for the starvation-rescue widget (the app's
// `getStarvedRescueDevices` delegate). Sourced from the diagnostics service's
// live starvation state (`getStarvedRescueEntries`, which mirrors the overview
// `getOverviewStarvation` freshness/eligibility gate) and joined against
// DeviceConfiguration for the device name — a starved device is by definition
// managed + capacity-controlled, so its configuration is present. Entries are
// dropped when the device is no longer configured (e.g. removed mid-cycle —
// never shown with a stale name) and by `resolveHeldBackWidgetScope`. A
// transient Main authority fence keeps the diagnostic row visible but marks its
// rescue unavailable.
export const buildStarvedRescueDevices = (ctx: AppContext): StarvationRescueDevice[] => {
  const entries = ctx.deviceDiagnosticsService?.getStarvedRescueEntries?.() ?? [];
  const configurationById = new Map(ctx.deviceConfiguration.getAll().map((device) => [device.id, device]));
  const nowMs = ctx.getNow().getTime();
  return entries.flatMap((entry): StarvationRescueDevice[] => {
    const device = configurationById.get(entry.deviceId);
    const smartTaskHomeScope = resolveHeldBackWidgetScope(ctx, entry.deviceId);
    if (!device || smartTaskHomeScope === null) return [];
    return [{
      deviceId: entry.deviceId,
      deviceName: device.name,
      accumulatedMs: entry.starvation.accumulatedMs,
      intendedTarget: entry.intendedTarget,
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

// Devices PELS limits for power that the held-back list leaves out, with why
// (the app's `getLimitedNotListedDevices` delegate), for the same widget. The
// diagnostics service resolves each entry, name included; this keeps only the
// devices the widget covers.
export const buildLimitedNotListedDevices = (ctx: AppContext): StarvationNotListedDevice[] => (
  requireDeviceDiagnosticsService(ctx).getLimitedNotListedEntries()
    .filter((entry) => resolveHeldBackWidgetScope(ctx, entry.deviceId) !== null)
);
