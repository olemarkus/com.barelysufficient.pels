// The plan-device projection every home runs — main and each sub-home alike.
//
// It lives in one place because the snapshot-scoped steps are shared, not
// home-scoped: they act on the shared observed state and the shared external-off
// hold store, and every one of them is idempotent. Duplicating them per scope is
// how the hold release sweep ended up installed on the main path only, where a
// sub-home rebuilding on its own cadence would never clear a hold whose ON
// arrived by pull — and the next shed in that bundle would strand the device.
//
// Each home supplies its resolved projection policy, hold cleanup and priority
// resolver. This boundary projects the home's current planned set to unique
// relative ranks before either the planner or smart-task clock reads it.

import { createPlanInputProjectionSource } from '../appInit/planInputDeviceProjection';
import { projectPlanInputDevice } from '../../lib/planInput/projectPlanInputDevice';
import { pruneMissingLearnedPowerPeaks } from '../appInit/devicePowerPeakPrePass';
import {
  isAffirmativelyOn,
  releaseExternalOffHoldsForObservedOn,
  toExternalOffHoldObservedDevice,
} from '../externalOffHoldDetection';
import { isRuntimePlannedPlanDevice } from '../appDeviceSupport';
import type { AppContext } from '../../lib/app/appContext';
import { MAIN_HOME_ID, type HomeId } from '../../lib/utils/settingsKeys';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { ToPlanDeviceOptions } from '../appInit/toPlanDevice';
import type { ModePriorityOrder } from '../../packages/shared-domain/src/settings/modePriorities';
import { isPlannableDevice } from '../../lib/plan/planMeteredDevice';
import { hasStorageInput } from '../../lib/plan/battery/storageRelief';

type BuildHomePlanDevicesOptions = ToPlanDeviceOptions & {
  /** Owning-home cleanup for a pull-observed ON after an outside-off hold. */
  clearRecentBinaryOffCommand: (deviceId: string, observedOnAtMs: number) => void;
  /** Remove stale retry state for devices no longer in the runtime configuration. */
  pruneCommandability: (presentDeviceIds: ReadonlySet<string>) => void;
  /** This home's catalog owner returns a complete order for the planned set. */
  getPrioritiesForDevices: (deviceIds: readonly string[]) => ModePriorityOrder;
};

/**
 * Release any external-off hold whose device is observed back ON, and evict
 * cache entries for devices that are gone.
 *
 * The release sweep is here rather than at the push seam because detection is
 * push-driven, which is the safe direction for STARTING a hold but the wrong one
 * for ending it: a device whose ON arrived while the live feed was down, or whose
 * realtime event carried no change because a pull had already written
 * `on: true`, would stay held and be stranded by the next capacity shed under a
 * reason line that reads like the feature working. O(active holds) — zero for
 * everyone who has not opted a device in.
 *
 * Eviction deliberately sees all configured device IDs: a sub-home member is
 * excluded from the main home's plan input, but it is still present on Homey,
 * so its cached per-device state must survive for the per-home bundles.
 */
const runSnapshotPrePass = (
  ctx: AppContext,
  options: BuildHomePlanDevicesOptions,
): ReturnType<AppContext['getPlanInputSnapshot']> => {
  const snapshot = ctx.getPlanInputSnapshot();
  releaseExternalOffHoldsForObservedOn({
    policy: ctx.externalOffHold,
    deviceIds: snapshot.map((device) => device.id),
    // Affirmative evidence only — see `isAffirmativelyOn`. Release is the one
    // direction where silence must not count as consent.
    isObservedOn: (deviceId) => isAffirmativelyOn(ctx.getObservedRecord(deviceId)),
    onObservedOn: (deviceId) => {
      const device = snapshot.find((entry) => entry.id === deviceId);
      // Planner input carries both the observation and the resolved identity.
      const observation = toExternalOffHoldObservedDevice(device, device);
      if (
        observation?.binaryAxisOn !== true
        || observation.binaryAxisObservedAtMs === undefined
      ) return;
      options.clearRecentBinaryOffCommand(
        deviceId,
        observation.binaryAxisObservedAtMs,
      );
    },
    debugStructured: ctx.getStructuredDebugEmitter('reconcile', 'devices'),
  });
  // Pruning uses all configured devices, even when this observer join or the
  // per-home projection omitted one temporarily.
  const presentDeviceIds = new Set(ctx.deviceConfiguration.ids());
  pruneMissingLearnedPowerPeaks(ctx, presentDeviceIds);
  options.pruneCommandability(presentDeviceIds);
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
 * offered or persisted but left unplanned. `isPlannableDevice` (`lib/plan`) says
 * which of those the plan can act on: a device with a power reading, or a
 * temperature device, which without a reading gets its setpoints and no power
 * limiting.
 */
export const buildHomePlanDevices = (
  ctx: AppContext,
  homeId: HomeId,
  options: BuildHomePlanDevicesOptions,
): PlanInputDevice[] => {
  const source = createPlanInputProjectionSource(ctx);
  const snapshot = runSnapshotPrePass(ctx, options);
  const membership = ctx.homeMembership;
  let homeDevices = homeId === MAIN_HOME_ID ? snapshot : [];
  if (membership) homeDevices = membership.filterDevicesForHome(snapshot, homeId);
  const devices = homeDevices
    .map((device) => projectPlanInputDevice(source, device, options))
    // A battery PELS holds stays planned without a power reading (its storage
    // cluster then reads `missing`), so the hold is kept or released, never lost.
    .filter((device) => (isPlannableDevice(device) || hasStorageInput(device)) && isRuntimePlannedPlanDevice(device));
  // The mode catalog owner puts the home's planned set in order: unique,
  // gap-free, no ties (`packages/shared-domain/src/settings/modePriorities.ts`).
  const deviceIds = devices.map((device) => device.id);
  const priorities = options.getPrioritiesForDevices(deviceIds);
  return devices.map((device) => ({ ...device, priority: priorities.getPriority(device.id) }));
};
