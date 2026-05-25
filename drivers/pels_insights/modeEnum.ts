export type ModeEnumValue = { id: string; title: { en: string } };

// Matches the app's in-memory default for `operatingMode` (app.ts).
const DEFAULT_MODE = 'Home';

export function buildModeEnumValues(activeMode: string, configuredModes: Iterable<string>): ModeEnumValue[] {
  const trimmedActive = activeMode.trim();
  const trimmedConfigured = [...configuredModes]
    .map((mode) => mode.trim())
    .filter((mode) => mode.length > 0);
  // When the user has not yet picked a mode, fall back to the first configured
  // mode so we never invent a lowercase 'home' option that collides with a
  // user-configured 'Home' (priorities/targets are keyed case-sensitively).
  const fallback = trimmedConfigured[0] ?? DEFAULT_MODE;
  const ordered = [trimmedActive || fallback, ...trimmedConfigured];
  const seen = new Set<string>();
  return ordered.flatMap((name) => {
    if (seen.has(name)) return [];
    seen.add(name);
    return [{ id: name, title: { en: name } }];
  });
}
