/**
 * The wiring side of the per-home runtime registry (multi-home R7b). The
 * registry — its bundle map, recovery retry, stop latch, activation
 * bookkeeping, prepared ownership samples and every transition over them — is
 * `lib/home/homeRuntimeRegistry.ts`. This file builds what lib/home may not
 * import: the power owner's source-epoch fence, and each area's capacity
 * bundle, composed from the plan, power and price factories against the power
 * source the registry names.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { HomesStore } from '../../lib/home/homeConfig';
import type { HomeMembershipService } from '../../lib/home/homeMembershipService';
import type { HomeModeCatalog } from '../../lib/home/homeModeCatalog';
import {
  HomeRuntimeRegistry as SubHomeRegistry,
  type SubHomeBundleFactory,
} from '../../lib/home/homeRuntimeRegistry';
import type { ModeOwnershipTransfer } from '../../lib/home/modeOwnershipTransfer';
import { SubHomeRuntime } from '../../lib/home/subHomeRuntime';
import { PowerSourceEpochFence } from '../../lib/power/powerSourceEpochFence';
import { requireTrackerForMeter, resetDormantTrackerFreshness } from '../../lib/power/trackerMeterIdentity';
import type { PowerTrackerMeterIdentity } from '../../lib/power/trackerTypes';
import { requireHomeMembership } from '../appInit/contextGuards';
import { readConfiguredPowerSource } from '../powerSourceSettings';
import { createHomeCapacityBundle, type OwningHomeHooks } from './createHomeCapacityBundle';

/** The app's registry: lib/home's, with each area answering owning-home routing through its own plan. */
export type HomeRuntimeRegistry = SubHomeRegistry<OwningHomeHooks>;

/** Construct the registry over the app's ports; the caller runs its first reconcile. */
export function createHomeRuntimeRegistry(
  ctx: AppContext,
  mainModeCatalog: HomeModeCatalog,
  /**
   * The membership service's two answers the registry needs: the readiness
   * signal handed to every bundle (execution gate), and the producer-resolved
   * GA activation posture.
   */
  membership: Pick<HomeMembershipService, 'isSubHomeExecutionReady' | 'isRuntimeActive'>,
  homesStore: HomesStore,
  modeOwnershipTransfer: ModeOwnershipTransfer,
): HomeRuntimeRegistry {
  const sourceEpoch = new PowerSourceEpochFence(() => readConfiguredPowerSource(ctx.homey.settings));
  const bundleFactory: SubHomeBundleFactory<OwningHomeHooks> = {
    create: (home, powerSource) => {
      const meterIdentity: PowerTrackerMeterIdentity = { powerSource, meterDeviceId: home.meterDeviceId };
      const initialPowerTrackerState = requireTrackerForMeter(ctx.getTrackerStore(), home.homeId, meterIdentity);
      return createHomeCapacityBundle(
        ctx,
        mainModeCatalog,
        new SubHomeRuntime(
          home,
          () => membership.isSubHomeExecutionReady(),
          () => sourceEpoch.isMeterSourceAuthorized(),
          () => sourceEpoch.isEpochDiscarded(),
        ),
        initialPowerTrackerState,
        meterIdentity,
      );
    },
    resetDormantTrackerFreshness: (homeId) => resetDormantTrackerFreshness(
      ctx.getTrackerStore(),
      homeId,
      () => ctx.getStructuredLogger('homes'),
    ),
  };
  return new SubHomeRegistry(
    homesStore,
    modeOwnershipTransfer,
    {
      isRuntimeActive: () => membership.isRuntimeActive(),
      // The registry exists only while membership does (built after
      // `initHomeMembership`, dropped before `runUninit` clears it).
      getHomeIdForDevice: (deviceId) => requireHomeMembership(ctx).getHomeIdForDevice(deviceId),
    },
    bundleFactory,
    sourceEpoch,
    ctx.timers,
    () => ctx.getStructuredLogger('homes'),
  );
}
