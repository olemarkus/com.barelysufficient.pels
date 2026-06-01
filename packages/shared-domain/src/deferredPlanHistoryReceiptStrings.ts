// Canonical user-visible strings for the smart-task history receipt/chip
// producers in `deferredPlanHistoryReceipt.ts` (the v2.7.3 "history loveable"
// pass). Lifted out of the producer per `feedback_ui_text_shared_with_logs.md`:
// every label, chip fragment, and section-heading word the user reads is
// composed from a named constant or formatter here, so a future localization
// story has a single home to translate and runtime log breadcrumbs that echo
// these strings can never drift from the UI.
//
// This module is intentionally string-only — no Date / Intl / locale work
// (that stays in the producer, which threads pre-formatted clock labels in).
// The producer owns all branching/data resolution
// (`feedback_layering_resolution_in_producer.md`); this file only owns the
// words and the small count→noun / value→phrase shaping that the words need.
//
// Output is byte-identical to the previously-inlined literals — this is a
// structural move, not a copy change.

// Non-breaking space, used between the approx glyph + value + unit so chips
// never wrap mid-figure ("12 / kr" breaking onto two lines at 320 px).
// v2.7.3 — `pels-m3-critic` + `pels-ux-fit` finding. (Re-exported alongside
// the approx glyph from `deadlineLabels` by the producer; defined here so the
// receipt strings that interpolate it have a local source.)
export const RECEIPT_NBSP = ' ';

// ─── Receipt timeline (Succeeded shape) row labels + detail tails ─────────────

// Leading labels for the three Succeeded-shape receipt rows. Sentence-cased,
// no trailing punctuation; the view renders these as the leading text in each
// row.
export const RECEIPT_ROW_LABEL_STARTED = 'Started';
export const RECEIPT_ROW_LABEL_LARGEST_PLANNED_HOUR = 'Largest planned hour';
export const RECEIPT_ROW_LABEL_READY = 'Ready';

// "from 18.5 °C" / "from 45 %" start-reading detail tail on the Started row.
// Pre-rounded value formatting matches the producer's prior inline toFixed.
export const formatReceiptStartFromTemperature = (formattedC: string): string =>
  `from ${formattedC} °C`;
export const formatReceiptStartFromPercent = (formattedPercent: string): string =>
  `from ${formattedPercent} %`;

// "4.0 kWh planned" detail tail on the Largest-planned-hour row.
export const formatReceiptPlannedKWh = (formattedKWh: string): string =>
  `${formattedKWh} kWh planned`;

// "18 min before 07:00" detail tail on the Ready row.
export const formatReceiptReadyMargin = (margin: string, deadlineClock: string): string =>
  `${margin} before ${deadlineClock}`;

// ─── Duration formatting (shared by Started margin + shortfall chip) ──────────

// "0 min" / "23 min" / "2 h" / "2 h 15 min" — the human margin/shortfall
// duration phrasing. The producer computes the millisecond value; this owns
// the words and unit spacing.
export const RECEIPT_DURATION_ZERO = '0 min';
export const formatReceiptDurationMinutes = (minutes: number): string => `${minutes} min`;
export const formatReceiptDurationHours = (hours: number): string => `${hours} h`;
export const formatReceiptDurationHoursMinutes = (hours: number, minutes: number): string =>
  `${hours} h ${minutes} min`;

// ─── Missed shortfall chip ────────────────────────────────────────────────────

// "Delivered 17.0 of 24.0 kWh" (denominator shown) and the bare
// "Delivered 14.2 kWh" variant when delivery met/exceeded the scheduled total.
export const formatReceiptDeliveredOf = (
  formattedDelivered: string,
  formattedPlanned: string,
): string => `Delivered ${formattedDelivered} of ${formattedPlanned} kWh`;
export const formatReceiptDeliveredBare = (formattedDelivered: string): string =>
  `Delivered ${formattedDelivered} kWh`;

// "short ≈ 23 min" — the time-shortfall half of the chip. `approxGlyph` is
// threaded from the producer (which imports `APPROX_GLYPH` from
// `deadlineLabels`) so the glyph stays single-sourced; NBSP keeps the chip
// from wrapping mid-figure.
export const formatReceiptShortfall = (approxGlyph: string, duration: string): string =>
  `short ${approxGlyph}${RECEIPT_NBSP}${duration}`;

// ─── Cost narrative chip (Succeeded + Missed) ────────────────────────────────

// "≈ 12 kr" — whole kroner cost story. Glyph + unit are threaded in so the
// glyph stays single-sourced and the unit reads in the user's display currency.
export const formatReceiptCostNarrative = (
  approxGlyph: string,
  roundedCost: number,
  unit: string,
): string => `${approxGlyph}${RECEIPT_NBSP}${roundedCost}${RECEIPT_NBSP}${unit}`;

// ─── Abandoned details (collapsed <details> body) ────────────────────────────

