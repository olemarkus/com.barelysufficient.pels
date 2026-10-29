/**
 * The smart-task active plans' rows in the userdata database, behind the
 * load/save seam the active-plan recorder persists through, and the one-shot
 * import of the legacy `deferred_objective_active_plans` settings key.
 *
 * An active plan is re-plannable state, not configuration, so it lives in the
 * userdata store by ruling (`notes/settings-key-ownership.md` § "Which store a
 * key lives in"): in `homey.settings` every save of the plans shipped the whole
 * settings object to Homey core, and every write of any other key paid for the
 * plans. Each device's plan is one row keyed by its device id, diffed against
 * what the store holds, so a revision writes that device's row and nothing
 * else. Every row re-entering from disk passes the recorder's own normaliser
 * (`normalizeDeferredObjectiveActivePlans`); a row it refuses is the store's
 * own damage and is deleted as read (`lib/store/jsonRowTable.ts`).
 */
import type {
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV2,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { isUnknownRecord } from '../../../packages/shared-domain/src/recordGuards';
import { getLogger } from '../../logging/logger';
import type { SettingsPort } from '../../ports/homeyRuntime';
import {
  hasLegacyImportMark,
  importListedLegacySettingsKey,
  type MarkedLegacyImport,
  writeLegacyImportMark,
} from '../../store/legacySettingsImport';
import { createJsonRowTable } from '../../store/jsonRowTable';
import type { UserdataDatabase } from '../../store/userdataDatabase';
import { normalizeError } from '../../utils/errorUtils';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING } from '../../utils/settingsKeys';
import type { ActivePlanPersistDeps } from './activePlanRevisionBuild';
import {
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
  normalizeDeferredObjectiveActivePlans,
} from './activePlanSettings';

const storeLogger = getLogger('deferred-objectives/active-plan-store');

export type ActivePlanStore = {
  /** The stored plans, or `null` when the store holds none. Throws only on I/O. */
  read(): DeferredObjectiveActivePlansV2 | null;
  /** Make the store hold exactly `plans`, touching only the devices whose plan differs. */
  write(plans: DeferredObjectiveActivePlansV2): void;
};

/** The store as this module builds it: the recorder's port, and the legacy import's. */
export type ActivePlanRepository = ActivePlanStore & MarkedLegacyImport<DeferredObjectiveActivePlansV2>;

type StoredActivePlan = {
  version: typeof DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION;
  plan: DeferredObjectiveActivePlanV1;
};

const envelopeOf = (
  plansByDeviceId: Record<string, DeferredObjectiveActivePlanV1>,
): DeferredObjectiveActivePlansV2 => ({
  version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
  plansByDeviceId,
});

/** One row's plan, through the recorder's normaliser; `undefined` when it holds none for its key. */
const acceptRow = (value: unknown, deviceId: string): StoredActivePlan | undefined => {
  if (!isUnknownRecord(value)) return undefined;
  // Rows written before interval scheduling were bare hourly plans. Only
  // that known legacy shape may acquire an hourly end during normalization.
  const version = 'version' in value ? value.version : 1;
  if (version !== 1 && version !== DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION) return undefined;
  const plan = normalizeDeferredObjectiveActivePlans({
    version,
    plansByDeviceId: { [deviceId]: 'version' in value ? value.plan : value },
  }).plansByDeviceId[deviceId];
  return plan !== undefined && plan.deviceId === deviceId
    ? { version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION, plan }
    : undefined;
};

export const createActivePlanStore = (db: UserdataDatabase): ActivePlanRepository => {
  const table = createJsonRowTable(db, 'deferred_objective_active_plans', ['device_id', 'plan_json'], acceptRow);
  const write = (plans: DeferredObjectiveActivePlansV2): void => {
    table.write(new Map(Object.entries(plans.plansByDeviceId).map(([deviceId, plan]): [string, StoredActivePlan] => (
      [deviceId, { version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION, plan }]
    ))));
  };
  return {
    read: () => db.transaction(() => {
      const rows = table.read();
      return rows.size === 0 ? null : envelopeOf(Object.fromEntries(
        [...rows].map(([deviceId, row]) => [deviceId, row.plan]),
      ));
    }),
    write: (plans) => db.transaction(() => write(plans)),
    hasImportedLegacy: () => hasLegacyImportMark(db, DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING),
    writeLegacyImport: (plans) => db.transaction(() => {
      write(plans);
      writeLegacyImportMark(db, DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING);
    }),
  };
};

