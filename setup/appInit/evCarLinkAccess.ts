import type { AppContext } from '../../lib/app/appContext';
import type { EvCarLinkSnapshotAccess } from '../../lib/device/evCarLinkWiring';
import {
  createEvCarLinkRepository,
  createPersistedEvCarLinkAccess,
  importLegacyEvCarLinkState,
} from '../../lib/device/evCarLinkStore';

/**
 * The EV car-link probe's repository on the app's userdata database, with the
 * one-shot import of the legacy settings blob run before anything reads it,
 * handed to the device layer as the port it declares
 * ({@link EvCarLinkSnapshotAccess}). Built where the transport is wired: a
 * domain's wiring owns its repository (`setup/appInit/planHistoryStore.ts` is
 * the pattern).
 */
export const createEvCarLinkAccessForApp = (
  ctx: Pick<AppContext, 'homey' | 'getUserdataDatabase'>,
): EvCarLinkSnapshotAccess => {
  const repository = createEvCarLinkRepository(ctx.getUserdataDatabase());
  const nowMs = Date.now();
  const historyResolved = importLegacyEvCarLinkState(ctx.homey.settings, repository, nowMs);
  return createPersistedEvCarLinkAccess(repository, nowMs, historyResolved);
};
