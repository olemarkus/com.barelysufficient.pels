import type { AppContext } from '../../lib/app/appContext';
import { resolveHomeIdForModeCatalogSeed as resolveOwnedHomeId } from '../../lib/home/homeModeDeviceRead';
import type { HomeId } from '../../lib/utils/settingsKeys';

/** Setup adapter for the domain-owned, committed device membership read. */
export const resolveHomeIdForModeCatalogSeed = (
  ctx: AppContext,
  deviceId: string,
): HomeId | null => resolveOwnedHomeId(ctx.homeMembership, deviceId);
