// Display label for a stored stepped-load step id.
//
// Extracted from `planSteppedCardText.ts` so `planReasonFormatting.ts` can name a
// step in user-facing reason copy without importing the stepped card module,
// which imports the formatter back (a cycle `arch:check` forbids).
//
// Match stored ampere step ids like `6a`, `16a`, `32a` (digits followed by a
// lowercase `a`). The persisted stepId is the contract surface — log schemas,
// plan signatures, and downstream consumers all read it — so this helper only
// changes the *display* string for human-facing surfaces (step rail, status
// lines, reason lines). Numeric values are returned as `"N A"` (uppercase
// ampere, separated with a space per the SI unit convention) so the label cannot
// read as `"6 am"`.
const AMPERE_STEP_PATTERN = /^([0-9]+)a$/i;

const capitalize = (s: string): string => (
  s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`
);

export const formatStepDisplayLabel = (stepId: string): string => {
  const trimmed = stepId.trim();
  if (trimmed.length === 0) return '';
  const match = AMPERE_STEP_PATTERN.exec(trimmed);
  if (match) return `${match[1]} A`;
  // Humanize underscore-delimited ids so an internal token never surfaces raw:
  // the device-detail editor's default new-step id `step_2` renders `Step 2`,
  // not `Step_2`. Named/level ids (`low`, `max`) carry no underscore and are
  // just capitalized.
  return capitalize(trimmed.replace(/_+/g, ' '));
};
