// The plan-device projection every home runs — main and each sub-home alike.
//
// It lives in one place because the snapshot-scoped steps are shared, not
// home-scoped: they act on the shared observed state and the shared external-off
// hold store, and every one of them is idempotent. Duplicating them per scope is
// how the hold release sweep ended up installed on the main path only, where a
// sub-home rebuilding on its own cadence would never clear a hold whose ON
// arrived by pull — and the next shed in that bundle would strand the device.
//
// Only the per-device projection differs between homes, and that difference is
// the options argument: a sub-home disables the surplus posture, routes
// pending-binary reads to its own engine, and supplies its own mode-priority
// resolver. This boundary also projects each home's current planned set to
// unique relative ranks before either the planner or smart-task clock reads it.

import { evictMissingDeviceCacheEntries, toPlanDevice } from '../appInit/toPlanDevice';
import {
  isAffirmativelyOn,
  releaseExternalOffHoldsForObservedOn,
  toExternalOffHoldObservedDevice,
} from '../externalOffHoldDetection';
import { filterDevicesForHome } from '../homeMembership';
import { isRuntimePlannedPlanDevice } from '../appDeviceSupport';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeId } from '../../lib/utils/settingsKeys';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { ToPlanDeviceOptions } from '../appInit/toPlanDevice';
import type { ModePriorityOrder } from '../../packages/shared-domain/src/settings/modePriorities';
import { filterMeteredPlanDevices } from '../../lib/plan/planMeteredDevice';

type BuildHomePlanDevicesOptions = ToPlanDeviceOptions & {
  /** This home's catalog owner returns a complete order for the planned set. */
  getPrioritiesForDevices?: (deviceIds: readonly string[]) => ModePriorityOrder;
};

/**
 * Seed observed state, release any external-off hold whose device is observed
 * back ON, and evict cache entries for devices that are gone.
 *
 * The release sweep is here rather than at the push seam because detection is
 * push-driven, which is the safe direction for STARTING a hold but the wrong one
 * for ending it: a device whose ON arrived while the live feed was down, or whose
 * realtime event carried no change because a pull had already written
 * `on: true`, would stay held and be stranded by the next capacity shed under a
 * reason line that reads like the feature working. O(active holds) — zero for
 * everyone who has not opted a device in.
 *
 * Eviction deliberately sees the FULL snapshot: a sub-home member is excluded
 * from the main home's plan input, but it is still present on Homey, so its
 * cached per-device state must survive for the per-home bundles.
 */
const runSnapshotPrePass = (
  ctx: AppContext,
  options?: ToPlanDeviceOptions,
): AppContext['latestTargetSnapshot'] => {
  ctx.seedObservedStateFromSnapshot();
  const snapshot = ctx.latestTargetSnapshot;
  releaseExternalOffHoldsForObservedOn({
    policy: ctx.externalOffHold,
    deviceIds: snapshot.map((device) => device.id),
    // Affirmative evidence only — see `isAffirmativelyOn`. Release is the one
    // direction where silence must not count as consent.
    isObservedOn: (deviceId) => isAffirmativelyOn(ctx.deviceManager?.getSnapshotByDeviceId(deviceId)),
    onObservedOn: (deviceId) => {
      const device = snapshot.find((entry) => entry.id === deviceId);
      const observation = toExternalOffHoldObservedDevice(device);
      if (
        observation?.binaryAxisOn !== true
        || observation.binaryAxisObservedAtMs === undefined
      ) return;
      if (options?.clearRecentBinaryOffCommand) {
        options.clearRecentBinaryOffCommand(
          deviceId,
          observation.binaryAxisObservedAtMs,
        );
        return;
      }
      ctx.planEngine?.clearRecentBinaryOffCommand(
        deviceId,
        observation.binaryAxisObservedAtMs,
      );
    },
    debugStructured: ctx.getStructuredDebugEmitter('reconcile', 'devices'),
  });
  evictMissingDeviceCacheEntries(ctx, snapshot);
  return snapshot;
};

/**
 * This home's plan input: the snapshot pre-pass, the membership complement, and
 * the shared planned-set filter.
 *
 * Membership complement: with sub-homes configured, a home plans only its own
 * members; a sub-home device is simply not in the main plan input (uncontrolled
 * — never double-controlled). Every configured meter is then removed because it
 * is a source, never a controllable load. With no sub-homes or an explicit Main
 * meter, the same array is returned.
 *
 * `isRuntimePlannedDevice` is the SAME predicate the create-smart-task candidate
 * list and create-time validation use, so a `managed: false` device can never be
 * offered or persisted but left unplanned. `filterMeteredPlanDevices`
 * (`lib/plan`) admits only devices with a trusted per-device power reading.
 * Temperature capability does not bypass power admission.
 */
export const buildHomePlanDevices = (
  ctx: AppContext,
  homeId: HomeId,
  options?: BuildHomePlanDevicesOptions,
): PlanInputDevice[] => {
  const homeDevices = filterDevicesForHome(ctx.homeMembership, runSnapshotPrePass(ctx, options), homeId);
  const devices = filterMeteredPlanDevices(homeDevices.map((device) => toPlanDevice(ctx, device, options)))
    .filter(isRuntimePlannedPlanDevice);
  // The mode catalog owner puts the home's planned set in order: unique,
  // gap-free, no ties (`packages/shared-domain/src/settings/modePriorities.ts`).
  const deviceIds = devices.map((device) => device.id);
  const priorities = options?.getPrioritiesForDevices
    ? options.getPrioritiesForDevices(deviceIds)
    : ctx.getPrioritiesForDevices(deviceIds);
  return devices.map((device) => ({ ...device, priority: priorities.getPriority(device.id) }));
};
