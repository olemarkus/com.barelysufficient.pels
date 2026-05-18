export const DEFAULT_MODE_NAME = 'Home';

export const resolveModeName = (mode: string): string => mode.trim() || DEFAULT_MODE_NAME;

// Settings "active mode" summary uses an English structural prefix so the
// untranslated mode name (often user-authored, e.g. `Hjemme`) never has the
// word "mode" appended mid-phrase. See `notes/ui-terminology.md` § "Mode label".
//
// Lives in shared-domain so runtime logging can emit the same phrasing as the
// UI without crossing the settings-ui boundary (see CLAUDE.md § "Hard rules").
//
// An "intent" line (`Hjemme · holding the house under 12 kW until 23:00`) was
// proposed for v2.7.3 but deferred: PELS does not yet persist intent text
// alongside modes, so shipping the optional parameter would have added an
// unused production-code branch. Tracked in TODO.md.
export const formatModeSummary = (mode: string): string => `Mode: ${resolveModeName(mode)}`;
