import { ModePriorityCatalog, readModePriorityCatalog } from '../../../shared-domain/src/settings/modePriorities.ts';
import {
  isWritableModeDeviceTargets,
  sanitizeModeDeviceTargets,
} from '../../../shared-domain/src/settings/modeDeviceTargets.ts';

export type ModeNumberMap = Record<string, Record<string, number>>;
export type ModeNumberMapRead =
  | { state: 'resolved'; value: ModeNumberMap }
  | { state: 'unavailable' };

/** Classify an untrusted persisted priority catalog once at its API boundary. */
export const classifyModeNumberMap = (
  value: unknown,
  allowAbsent = false,
): ModeNumberMapRead => {
  if (value === undefined || value === null) {
    return allowAbsent ? { state: 'resolved', value: {} } : { state: 'unavailable' };
  }
  const priorities = readModePriorityCatalog(value);
  return priorities === null
    ? { state: 'unavailable' }
    : { state: 'resolved', value: priorities.resolve([], []) };
};

/** Validate a complete persisted mode map before any UI edit can rewrite it. */
export const parseModeNumberMap = (
  value: unknown,
  allowAbsent = false,
): ModeNumberMap | null => {
  const read = classifyModeNumberMap(value, allowAbsent);
  return read.state === 'resolved' ? read.value : null;
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
 * `parseModeNumberMap` delegates priority policy to its shared key owner.
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
 * own shared key owner's policy. The priority map is complete across known
 * catalog devices; the live roster is resolved by the owning ModePriorityCatalog.
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
  return [new ModePriorityCatalog(priorities).resolve(
    Object.values(targets).flatMap(Object.keys), Object.keys(targets),
  ), targets];
};
