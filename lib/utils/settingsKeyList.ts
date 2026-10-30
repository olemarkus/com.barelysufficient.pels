/**
 * The settings key list, classified. `getKeys()` is the only read that tells a
 * key never written from one listed but unreadable, so every reader that owns
 * absence goes through here.
 *
 * The SDK answers it from the settings it loaded before `onInit`, so an empty
 * list is a store with nothing in it, not a failed read
 * (`notes/persisted-settings-state.md`). Only a throw or a malformed answer
 * concludes nothing, and the value is classified before any array operation.
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
  if (!Array.isArray(raw) || !raw.every((key) => typeof key === 'string')) {
    return { status: 'unavailable' };
  }
  return { status: 'resolved', keys: raw };
};

/** Whether this boot is the first of a new install. */
export type InstallAtBoot = 'new' | 'existing';

/**
 * Read first in boot, before any startup step writes a key, an empty list means
 * nothing was ever written, so the install is new. A read that throws or
 * answers malformed changes nothing.
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
