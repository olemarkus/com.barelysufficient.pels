/**
 * One home's signal writers: the two settings keys a `HomeScope` writes as
 * the planner and executor run — the shortfall flag and the last-controlled
 * map — and the status it publishes into the app's in-memory registry.
 *
 * Both the main home and every meter area wrote these the same way and each
 * hand-rolled its own copy, differing only in whether the home can be torn
 * down. `isTornDown` is that difference and the whole of it.
 */
import type { AppContext } from '../../lib/app/appContext';
import {
  CAPACITY_IN_SHORTFALL,
  DEVICE_LAST_CONTROLLED_MS,
  type HomeId,
  homeScopedSettingsKey,
} from '../../lib/utils/settingsKeys';
import type { HomeScope } from './homeScope';

/** The three signals a `HomeScope` writes, for THIS home. */
export type HomeSignalWriters = Pick<
  HomeScope,
  'setCapacityInShortfall' | 'persistLastControlledMs' | 'publishPelsStatus'
>;

/**
 * This home's signal writers — the settings keys on
 * `homeScopedSettingsKey(base, homeId)` (the bare key for the main home), the
 * status under its `homeId` in the registry. `isTornDown` fences them: an
 * in-flight rebuild/reconcile continuation that resolves AFTER a home's
 * teardown must not re-create that home's keys or status, nor clobber a
 * same-`homeId` bundle created after it. Actuation is fenced separately at the
 * actuator seam.
 */
export function createHomeSignalWriters(
  ctx: AppContext,
  homeId: HomeId,
  isTornDown: () => boolean,
): HomeSignalWriters {
  const write = (baseKey: string, value: unknown): void => {
    if (isTornDown()) return;
    ctx.homey.settings.set(homeScopedSettingsKey(baseKey, homeId), value);
  };
  return {
    setCapacityInShortfall: (inShortfall) => write(CAPACITY_IN_SHORTFALL, inShortfall),
    persistLastControlledMs: (lastControlledMs) => write(DEVICE_LAST_CONTROLLED_MS, lastControlledMs),
    publishPelsStatus: (status) => {
      if (isTornDown()) return;
      ctx.planStatuses.publish(homeId, status);
    },
  };
}
