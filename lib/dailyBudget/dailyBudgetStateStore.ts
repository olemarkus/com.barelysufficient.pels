/**
 * The daily budget's persisted state in the userdata database, behind the port
 * the service persists through.
 *
 * The state is the day's plan (its date, the hourly allocation and its split,
 * whether it is frozen, and the lock and usage marks a rebuild reads) and what
 * the budget has learned: the hourly profiles and the observed hourly
 * statistics. About 8 kB of it rode `homey.settings` as one blob, written
 * several times an hour. All of it is regenerable (a lost plan is rebuilt at
 * the next update and the profiles re-learn), so it lives here by ruling
 * (`notes/settings-key-ownership.md` § "Which store a key lives in"). Each
 * field is one JSON row, diffed against what the store holds, so a routine
 * persist rewrites the marks that moved and not the 24-hour arrays around them.
 *
 * `read` answers the typed state, validated once here, or `null` when the
 * store holds nothing usable: an affirmative answer, unlike the settings blob's
 * absence. A row that does not parse is the store's own damage: it is deleted
 * on read and said once, so it neither costs the rows around it nor lingers to
 * be re-logged on every boot. Rows that parse but do not make a daily-budget
 * state (a field of the wrong shape) are said too, and read as `null`; the
 * next persist replaces them, since the diff base is still the rows on disk.
 */
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import { importLegacySettingsKey, isLegacySettingsKeyListed } from '../store/legacySettingsImport';
import type { PreparedStatement, UserdataDatabase } from '../store/userdataDatabase';
import { normalizeError } from '../utils/errorUtils';
import { DAILY_BUDGET_STATE } from '../utils/settingsKeys';
import { resolveProfileSampleCount } from './dailyBudgetLearning';
import { isDailyBudgetState } from './dailyBudgetManagerTypes';
import type { DailyBudgetState } from './dailyBudgetTypes';

const storeLogger = getLogger('daily-budget/state-store');

/**
 * Port over the persisted daily-budget state, the companion to
 * {@link DailyBudgetSettingsStore}, which owns the configuration keys. The
 * service receives this typed store and never touches persistence itself;
 * `createDailyBudgetStateStore` below is its one production implementation.
 */
