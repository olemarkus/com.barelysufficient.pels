/**
 * The settings key list, classified. `getKeys()` is the only read that tells a
 * key never written from one listed but unreadable, so every reader that owns
 * absence goes through here.
 *
 * PELS always has settings keys, so an empty list is the transient-empty-store
 * flake rather than a store with nothing in it
 * (`notes/persisted-settings-state.md`). The SDK has returned nullish and
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
