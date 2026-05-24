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
export const formatDisplayDeviceName = (name: string): string => name.trim();
