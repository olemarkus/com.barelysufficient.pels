// Display-side normalization for device names. Homey lets users type device
// names freely, so values can carry leading or trailing whitespace (live-walk
// 2026-05-16 surfaced `aria-label="Open device details for Termostat gang "`
// and several similar trailing-space cases). Trimming on display avoids
// awkward screen-reader pauses and keeps aria-labels tight without mutating
// stored state — the source of truth stays whatever Homey reports.
//
// Trim both ends rather than only `trimEnd()`: leading whitespace isn't
// legitimate in practice either, and `.trim()` matches the behavior of the
// existing `.trim() || fallback` callsites in `deadlineLabels.ts` and
// `deadlinesListHero.ts`. Internal whitespace ("bad tredje") is preserved.
//
// Display-only: never call from write/storage paths. Persisted names stay
// verbatim so the next read still sees what Homey gave us.
//
// A trailing "(null)" / "(undefined)" parenthetical is a stringified absent
// value leaked by an upstream device app (live-walk 2026-08-08 surfaced a car
// named "Polestar 3 (null)" — the app interpolated a missing license plate).
// It is never user-intended content, so displays drop it.
const STRINGIFIED_ABSENT_SUFFIX = /\s*\((?:null|undefined)\)\s*$/iu;

export const formatDisplayDeviceName = (name: string): string => {
  const stripped = name.replace(STRINGIFIED_ABSENT_SUFFIX, '').trim();
  // A name that IS the artifact ("(null)") must not strip to an empty title;
  // the verbatim name is the lesser evil.
  return stripped === '' ? name.trim() : stripped;
};