/**
 * The legacy blob, through the recorder's normaliser; `null` when it is not a
 * plans envelope at all (an unknown version included), so a blob that vouches
 * for nothing keeps its key instead of being taken as "no plans".
 */
const parseLegacyActivePlans = (raw: unknown): DeferredObjectiveActivePlansV2 | null => {
  if (!isUnknownRecord(raw)
    || (raw.version !== 1 && raw.version !== DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION)) return null;
  if (!isUnknownRecord(raw.plansByDeviceId)) return null;
  return normalizeDeferredObjectiveActivePlans(raw);
};

/**
 * The one-shot import of the legacy settings key into the store, run at boot
 * before the recorder loads. Rules and their reasons:
 * `lib/store/legacySettingsImport.ts`. Only the import mark says the blob was
 * taken: a key found beside it (an unset that threw after the import) is
 * retired unread. A suspect read leaves the key for the next boot, and until
 * then the recorder re-plans from scratch. When a later boot takes the blob,
 * the plans the recorder wrote meanwhile are newer for their devices, so the
 * blob adds only the devices they do not hold.
 *
 * Delete this once no install older than the release that introduced the
 * store can still be upgraded.
 */
export const importLegacyActivePlans = (settings: SettingsPort, store: ActivePlanRepository): void => {
  const key = DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING;
  const result = importListedLegacySettingsKey(settings, key, {
    // Only the mark: the store fills from an empty boot on the first plan
    // cycle, so its rows never prove the blob was taken.
    holds: () => store.hasImportedLegacy(),
    adopt: (raw) => {
      const legacy = parseLegacyActivePlans(raw);
      if (legacy === null) return false;
      // Plans the recorder wrote since a deferred import are newer for their
      // device; the blob adds only devices they do not hold. Expired ones
      // leave through the recorder's own expiry and abandon grace.
      const stored = store.read()?.plansByDeviceId ?? {};
      store.writeLegacyImport({
        version: legacy.version,
        plansByDeviceId: { ...legacy.plansByDeviceId, ...stored },
      });
      return true;
    },
  });
  if (result.outcome === 'not_listed') return;
  if (result.outcome === 'imported') {
    storeLogger.info({ event: 'legacy_active_plans_imported', key });
  } else if (result.outcome === 'retired') {
    storeLogger.info({ event: 'legacy_active_plans_key_retired', key, reason: result.reason });
  } else {
    storeLogger.warn({
      event: 'legacy_active_plans_import_deferred',
      key,
      reason: result.reason,
      ...('error' in result && result.error !== undefined ? { err: normalizeError(result.error) } : {}),
    });
  }
};

/**
 * The recorder's load/save through `store`. A load that cannot read the store
 * seeds zero plans (the next plan cycle re-derives the live ones from
 * diagnostics); a save that cannot write is said and the recorder carries on.
 * `onSaved` hears every save attempt with the plans the recorder now holds,
 * which is what the settings UI is pushed.
 */
export const createActivePlanPersistence = (
  store: ActivePlanStore,
  onSaved: (plans: DeferredObjectiveActivePlansV2) => void,
): Pick<ActivePlanPersistDeps, 'load' | 'save'> => ({
  load: () => {
    try {
      return store.read();
    } catch (error) {
      storeLogger.warn({ event: 'deferred_objective_active_plans_load_unavailable', err: normalizeError(error) });
      return null;
    }
  },
  save: (plans) => {
    try {
      store.write(plans);
    } catch (error) {
      storeLogger.error({ event: 'deferred_objective_active_plans_persist_failed', err: normalizeError(error) });
    }
    try {
      onSaved(plans);
    } catch (error) {
      storeLogger.error({ event: 'deferred_objective_active_plans_push_failed', err: normalizeError(error) });
    }
  },
});
