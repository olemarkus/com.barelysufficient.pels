// Value and unit formatting shared by every smart-task surface: goal values,
// current readings, progress values and the approximation glyph.
import type {
  DeferredObjectiveSettingsKind,
  DeferredObjectiveUnit,
} from '../../../contracts/src/deferredObjectiveSettings';

const SMART_TASK_UNKNOWN_NOW_VALUE_LINE: Record<DeferredObjectiveSettingsKind, string> = {
  ev_soc: 'Charge level unknown',
  temperature: 'Temperature unknown',
  // An energy task counts from when it starts, so before then nothing is delivered.
  energy: 'Nothing delivered yet',
};

export const formatSmartTaskUnknownNowValueLine = (
  kind: DeferredObjectiveSettingsKind,
): string => SMART_TASK_UNKNOWN_NOW_VALUE_LINE[kind];

// "currently 18.5 °C" / "currently 45 %" line shown on Smart-tasks list cards
// so users can answer "what's at risk?" without tapping in. Lives in
// shared-domain because the same phrasing also feeds runtime log breadcrumbs
// (per `feedback_ui_text_shared_with_logs.md`). Returns `null` when the
// current value is unknown so the line is suppressed cleanly.
export const formatSmartTaskCurrentValueLine = (params: {
  kind: DeferredObjectiveSettingsKind;
  currentValue: number | null;
}): string | null => {
  if (params.currentValue === null || !Number.isFinite(params.currentValue)) return null;
  if (params.kind === 'temperature') {
    return `currently ${params.currentValue.toFixed(1)} °C`;
  }
  if (params.kind === 'energy') {
    return `${params.currentValue.toFixed(1)} kWh delivered so far`;
  }
  return `currently ${Math.round(params.currentValue)} %`;
};

// Single hour/hours pluralizer shared across the smart-task surfaces (sample
// freshness line in `estimateConfidence.ts`, the create-smart-task scheduled-window helper in
// `smartTaskDeadlineFormat.ts`, …) so the count→noun rule lives in one place
// instead of being re-inlined at every call site.
export const pluralHour = (count: number): string => (count === 1 ? 'hour' : 'hours');

// Goal value as the user sees it on the create-smart-task widget: "80%" (no
// space) for an EV charge target, "65 °C" (thin space) for a thermostat. One
// source for the stepper readout AND the "now → goal" context lines so the
// widget's percent/temperature spacing can never drift between them
// (percent spacing matches `formatProgressValueForUnit` elsewhere in this file).
export const formatSmartTaskGoalValue = (
  value: number,
  unitSymbol: DeferredObjectiveUnit,
): string => {
  const rounded = Math.round(value * 10) / 10;
  const text = rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
  return unitSymbol === '%' ? `${text}%` : `${text} ${unitSymbol}`;
};

// "Now 42%" / "Now 48 °C" current-reading hint for the device picker row.
// Sibling to `formatSmartTaskCurrentValueLine` (which renders the lowercase
// "currently …" list-card variant); this is the picker's capitalised short
// form. Returns null when the device hasn't reported a reading so the caller
// can fall back to the bare unit. Lives here so the widget never inlines the
// "Now <value>" string (per `feedback_ui_text_shared_with_logs.md`).
export const formatSmartTaskNowValueLine = (params: {
  currentValue: number | null;
  unitSymbol: DeferredObjectiveUnit;
}): string | null => {
  if (params.currentValue === null || !Number.isFinite(params.currentValue)) return null;
  return `Now ${formatSmartTaskGoalValue(params.currentValue, params.unitSymbol)}`;
};

// Compose-step goal anchor: pairs the chosen goal with the device's current
// reading so the target isn't shown in a vacuum ("Goal 80% · now 42%"). When
// the goal sits above the current value we render the motion as an arrow
// ("from 42% → 80%") which reads more naturally for the common "raise it"
// case; an equal/lower goal stays on the "Goal … · now …" form (the arrow
// would imply a decrease the planner can't drive). Collapses to "Goal <value>"
// when no current reading is available. Sourced here so the phrasing is shared
// (per `feedback_ui_text_shared_with_logs.md`).
export const formatSmartTaskGoalContextLine = (
  goalValue: number,
  currentValue: number | null,
  unitSymbol: DeferredObjectiveUnit,
): string => {
  const goalLabel = formatSmartTaskGoalValue(goalValue, unitSymbol);
  if (currentValue === null || !Number.isFinite(currentValue)) {
    return `Goal ${goalLabel}`;
  }
  const nowLabel = formatSmartTaskGoalValue(currentValue, unitSymbol);
  if (nowLabel === goalLabel) return `Goal ${goalLabel}`;
  if (goalValue > currentValue) return `from ${nowLabel} → ${goalLabel}`;
  return `Goal ${goalLabel} · now ${nowLabel}`;
};

// `≈` (U+2248) signals "approximate" — the in-flight cost is a planned figure
// that the actual delivered run will overshoot or undershoot. Spelling the
// glyph out here (rather than burying it in caller string concat) so the
// `pels-copy-and-terminology` reviewer can grep for it and so we never drift
// to ASCII `~` or the word "approx" again. Matches `notes/ui-terminology.md`.
// Exported so the history-detail cost helpers in `deferredPlanHistory.ts`
// render the same glyph across live and past surfaces — the user reads the
// same approximation marker whether the run is in-flight or finalized.
export const APPROX_GLYPH = '≈';

// Exported for the live-page trajectory producer (`deadlinePlan.ts`), which
// composes "51.1 °C now" / "Projected 58 °C at the deadline" with the same
// precision rules as the delivered-so-far hero line (`liveDetailCopy.ts`).
export const formatProgressValueForUnit = (
  value: number,
  unit: DeferredObjectiveUnit,
): string => (
  unit === '%' ? `${Math.round(value)}%` : `${value.toFixed(1)} ${unit}`
);
