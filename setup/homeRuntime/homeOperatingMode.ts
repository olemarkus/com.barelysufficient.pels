import type { AppContext } from '../../lib/app/appContext';
import type { HomeModeCatalog } from '../../lib/home/homeModeCatalog';
import type { HomeMembershipPort } from '../../lib/home/membership';
import {
  resolveHomeIdForModeCatalogSeed as resolveOwnedHomeId,
  type DeviceOperatingModeOutcome,
} from '../../lib/home/homeModeDeviceRead';
import type { HomeId } from '../../lib/utils/settingsKeys';

export type { DeviceOperatingModeOutcome };

/** Setup adapter for the domain-owned, committed device membership read. */
export const resolveHomeIdForModeCatalogSeed = (
  ctx: AppContext,
  deviceId: string,
): HomeId | null => resolveOwnedHomeId(ctx.homeMembership, deviceId);

/** Passes the narrow runtime seams to the home domain's mode resolver. */
export const resolveOperatingModeForDevice = (
  homeModeCatalog: HomeModeCatalog,
  deviceId: string,
  membershipOverride?: HomeMembershipPort,
  allowPendingOwnershipGeneration = false,
): DeviceOperatingModeOutcome => homeModeCatalog.resolveOperatingModeForDevice(
  deviceId,
  membershipOverride,
  allowPendingOwnershipGeneration,
);
