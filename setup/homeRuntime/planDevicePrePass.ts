// The snapshot pre-pass every home's plan-device projection runs before it maps
// devices — main and each sub-home alike.
//
// It exists as one function because the three steps are all SNAPSHOT-scoped, not
// home-scoped: they act on the shared observed state and the shared external-off
// hold store, and every one of them is idempotent. Duplicating them per scope is
// how the hold release sweep ended up installed on the main path only, where a
// sub-home rebuilding on its own cadence would never clear a hold whose ON
// arrived by pull — and the next shed in that bundle would strand the device.
//
// NOTE (release/2.18.0): `excludeDeviceId` does not exist on `main`. It carries
// this branch's own-meter carve-out — a home's configured meter is its power
// SOURCE, never a managed load — which `main` does not have. Folding the chain
// into the shared helper without it would have dropped that carve-out silently,
// so it is a parameter rather than an omission. Drop it only once both lines
// agree on where the carve-out lives.

import { evictMissingDeviceCacheEntries, toPlanDevice } from '../appInit/toPlanDevice';
import { isAffirmativelyOn, releaseExternalOffHoldsForObservedOn } from '../externalOffHoldDetection';
import { filterDevicesForHome } from '../homeMembership';
import { isRuntimePlannedDevice } from '../appDeviceSupport';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeId } from '../../lib/utils/settingsKeys';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { ToPlanDeviceOptions } from '../appInit/toPlanDevice';

/**
 * Seed observed state, release any external-off hold whose device is observed
 * back ON, and evict cache entries for devices that are gone — then hand back the
 * snapshot for the caller to project.
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
const runSnapshotPrePass = (ctx: AppContext): AppContext['latestTargetSnapshot'] => {
  ctx.seedObservedStateFromSnapshot();
  const snapshot = ctx.latestTargetSnapshot;
  releaseExternalOffHoldsForObservedOn({
    policy: ctx.externalOffHold,
    deviceIds: snapshot.map((device) => device.id),
    // Affirmative evidence only — see `isAffirmativelyOn`. Release is the one
    // direction where silence must not count as consent.
    isObservedOn: (deviceId) => isAffirmativelyOn(ctx.deviceManager?.getSnapshotByDeviceId(deviceId)),
    debugStructured: ctx.getStructuredDebugEmitter('reconcile', 'devices'),
  });
  evictMissingDeviceCacheEntries(ctx, snapshot);
  return snapshot;
};

/**
 * This home's plan input: the snapshot pre-pass, the membership complement, the
 * own-meter carve-out, and the shared planned-set filter.
 *
 * Membership complement: with sub-homes configured, a home plans only its own
 * members; a sub-home device is simply not in the main plan input (uncontrolled
 * — never double-controlled).
 *
 * `excludeDeviceId` drops a home's configured meter device. That plug is the
 * home's power SOURCE, not a managed load: if it were also managed+controllable
 * it would be shed on overshoot, giving either an oscillation (off plug reads
 * ~0 W → "under cap" → restore → spike) or a freeze-off (plug goes unavailable →
 * the bundle stops sampling).
 *
 * `isRuntimePlannedDevice` is the SAME predicate the create-smart-task candidate
 * list and create-time validation use, so a `managed: false` device can never be
 * offered or persisted but left unplanned.
 */
export const buildHomePlanDevices = (
  ctx: AppContext,
  homeId: HomeId,
  options?: ToPlanDeviceOptions,
  excludeDeviceId?: string | null,
): PlanInputDevice[] => (
  filterDevicesForHome(ctx.homeMembership, runSnapshotPrePass(ctx), homeId)
    .filter((device) => !excludeDeviceId || device.id !== excludeDeviceId)
    .map((device) => toPlanDevice(ctx, device, options))
    .filter(isRuntimePlannedDevice)
);
