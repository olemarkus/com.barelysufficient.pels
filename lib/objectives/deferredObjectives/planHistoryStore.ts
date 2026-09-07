/**
 * The smart-task plan history's rows in the userdata database, behind the
 * load/save seam the recorder persists through.
 *
 * The history is a rolling cap of finalized runs (30 entries, each a few kB
 * of observed intervals and plan snapshots) that used to ride
 * `homey.settings` as one blob under two keys — the current `_v5` envelope
 * and the v4 envelope kept for rollback. Each entry is one row keyed by its
 * id, diffed against what the store holds, so finalizing a run writes that
 * run and the one the cap retired, not the other 29. `read` answers `null`
 * when the store holds nothing. Every row re-entering from disk is a
 * persisted blob like any other and passes the recorder's own strict parser
 * on the way in; a row that does not parse or fails it is the store's own
 * damage — regenerable by ruling — so it is deleted on read and said once,
 * and never costs the rows around it.
 */
import type {
  DeferredObjectivePlanHistoryRecord,
  DeferredObjectivePlanHistoryV5,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { getLogger } from '../../logging/logger';
import type { SettingsPort } from '../../ports/homeyRuntime';
import {
  importLegacySettingsKey, isLegacySettingsKeyListed, type LegacyImportResult,
} from '../../store/legacySettingsImport';
import type { PreparedStatement, UserdataDatabase } from '../../store/userdataDatabase';
import { normalizeError } from '../../utils/errorUtils';
import {
  DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED,
  DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING,
  DEFERRED_OBJECTIVE_PLAN_HISTORY_V4_SETTING,
} from '../../utils/settingsKeys';
import { HISTORY_ENTRY_CAP } from './planHistory';
import {
  DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
  normalizeDeferredObjectivePlanHistory,
  parseDeferredObjectivePlanHistory,
} from './planHistorySettings';

const storeLogger = getLogger('deferred-objectives/plan-history-store');

export type PlanHistoryStore = {
  /** The stored history, or `null` when the store holds nothing. Throws only on I/O. */
  read(): DeferredObjectivePlanHistoryV5 | null;
  /** Persist `history`, touching only the rows that differ from what the store holds. */
  write(history: DeferredObjectivePlanHistoryV5): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deferred_objective_plan_history (
  id TEXT PRIMARY KEY NOT NULL, finalized_at_ms INTEGER NOT NULL, entry_json TEXT NOT NULL
) WITHOUT ROWID;
`;

type Statements = { upsert: PreparedStatement; remove: PreparedStatement; load: PreparedStatement };

const prepareStatements = (db: UserdataDatabase): Statements => ({
  upsert: db.prepare('INSERT INTO deferred_objective_plan_history (id, finalized_at_ms, entry_json) VALUES (?, ?, ?) '
    + 'ON CONFLICT (id) DO UPDATE SET finalized_at_ms = excluded.finalized_at_ms, entry_json = excluded.entry_json'),
  remove: db.prepare('DELETE FROM deferred_objective_plan_history WHERE id = ?'),
  load: db.prepare(
    'SELECT id, finalized_at_ms, entry_json FROM deferred_objective_plan_history ORDER BY finalized_at_ms, id',
  ),
});

const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

const parseRow = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * What a legacy blob salvages to. The recorder's strict parser refuses a
 * whole envelope for one bad entry (so a partial snapshot is never written
 * over full history); an upgrade must not leave 165 kB in settings forever
 * for the same reason, so the import drops the entries the normaliser
 * refuses and names how many, like the tracker's salvage.
 */
const salvageLegacyPlanHistory = (
  raw: unknown,
): { snapshot: DeferredObjectivePlanHistoryV5; dropped: number } | null => {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.entries)) return null;
  if (![3, 4, DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION].includes(candidate.version as number)) return null;
  const snapshot = normalizeDeferredObjectivePlanHistory(raw);
  return { snapshot, dropped: candidate.entries.length - snapshot.entries.length };
};

type Held = Map<string, DeferredObjectivePlanHistoryRecord>;
const heldOf = (history: DeferredObjectivePlanHistoryV5): Held => (
  new Map(history.entries.map((entry) => [entry.id, entry]))
);

export const createPlanHistoryStore = (db: UserdataDatabase): PlanHistoryStore => {
  db.exec(SCHEMA);
  const s = prepareStatements(db);
  let held: Held | null = null;

  /**
   * Runs inside a transaction: a row that does not parse, fails the strict
   * parser, or disagrees with its own key columns is deleted as read.
   */
  const load = (): DeferredObjectivePlanHistoryV5 | null => {
    const rows = s.load.all() as Array<{ id: string; finalized_at_ms: number; entry_json: string }>;
    if (rows.length === 0) return null;
    const entries = rows.flatMap((row) => {
      const parsed = parseDeferredObjectivePlanHistory({
        version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION, entries: [parseRow(row.entry_json)],
      });
      const entry = parsed.state === 'resolved' ? parsed.snapshot.entries[0] : undefined;
      if (entry !== undefined && entry.id === row.id && entry.finalizedAtMs === row.finalized_at_ms) return [entry];
      storeLogger.error({ event: 'deferred_objective_plan_history_row_quarantined', id: row.id });
      s.remove.run(row.id);
      return [];
    });
    return entries.length === 0 ? null : { version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION, entries };
  };

  const writeDiff = (next: Held, previous: Held | null): void => {
    for (const [id, entry] of next) {
      const before = previous?.get(id);
      if (before === undefined || !sameJson(before, entry)) {
        s.upsert.run(id, entry.finalizedAtMs, JSON.stringify(entry));
      }
    }
    for (const id of previous?.keys() ?? []) {
      if (!next.has(id)) s.remove.run(id);
    }
  };

  return {
    read: () => db.transaction(() => {
      const history = load();
      held = history === null ? null : heldOf(history);
      return history;
    }),
    write: (history) => {
      const next = heldOf(history);
      db.transaction(() => {
        // A store that has neither read nor written diffs against its rows
        // on disk, so a write can always delete what `history` dropped.
        const previous = held ?? (() => {
          const stored = load();
          return stored === null ? null : heldOf(stored);
        })();
        writeDiff(next, previous);
      });
      held = next;
    },
  };
};

/**
 * The legacy blob's entries under the store's: every id the store has is the
 * newer truth, and the result keeps the recorder's rolling cap — the newest
 * entries by finalisation, as the recorder itself would trim.
 */
const withLegacyUnder = (
  stored: DeferredObjectivePlanHistoryV5,
  legacy: DeferredObjectivePlanHistoryV5,
): DeferredObjectivePlanHistoryV5 => {
  const storedIds = new Set(stored.entries.map((entry) => entry.id));
  const merged = [...stored.entries, ...legacy.entries.filter((entry) => !storedIds.has(entry.id))]
    .sort((a, b) => a.finalizedAtMs - b.finalizedAtMs);
  return {
    version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
    entries: merged.slice(Math.max(0, merged.length - HISTORY_ENTRY_CAP)),
  };
};

const logImport = (key: string, result: LegacyImportResult): void => {
  if (result.outcome === 'imported') {
    storeLogger.info({ event: 'legacy_plan_history_imported', key });
  } else if (result.outcome === 'retired') {
    storeLogger.info({ event: 'legacy_plan_history_key_retired', key, reason: result.reason });
  } else if (result.error === undefined) {
    storeLogger.warn({ event: 'legacy_plan_history_import_deferred', key, reason: result.reason });
  } else {
    storeLogger.warn({
      event: 'legacy_plan_history_import_deferred', key, reason: result.reason, err: normalizeError(result.error),
    });
  }
};

/**
 * The one-shot import of the legacy plan-history settings blobs into the
 * store, run at boot before the recorder loads: the current `_v5` key, then
 * the v4 key that was kept for rollback, each merged UNDER what the store
 * holds, then unset together with the `_v5_initialized` marker. Rules and
 * their reasons: `lib/store/legacySettingsImport.ts`.
 */
export const importLegacyPlanHistory = (settings: SettingsPort, store: PlanHistoryStore): void => {
  for (const key of [DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING, DEFERRED_OBJECTIVE_PLAN_HISTORY_V4_SETTING]) {
    if (isLegacySettingsKeyListed(settings, key) !== true) continue;
    let dropped = 0;
    const result = importLegacySettingsKey(settings, key, {
      holds: () => false,
      adopt: (raw) => {
        const salvaged = salvageLegacyPlanHistory(raw);
        if (salvaged === null) return false;
        const stored = store.read();
        store.write(stored === null ? salvaged.snapshot : withLegacyUnder(stored, salvaged.snapshot));
        dropped = salvaged.dropped;
        return true;
      },
    });
    if (result.outcome === 'imported' && dropped > 0) {
      storeLogger.error({ event: 'legacy_plan_history_import_salvaged', key, dropped });
    }
    logImport(key, result);
  }
  // The marker only ever said "the `_v5` key has been written once"; with
  // the key gone it says nothing. Best-effort, like every unset here.
  if (isLegacySettingsKeyListed(settings, DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED) !== true) return;
  if (isLegacySettingsKeyListed(settings, DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING) !== false) return;
  try {
    settings.unset(DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED);
  } catch {
    /* retried next boot */
  }
};
