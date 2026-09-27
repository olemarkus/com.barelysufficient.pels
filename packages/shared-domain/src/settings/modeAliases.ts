/**
 * The mode_aliases setting: one read policy shared by the runtime and settings UI.
 * A malformed catalog is unavailable; malformed individual entries are ignored.
 */
export type ModeAliases = Record<string, string>;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const readModeAliases = (value: unknown): ModeAliases | null => {
  if (!isPlainRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).flatMap(([key, alias]) => (
    typeof alias === 'string' ? [[key.toLowerCase(), alias]] : []
  )));
};
