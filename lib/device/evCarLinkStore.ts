/**
 * The EV car-to-charger link probe's state in the userdata database: its
 * repository, the one-shot import of the legacy settings blob, and the
 * in-memory access the probe reads and writes through.
 *
 * Learned data lives there by ruling (`notes/settings-key-ownership.md`
 * § "Which store a key lives in"). The snapshot is three families — pair votes,
 * per-car stop samples, open sessions — and each is one JSON row, diffed, so a
 * vote rewrites the pairs and nothing else. Every accepted change is written
 * as it is set: nothing is buffered, so a restart (or an OOM kill) loses no
 * vote, and nothing needs a debounce, dirty flag or flush.
 *
 * Losing this state is not a correctness problem for the probe (votes simply
 * re-accumulate), but it would reset the observed-charge-limit samples, which
 * is exactly the multi-session evidence the probe exists to gather.
 */
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import { createJsonRowTable } from '../store/jsonRowTable';
import {
    hasLegacyImportMark,
    importLegacySettingsKey,
    isLegacySettingsKeyListed,
    writeLegacyImportMark,
} from '../store/legacySettingsImport';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { normalizeError } from '../utils/errorUtils';
import { EV_CAR_LINK_STATE } from '../utils/settingsKeys';
import type { EvCarLinkSnapshotAccess } from './evCarLinkWiring';
import {
    createEmptyEvCarLinkSnapshot,
    EV_CAR_LINK_VERSION,
    normalizeEvCarLinkSnapshot,
    normalizeLegacyEvCarLinkSnapshot,
    pruneEvCarLinkSnapshot,
    withLegacyEvCarLinkUnder,
} from './evCarLinkSnapshot';

const moduleLogger = getLogger('device/ev-car-link-store');

const FAMILIES: ReadonlySet<string> = new Set(['pairs', 'cars', 'sessions']);

export type EvCarLinkRepository = {
    /**
     * What the store holds, normalised and with records past the retention
     * window pruned; `null` when it holds nothing. Throws only on I/O.
     */
    read(nowMs: number): EvCarLinkSnapshot | null;
    /** Persist `snapshot`, touching only the families that differ from what the store holds. */
    write(snapshot: EvCarLinkSnapshot): void;
    /** Whether the legacy `ev_car_link_state` blob was imported into the store. Throws only on I/O. */
    hasImportedLegacy(): boolean;
    /** {@link write} the snapshot the legacy import made and mark the import, in one transaction. */
    writeLegacyImport(snapshot: EvCarLinkSnapshot): void;
};

export const createEvCarLinkRepository = (db: UserdataDatabase): EvCarLinkRepository => {
    // A family row that is not a record is the store's own damage; one that is
    // has its malformed records dropped by the normaliser on read.
    const families = createJsonRowTable(db, 'ev_car_link_state', ['family', 'value_json'], (value, key) => (
        FAMILIES.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
    ));
    const writeFamilies = (snapshot: EvCarLinkSnapshot): void => families.write(new Map<string, object>([
        ['pairs', snapshot.pairs],
        ['cars', snapshot.cars],
        ['sessions', snapshot.sessions],
    ]));
    return {
        read: (nowMs) => {
            const rows = db.transaction(() => families.read());
            if (rows.size === 0) return null;
            const snapshot = normalizeEvCarLinkSnapshot({
                version: EV_CAR_LINK_VERSION,
                pairs: rows.get('pairs') ?? {},
                cars: rows.get('cars') ?? {},
                sessions: rows.get('sessions') ?? {},
            }, nowMs);
            // Pruned on read rather than on a timer: pair records accumulate only
            // through device churn across restarts, so boot is exactly when stale
            // ones appear. The pruned families are written at the next change.
            return snapshot === null ? null : pruneEvCarLinkSnapshot(snapshot, nowMs);
        },
        write: (snapshot) => db.transaction(() => writeFamilies(snapshot)),
        hasImportedLegacy: () => hasLegacyImportMark(db, EV_CAR_LINK_STATE),
        writeLegacyImport: (snapshot) => db.transaction(() => {
            writeFamilies(snapshot);
            writeLegacyImportMark(db, EV_CAR_LINK_STATE);
        }),
    };
};

/**
 * The one-shot import of the legacy `ev_car_link_state` settings blob into the
 * store, run at boot before the store is read. Rules and their reasons:
 * `lib/store/legacySettingsImport.ts`. The probe writes from an empty boot (a
 * deferred import still lets it vote), so "the store holds rows" never retires
 * the key: the blob goes under what the store holds instead. Only the import's
 * own mark retires it: an import whose unset failed must not merge the blob
 * again, which would bring back the stops of a charge limit disproven since
 * (`clearEvCarObservedStops`).
 *
 * Answers whether the store holds the probe's whole history: not while a
 * suspect read, or a key list that could not be read, leaves the blob unread,
 * unless an import already completed. A blob with no snapshot in it, or whose
 * every entry is malformed, holds no history, so it does not count.
 */
export const importLegacyEvCarLinkState = (
    settings: SettingsPort,
    repository: EvCarLinkRepository,
    nowMs: number,
): boolean => {
    const listed = isLegacySettingsKeyListed(settings, EV_CAR_LINK_STATE);
    if (listed === false) return true;
    // An unreadable key list says nothing about the blob: retried next boot,
    // and only a completed import says the store holds it.
    if (listed === null) return hasImported(repository);
    const result = importLegacySettingsKey(settings, EV_CAR_LINK_STATE, {
        holds: () => repository.hasImportedLegacy(),
        adopt: (raw) => {
            const normalized = normalizeLegacyEvCarLinkSnapshot(raw, nowMs);
            if (normalized === null) return false;
            const legacy = pruneEvCarLinkSnapshot(normalized, nowMs);
            const stored = repository.read(nowMs);
            repository.writeLegacyImport(stored === null ? legacy : withLegacyEvCarLinkUnder(stored, legacy));
            return true;
        },
    });
    if (result.outcome === 'imported') {
        moduleLogger.info({ event: 'legacy_ev_car_link_state_imported' });
    } else if (result.outcome === 'retired') {
        moduleLogger.info({ event: 'legacy_ev_car_link_state_key_retired', reason: result.reason });
    } else {
        moduleLogger.warn({
            event: 'legacy_ev_car_link_state_import_deferred',
            reason: result.reason,
            ...(result.error === undefined ? {} : { err: normalizeError(result.error) }),
        });
    }
    return result.outcome !== 'deferred' || result.reason === 'not_a_value' || result.reason === 'unset_threw'
        || hasImported(repository);
};

/** Whether an import completed on an earlier boot; a store that cannot say has not shown one. */
const hasImported = (repository: EvCarLinkRepository): boolean => {
    try {
        return repository.hasImportedLegacy();
    } catch {
        return false;
    }
};

/**
 * The probe's snapshot, read once from the store and written through on every
 * change. A write that fails keeps the change in memory, and the next write
 * carries it too: the diff base is what the database last committed.
 * `historyResolved` is what the legacy import answered.
 */
export const createPersistedEvCarLinkAccess = (
    repository: EvCarLinkRepository,
    nowMs: number,
    historyResolved: boolean,
): EvCarLinkSnapshotAccess => {
    let snapshot = repository.read(nowMs) ?? createEmptyEvCarLinkSnapshot();
    return {
        historyResolved,
        get: () => snapshot,
        set: (next) => {
            if (next === snapshot) return;
            snapshot = next;
            try {
                repository.write(next);
            } catch (error) {
                moduleLogger.error({ event: 'ev_car_link_persist_failed', err: normalizeError(error) });
            }
        },
    };
};
