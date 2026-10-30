/**
 * The settings key list, classified. `getKeys()` is the only read that tells a
 * key never written from one listed but unreadable, so every reader that owns
 * absence goes through here.
 *
 * PELS always has settings keys, so an empty list is the transient-empty-store
 * flake rather than a store with nothing in it
 * (`notes/persisted-settings-state.md`), with one exception: the first read of
 * a boot, before any startup step writes, which `classifyInstallAtBoot` makes. The SDK has returned nullish and
 * malformed values here as well as throwing, so the value is classified before
 * any array operation.
 */
export type SettingsKeyListRead =
  | { status: 'resolved'; keys: readonly string[] }
  | { status: 'unavailable' };

export const readSettingsKeyList = (settings: { getKeys(): unknown }): SettingsKeyListRead => {
  let raw: unknown;
  try {
    raw = settings.getKeys();
  } catch {
    return { status: 'unavailable' };
  }
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((key) => typeof key === 'string')) {
    return { status: 'unavailable' };
  }
  return { status: 'resolved', keys: raw };
};

/** Whether this boot is the first of a new install. */
export type InstallAtBoot = 'new' | 'existing';

/**
 * The one empty list that concludes something: read first in boot, before any
 * startup step writes a key, it means nothing was ever written, so the install
 * is new. The flake looks the same, so an existing install can be misread as
 * new; the one consumer (`lib/power/capacityMarketDefault.ts`) accepts that. A
 * read that throws or answers malformed changes nothing.
 */
export const classifyInstallAtBoot = (settings: { getKeys(): unknown }): InstallAtBoot => {
  let raw: unknown;
  try {
    raw = settings.getKeys();
  } catch {
    return 'existing';
  }
  return Array.isArray(raw) && raw.length === 0 ? 'new' : 'existing';
};
