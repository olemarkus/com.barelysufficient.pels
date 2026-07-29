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

export const parseRequiredModeMaps = (
  first: unknown,
  second: unknown,
  allowAbsent: boolean,
): readonly [ModeNumberMap, ModeNumberMap] => {
  const firstMap = parseModeNumberMap(first, allowAbsent);
  const secondMap = parseModeNumberMap(second, allowAbsent);
  if (firstMap === null || secondMap === null) throw new Error('Mode catalog unavailable');
  return [firstMap, secondMap];
};
