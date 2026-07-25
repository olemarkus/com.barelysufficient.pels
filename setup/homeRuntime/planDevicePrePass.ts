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
// NOTE (release/2.18.0): on `main` this module also owns the membership
// complement and the planned-set filter, as `buildHomePlanDevices`. Here it stops
// at the snapshot on purpose — this branch's sub-home projection carries an
// own-meter carve-out that `main` does not have, and folding the chain into a
// shared helper would have dropped that carve-out silently. Keep the two callers'
// chains local until the carve-out exists on both lines.

import { evictMissingDeviceCacheEntries } from '../appInit/toPlanDevice';
import { isAffirmativelyOn, releaseExternalOffHoldsForObservedOn } from '../externalOffHoldDetection';
import type { AppContext } from '../../lib/app/appContext';

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
export const runPlanDeviceSnapshotPrePass = (ctx: AppContext): AppContext['latestTargetSnapshot'] => {
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
