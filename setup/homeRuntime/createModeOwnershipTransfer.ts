import type { AppContext } from '../../lib/app/appContext';
import { ModeOwnershipTransfer } from '../../lib/home/modeOwnershipTransfer';
import { HomeModeOwnershipStore } from './homeModeOwnershipStore';
import { transferModeTargetsForOwnershipMoves } from './homeModeCatalog';

/**
 * Give `lib/home`'s ownership transfer the four app-shaped seams it reads and
 * the catalog transfer it cannot name itself.
 *
 * The component is the domain's; this is the binding. `lib/home` is a declared
 * pure leaf, so the catalog — which reads capacity priorities, mode aliases and
 * operating mode off `AppContext` — arrives as a callback rather than an import.
 */
export const createModeOwnershipTransfer = (ctx: AppContext): ModeOwnershipTransfer => (
  new ModeOwnershipTransfer({
    store: new HomeModeOwnershipStore(ctx.homey.settings),
    getLogger: () => ctx.getStructuredLogger('homes'),
    getMembership: () => ctx.homeMembership,
    getLatestTargetSnapshot: () => ctx.latestTargetSnapshot,
    transferModeTargets: (moves) => transferModeTargetsForOwnershipMoves(ctx, moves),
  })
);
