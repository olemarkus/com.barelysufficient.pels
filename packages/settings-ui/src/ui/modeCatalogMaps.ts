import {
  isWritableModeDeviceTargets,
  sanitizeModeDeviceTargets,
} from '../../../shared-domain/src/settings/modeDeviceTargets.ts';

export type ModeNumberMap = Record<string, Record<string, number>>;

/** Validate a complete persisted mode map before any UI edit can rewrite it. */
export const parseModeNumberMap = (
  value: unknown,
  allowAbsent = false,
): ModeNumberMap | null => {
  if (value === undefined || value === null) return allowAbsent ? {} : null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const modes = Object.entries(value as Record<string, unknown>);
  if (!modes.every(([, entries]) => (
    entries
    && typeof entries === 'object'
    && !Array.isArray(entries)
    && Object.values(entries).every((entry) => (
      typeof entry === 'number' && Number.isFinite(entry)
    ))
  ))) return null;
  return value as ModeNumberMap;
};


/**
 * `mode_device_targets` as this surface reads it: the key's own sanitize policy
 * (`sanitizeModeDeviceTargets`, shared with the runtime), plus the absence rule
 * that belongs to the caller.
 *
 * Absence stays here rather than in the shared module because the two sides
 * cannot answer it the same way: the runtime cross-checks `getKeys()` to tell
 * "never written" from "read failed", and this surface, reading over the Homey
 * API bridge, cannot. `null` means "do not proceed", never "empty catalog".
 *
 * `parseModeNumberMap` above still serves `capacity_priorities`, which has not
 * been moved to a key owner yet and keeps the older reject-the-whole-map policy.
 */
export const readModeDeviceTargetsSetting = (
  value: unknown,
  allowAbsent: boolean,
): ModeNumberMap | null => {
  if (value === undefined || value === null) return allowAbsent ? {} : null;
  return sanitizeModeDeviceTargets(value);
};

/**
 * The only way this surface writes `mode_device_targets`.
 *
 * Refuses a catalog the key's owner would call unwritable, so a malformed blob
 * can never originate from a PELS edit — the reader tolerates one because the
 * store may already hold one, not because we may create one. Throwing (rather
 * than silently dropping the write) keeps the caller's existing error path: the
 * mode screens already surface a toast on a failed save.
 */
export const assertWritableModeDeviceTargets = (catalog: unknown): ModeNumberMap => {
  if (!isWritableModeDeviceTargets(catalog)) throw new Error('Refusing to save a malformed mode catalog');
  return catalog;
};

/**
 * The catalog pair a mode screen edits: priorities and targets, each through its
 * own key's policy. Priorities still use the older reject-the-whole-map parser
 * (`capacity_priorities` has no owner module yet); targets go through theirs.
 * Throws when either is unusable, which is the callers' existing error path.
 */
export const readModeCatalogPair = (
  prioritiesRaw: unknown,
  targetsRaw: unknown,
  allowAbsent: boolean,
): readonly [ModeNumberMap, ModeNumberMap] => {
  const priorities = parseModeNumberMap(prioritiesRaw, allowAbsent);
  const targets = readModeDeviceTargetsSetting(targetsRaw, allowAbsent);
  if (priorities === null || targets === null) throw new Error('Mode catalog unavailable');
  return [priorities, targets];
};
