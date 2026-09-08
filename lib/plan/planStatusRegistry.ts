/**
 * The live `PelsStatus` of every home, held in memory by the plan module.
 *
 * It used to be a settings key (`pels_status`, `pels_status:<homeId>`): the
 * writer persisted it after a rebuild, and every reader — the settings-UI API
 * handlers, the realtime push, the headroom widget, the Insights driver —
 * read the key back moments later, in this same process; the WebView and the
 * driver learned of a change from the `settings.set` echo. No Flow card and
 * nothing outside the app ever read the key. What the round trip cost was
 * the SDK shipping the ENTIRE settings object to core on every write, ~55
 * times an hour once the history keys had left (`lib/store/`), plus a blob
 * from a previous run served as current after a restart.
 *
 * Here a status is a fact of THIS run: absent until the home's first plan
 * builds, replaced on every publish, gone when the home is torn down. The
 * writer's publish cadence is unchanged (`PlanStatusWriter`): every listener
 * still does real work per publish — the driver writes capabilities, the
 * WebView refetches — so the 60 s volatile throttle stays.
 */
import type { HomeId } from '../utils/settingsKeys';
import type { SettingsPort } from '../ports/homeyRuntime';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import { listLegacySettingsKeys } from '../store/legacySettingsImport';
import type { PelsStatus } from './pelsStatus';

const logger = getLogger('plan/status');

/** The settings key the status lived under before it was held in memory. */
const LEGACY_PLAN_STATUS_KEY = 'pels_status';

export type PlanStatusRead =
  | Readonly<{ state: 'resolved'; status: PelsStatus }>
  | Readonly<{ state: 'absent' }>;

export type PlanStatusListener = (homeId: HomeId, status: PelsStatus) => void;

export type PlanStatusRegistry = {
  publish(homeId: HomeId, status: PelsStatus): void;
  /** `absent` before the home's first publish this run, and after its teardown. */
  read(homeId: HomeId): PlanStatusRead;
  /** A torn-down home has no status; a later read is `absent`. */
  retire(homeId: HomeId): void;
  /** Hear every publish; returns the unsubscribe. A listener that throws is logged, never propagated to the writer. */
  subscribe(listener: PlanStatusListener): () => void;
};

export const createPlanStatusRegistry = (): PlanStatusRegistry => {
  const statuses = new Map<HomeId, PelsStatus>();
  const listeners = new Set<PlanStatusListener>();
  return {
    publish: (homeId, status) => {
      statuses.set(homeId, status);
      for (const listener of listeners) {
        try {
          listener(homeId, status);
        } catch (error) {
          logger.warn({ event: 'plan_status_listener_failed', homeId, err: normalizeError(error) });
        }
      }
    },
    read: (homeId) => {
      const status = statuses.get(homeId);
      return status === undefined ? { state: 'absent' } : { state: 'resolved', status };
    },
    retire: (homeId) => { statuses.delete(homeId); },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};

const isFunction = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === 'function';

/**
 * The registry of a running app, reached from outside its object graph: the
 * Insights driver and the widget API handler hold only the SDK's untyped
 * `homey.app`. Narrowed structurally once, at that seam; an app shell without
 * one (a test double, a torn-down app) is `null`, which those readers treat
 * as "no status", never as a failure.
 */
export const planStatusRegistryOf = (app: unknown): PlanStatusRegistry | null => {
  if (app === null || typeof app !== 'object') return null;
  const candidate = (app as { planStatuses?: unknown }).planStatuses;
  if (candidate === null || typeof candidate !== 'object') return null;
  const { read, subscribe } = candidate as { read?: unknown; subscribe?: unknown };
  return isFunction(read) && isFunction(subscribe) ? candidate as PlanStatusRegistry : null;
};

/**
 * One-shot boot cleanup: the keys the status used to be persisted under, for
 * every home. Nothing is imported — a status is a fact of the run that
 * publishes it, and the previous run's blob is exactly what must not be served
 * as current. A key list that cannot be read, or an unset the SDK rejects,
 * leaves the keys for the next boot, like every other legacy family
 * (`lib/store/legacySettingsImport.ts`) — one transient must never fail the
 * boot step this runs in.
 */
export const retireLegacyPlanStatusKeys = (settings: SettingsPort): void => {
  const keys = listLegacySettingsKeys(settings, (key) => (
    key === LEGACY_PLAN_STATUS_KEY || key.startsWith(`${LEGACY_PLAN_STATUS_KEY}:`)
  ));
  if (keys === null || keys.length === 0) return;
  try {
    for (const key of keys) settings.unset(key);
  } catch (error) {
    logger.warn({ event: 'legacy_plan_status_keys_retire_deferred', keys, err: normalizeError(error) });
    return;
  }
  logger.info({ event: 'legacy_plan_status_keys_retired', keys });
};
