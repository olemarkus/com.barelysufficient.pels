import type { AppContext } from '../../lib/app/appContext';
import type { HomeModeCatalog } from '../../lib/home/homeModeCatalog';
import { ModeOwnershipTransfer } from '../../lib/home/modeOwnershipTransfer';
import { HomeModeOwnershipStore } from './homeModeOwnershipStore';
import { transferModeTargetsForOwnershipMoves } from '../../lib/home/homeModeCatalogOwnership';

/**
 * Give `lib/home`'s ownership transfer the four app-shaped seams it reads and
 * the catalog transfer it cannot name itself.
 *
 * The component is the domain's; this is the binding. `lib/home` is a declared
 * pure leaf, so the catalog arrives as an explicit owner rather than being
 * reached through the broad `AppContext`.
 */
export const createModeOwnershipTransfer = (
  ctx: AppContext,
  homeModeCatalog: HomeModeCatalog,
): ModeOwnershipTransfer => (
  new ModeOwnershipTransfer({
    store: new HomeModeOwnershipStore(ctx.homey.settings),
    getLogger: () => ctx.getStructuredLogger('homes'),
    getMembership: () => ctx.homeMembership,
    getDeviceSurfaces: () => ctx.getDeviceSurfaces(),
    transferModeTargets: (moves) => transferModeTargetsForOwnershipMoves(
      ctx.homey.settings,
      homeModeCatalog,
      () => ctx.managedDevices,
      () => ctx.homeMembership,
      moves,
    ),
  })
);
