/**
 * One home's signal writers: what a `HomeScope` writes as the planner and
 * executor run — the last-controlled map in the userdata store — and the
 * status it publishes into the app's in-memory registry.
 *
 * Both the main home and every meter area wrote these the same way and each
 * hand-rolled its own copy, differing only in whether the home can be torn
 * down. `isTornDown` is that difference and the whole of it.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { HomeId } from '../../lib/utils/settingsKeys';
import type { HomeScope } from './homeScope';

/** The signals a `HomeScope` writes, for THIS home. */
export type HomeSignalWriters = Pick<HomeScope, 'persistLastControlledMs' | 'publishPelsStatus'>;

/**
 * This home's signal writers — the home's rows in the last-controlled store,
 * the status under its `homeId` in the registry. `isTornDown` fences them: an
 * in-flight rebuild/reconcile continuation that resolves AFTER a home's
 * teardown must not re-create that home's rows or status, nor clobber a
 * same-`homeId` bundle created after it. Actuation is fenced separately at the
 * actuator seam.
 */
export function createHomeSignalWriters(
  ctx: AppContext,
  homeId: HomeId,
  isTornDown: () => boolean,
): HomeSignalWriters {
  return {
    // The teardown fence stops writes before the userdata database closes.
    // The store is looked up at the write: the main home's writers are built
    // before the database opens.
    persistLastControlledMs: (lastControlledMs) => {
      if (isTornDown()) return;
      ctx.getLastControlledStore().write(homeId, lastControlledMs);
    },
    publishPelsStatus: (status) => {
      if (isTornDown()) return;
      ctx.planStatuses.publish(homeId, status);
    },
  };
}