export type DailyBudgetStateStore = {
  /** The stored state, or `null` when the store holds nothing usable. Throws only on I/O. */
  read(): DailyBudgetState | null;
  /** Persist `state`, touching only the fields that differ from what the store holds. */
  write(state: DailyBudgetState): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_budget_state_fields (
  key TEXT PRIMARY KEY NOT NULL, value_json TEXT NOT NULL
) WITHOUT ROWID;
`;

type Statements = { upsert: PreparedStatement; remove: PreparedStatement; load: PreparedStatement };

const prepareStatements = (db: UserdataDatabase): Statements => ({
  upsert: db.prepare('INSERT INTO daily_budget_state_fields (key, value_json) VALUES (?, ?) '
    + 'ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json'),
  remove: db.prepare('DELETE FROM daily_budget_state_fields WHERE key = ?'),
  load: db.prepare('SELECT key, value_json FROM daily_budget_state_fields'),
});

const parseRow = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The fields as JSON, by name: the diff base of the next write. JSON rather
 * than the values, because the manager's arrays are not guaranteed to be
 * replaced rather than changed in place between two persists.
 */
type Held = Map<string, string>;

const heldOf = (fields: object): Held => new Map(Object.entries(fields).flatMap(
  ([key, value]: [string, unknown]): Array<[string, string]> => (
    value === undefined ? [] : [[key, JSON.stringify(value)]]
  ),
));

export const createDailyBudgetStateStore = (db: UserdataDatabase): DailyBudgetStateStore => {
  db.exec(SCHEMA);
  const s = prepareStatements(db);
  let held: Held | null = null;

  /** Runs inside a transaction: an unparseable row is deleted as it is read. */
  const load = (): Record<string, unknown> | null => {
    const rows = s.load.all() as Array<{ key: string; value_json: string }>;
    const fields = Object.fromEntries(rows.flatMap((row) => {
      const value = parseRow(row.value_json);
      if (value !== undefined) return [[row.key, value] as const];
      storeLogger.error({ event: 'daily_budget_state_row_quarantined', key: row.key });
      s.remove.run(row.key);
      return [];
    }));
    return Object.keys(fields).length === 0 ? null : fields;
  };

  const writeDiff = (next: Held, previous: Held | null): void => {
    for (const [key, json] of next) {
      if (previous?.get(key) !== json) s.upsert.run(key, json);
    }
    for (const key of previous?.keys() ?? []) {
      if (!next.has(key)) s.remove.run(key);
    }
  };

  return {
    read: () => db.transaction(() => {
      const fields = load();
      held = fields === null ? null : heldOf(fields);
      if (fields === null || isDailyBudgetState(fields)) return fields;
      storeLogger.error({ event: 'daily_budget_state_rejected', fields: Object.keys(fields) });
      return null;
    }),
    write: (state) => {
      const next = heldOf(state);
      db.transaction(() => {
        // A store that has neither read nor written diffs against its rows
        // on disk, so a write can always delete what `state` dropped.
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
 * What the budget has learned, as opposed to the day's plan: every learned
 * field of {@link DailyBudgetState} is named `profile…`. That is the profiles
 * and their sample counts, and the observed hourly statistics with the config
 * key they were computed under; the rest describe the day's plan.
 */
const isLearnedField = (key: string): boolean => key.startsWith('profile');

const fieldsWhere = (state: DailyBudgetState, learned: boolean): DailyBudgetState => (
  Object.fromEntries(Object.entries(state).filter(([key]) => isLearnedField(key) === learned))
);

/**
 * The legacy blob UNDER what the store holds, each part taken whole so no
 * plan or profile is stitched from two sources. The store's plan is the newer
 * day and always wins. The learned fields come from whichever side has
 * learned more days: a boot whose import deferred lets the service write a
 * fresh, unlearned state within minutes, and that must not cost the weeks of
 * profile the blob holds. The one case this cannot tell apart is an owner
 * resetting the learning while the import is still pending: the import brings
 * the blob's profile back, and the reset has to be made again.
 */
const withLegacyUnder = (stored: DailyBudgetState, legacy: DailyBudgetState): DailyBudgetState => ({
  ...fieldsWhere(stored, false),
  ...fieldsWhere(resolveProfileSampleCount(legacy) > resolveProfileSampleCount(stored) ? legacy : stored, true),
});

/**
 * The one-shot import of the legacy `daily_budget_state` settings blob into
 * the store, run at boot before the service loads. Rules and their reasons:
 * `lib/store/legacySettingsImport.ts`. The store fills from an empty boot (the
 * service persists within minutes), so "the store holds rows" never retires
 * the key: the blob goes under whatever the store holds instead.
 */
export const importLegacyDailyBudgetState = (settings: SettingsPort, store: DailyBudgetStateStore): void => {
  if (isLegacySettingsKeyListed(settings, DAILY_BUDGET_STATE) !== true) return;
  const result = importLegacySettingsKey(settings, DAILY_BUDGET_STATE, {
    holds: () => false,
    adopt: (raw) => {
      if (!isDailyBudgetState(raw)) return false;
      const stored = store.read();
      store.write(stored === null ? raw : withLegacyUnder(stored, raw));
      return true;
    },
  });
  if (result.outcome === 'imported') {
    storeLogger.info({ event: 'legacy_daily_budget_state_imported' });
  } else if (result.outcome === 'retired') {
    storeLogger.info({ event: 'legacy_daily_budget_state_key_retired', reason: result.reason });
  } else {
    storeLogger.warn({
      event: 'legacy_daily_budget_state_import_deferred',
      reason: result.reason,
      ...(result.error === undefined ? {} : { err: normalizeError(result.error) }),
    });
  }
};