// "0.4 kWh delivered before it stopped." — the partial-delivery line in the
// abandoned disclosure body. Sentence-shaped (keeps its terminal period).
export const formatReceiptAbandonedDelivered = (formattedKWh: string): string =>
  `${formattedKWh} kWh delivered before it stopped.`;

// "Last device state: …" lines, mirroring the active-plan vocabulary so the
// abandoned-detail line reads consistently with how a live plan describes
// itself. Keyed implicitly by the producer's planStatus + objectiveKind switch;
// the strings live here so the wording can't drift between the receipt and a
// live plan's status copy.
export const RECEIPT_LAST_STATE_CHARGING_ON_SCHEDULE = 'Last device state: charging on schedule.';
export const RECEIPT_LAST_STATE_HEATING_ON_SCHEDULE = 'Last device state: heating on schedule.';
export const RECEIPT_LAST_STATE_BEHIND_SCHEDULE = 'Last device state: behind schedule.';
export const RECEIPT_LAST_STATE_BEHIND_NO_TIME_CHARGE
  = 'Last device state: behind schedule with not enough time to finish.';
export const RECEIPT_LAST_STATE_BEHIND_NO_TIME_HEAT
  = 'Last device state: behind schedule with not enough time to reach the target.';
export const RECEIPT_LAST_STATE_TARGET_REACHED = 'Last device state: target already reached.';

// ─── ISO-week archive grouping (DeadlinesHistoryList) ────────────────────────

// Outcome-count chip fragments for the week-divider headings and the 7-day
// strip. Chip vocabulary (`succeeded` / `missed` / `abandoned`) per
// notes/ui-terminology.md "Chip adjectives vs divider verbs"; the same three
// nouns back both surfaces so they can't drift.
export const formatReceiptOutcomeSucceeded = (count: number): string => `${count} succeeded`;
export const formatReceiptOutcomeMissed = (count: number): string => `${count} missed`;
export const formatReceiptOutcomeAbandoned = (count: number): string => `${count} abandoned`;

// "≈ 41 kr" rolled-up cost fragment for the week-divider heading. The week
// heading uses a plain space (not NBSP) around the glyph — preserved verbatim
// from the prior inline literal.
export const formatReceiptWeekCost = (
  approxGlyph: string,
  roundedCost: number,
  unit: string,
): string => `${approxGlyph} ${roundedCost} ${unit}`;

// Scales a persisted RAW cost total to the display currency before the cost
// formatters above round it. History `totalCost` is accumulated in the scheme's
// minor unit (øre for the default Norwegian `kr`/100 scheme), so labelling it
// `kr` without dividing renders ~100× too much. Mirrors the live deadline hero,
// which divides each hour's `price` by the same `CostDisplay.divisor` BEFORE
// accumulating the delivered cost (`deadlinePlan.ts`). The divisor arrives as a
// bare number because `CostDisplay` lives in the settings-UI layer this module
// may not import. Guards a 0/NaN divisor to 1 so a malformed price payload never
// divides by zero.
export const scaleRawCostToDisplay = (rawCost: number, divisor: number): number => (
  rawCost / (Number.isFinite(divisor) && divisor > 0 ? divisor : 1)
);

// Display currency for the week roll-up — `unit` is the suffix (`kr`), `divisor`
// scales the raw minor-unit `totalCost` sum to that currency. A small bundle so
// the heading producer passes one cost param (mirrors the settings-UI
// `CostDisplay`, which the shared-domain layer may not import).
export type WeekCostDisplay = { unit: string; divisor: number };

// Relative week lead labels for the section heading. "This week" / "Last week"
// anchor on the user's current week; older weeks render as "Week of 12 May"
// (the week's Monday formatted) rather than the engineer-facing ISO number.
export const RECEIPT_WEEK_THIS = 'This week';
export const RECEIPT_WEEK_LAST = 'Last week';
export const formatReceiptWeekOf = (mondayMonthDay: string): string => `Week of ${mondayMonthDay}`;

// Provisional heading used before the second-pass heading copy is composed,
// and the synthetic "Other tasks" bucket for entries with an unparseable
// deadline. `Week ${n}` is never user-visible in the finished output (it is
// overwritten in the grouping's second pass) but is kept here so the one place
// it is interpolated reads from a named formatter rather than an inline literal.
export const formatReceiptWeekProvisionalHeading = (week: number): string => `Week ${week}`;
export const RECEIPT_OTHER_TASKS_NOUN_SINGULAR = 'task';
export const RECEIPT_OTHER_TASKS_NOUN_PLURAL = 'tasks';
export const formatReceiptOtherTasksHeading = (count: number): string =>
  `Other tasks · ${count} ${count === 1 ? RECEIPT_OTHER_TASKS_NOUN_SINGULAR : RECEIPT_OTHER_TASKS_NOUN_PLURAL}`;

// Divider used to join the receipt/heading/chip fragments into one string.
export const RECEIPT_FRAGMENT_SEPARATOR = ' · ';
