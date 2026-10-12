/**
 * One settings key's one-shot move into the userdata store, classified.
 *
 * Every family that leaves `homey.settings` for the store ships with its
 * import, so an install upgrading from the last settings-blob release keeps
 * its history (`notes/settings-key-ownership.md` § "Which store a key lives
 * in"). The rules are the same for every key; only what "the store already
 * holds this" and "adopt this value" mean belong to the family, so the
 * family hands those in and logs the outcome under its own event names.
 *
 * - the store already holds the family → the blob is stale; the key is unset.
 *   A family whose store can fill from an EMPTY boot (the collector's grace
 *   window writes after five minutes, the tracker's prune after ten seconds)
 *   must not answer `holds` from "the store has rows": a deferred import
 *   followed by one such write would retire the blob unread on the next
 *   boot. Those families merge the blob UNDER what the store holds in `adopt`
 *   instead, and answer `holds` either `false` or, where importing the same
 *   blob twice would bring back what the store has since dropped on purpose
 *   or count again what it has already added up, from the import mark
 *   (`hasLegacyImportMark`) that `adopt` writes in the same transaction as the
 *   rows, so only a completed import retires the key;
 * - the store is empty and the value adopts → the key is unset;
 * - a suspect read — a listed key answering empty, a value the family finds
 *   nothing usable in, a throwing SDK, a store that cannot be read or
 *   written, a throwing unset — leaves the key for the next boot. A listed
 *   key reading back malformed is a failed read, not an affirmative absence
 *   (`notes/persisted-settings-state.md`); one transient must never cost the
 *   history, and a blob that is truly garbage costs its bytes, never the key.
 */
import type { SettingsPort } from '../ports/homeyRuntime';
import type { UserdataDatabase } from './userdataDatabase';

export type LegacyImportTarget = {
  /** Whether the store already holds this key's family. Throws on I/O. */
  holds(): boolean;
  /** Write the raw value into the store; `false` when it holds nothing usable. Throws on I/O. */
  adopt(raw: unknown): boolean;
};

/**
 * What a store whose one legacy key is retired by the import mark adds to its
 * own port, for that import alone. Both throw only on I/O.
 */
export type MarkedLegacyImport<T> = {
  /** Whether the legacy key was imported into the store ({@link hasLegacyImportMark}). */
  hasImportedLegacy(): boolean;
  /** Write `value` as the store's write does, and the import mark, in one transaction. */
  writeLegacyImport(value: T): void;
};

export type LegacyImportResult =
  | { outcome: 'imported' }
  | { outcome: 'retired'; reason: 'store_already_holds' }
  | {
    outcome: 'deferred';
    reason:
      | 'read_threw' | 'listed_key_empty' | 'store_unreadable' | 'not_a_value' | 'store_write_failed' | 'unset_threw';
    error?: unknown;
  };

const attempt = (settings: SettingsPort, key: string, target: LegacyImportTarget): LegacyImportResult => {
  let raw: unknown;
  try {
    raw = settings.get(key);
  } catch (error) {
    return { outcome: 'deferred', reason: 'read_threw', error };
  }
  // A listed key that answers empty is the SDK omission the abandon-grace
  // rule names: not evidence of anything, and never a reason to unset.
  if (raw === undefined || raw === null) return { outcome: 'deferred', reason: 'listed_key_empty' };
  let held: boolean;
  try {
    held = target.holds();
  } catch (error) {
    return { outcome: 'deferred', reason: 'store_unreadable', error };
  }
  if (held) {
    settings.unset(key);
    return { outcome: 'retired', reason: 'store_already_holds' };
  }
  let adopted: boolean;
  try {
    adopted = target.adopt(raw);
  } catch (error) {
    return { outcome: 'deferred', reason: 'store_write_failed', error };
  }
  if (!adopted) return { outcome: 'deferred', reason: 'not_a_value' };
  settings.unset(key);
  return { outcome: 'imported' };
};

/** Import one legacy key. Present in the key list or not, the key itself decides nothing: `settings.get` does. */
export const importLegacySettingsKey = (
  settings: SettingsPort,
  key: string,
  target: LegacyImportTarget,
): LegacyImportResult => {
  try {
    return attempt(settings, key, target);
  } catch (error) {
    // The unset threw after the store took the value (or already held it).
    // A family whose `holds` answers from the import mark retires the key on
    // the next boot; one whose `holds` answers `false` imports the blob again,
    // under what the store holds by then.
    return { outcome: 'deferred', reason: 'unset_threw', error };
  }
};

const importMarkKey = (key: string): string => `legacy_import:${key}`;

/**
 * Whether the legacy `key` was imported into `db`: the row
 * {@link writeLegacyImportMark} leaves in the database's `meta` table. Throws
 * only on I/O.
 */
export const hasLegacyImportMark = (db: UserdataDatabase, key: string): boolean => (
  db.prepare('SELECT 1 AS marked FROM meta WHERE key = ?').get(importMarkKey(key)) !== undefined
);

/**
 * Record that the legacy `key` was imported into `db`. Call it inside the
 * transaction that writes the imported rows, so the mark and the rows commit
 * together or not at all. Throws only on I/O.
 */
export const writeLegacyImportMark = (db: UserdataDatabase, key: string): void => {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING')
    .run(importMarkKey(key), 'imported');
};

/**
 * Whether the settings still list `key`: the question every import asks
 * first, so an install that has imported (or never had the key) does not
 * report a deferral on every boot. `null` when the list cannot be read
 * ({@link listLegacySettingsKeys}).
 */
export const isLegacySettingsKeyListed = (settings: SettingsPort, key: string): boolean | null => {
  const keys = listLegacySettingsKeys(settings, (candidate) => candidate === key);
  return keys === null ? null : keys.length > 0;
};

/**
 * The keys a legacy family still has in settings; `null` when the list itself
 * cannot be read, which concludes nothing: a boot import tries again next
 * boot, a reader on its next read. An empty list is one that was not read:
 * PELS always has settings keys once the boot migrations have run, so an
 * empty `getKeys()` is the SDK's flake or a fresh install's first boot, and
 * never says a key is gone (`notes/persisted-settings-state.md`).
 */
export const listLegacySettingsKeys = (
  settings: SettingsPort,
  matches: (key: string) => boolean,
): string[] | null => {
  try {
    const keys = settings.getKeys();
    return keys.length === 0 ? null : keys.filter(matches);
  } catch {
    return null;
  }
};
