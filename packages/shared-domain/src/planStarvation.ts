import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanDeviceStarvation,
} from '../../contracts/src/settingsUiApi';
import type { SmartTaskHomeScope } from '../../contracts/src/smartTaskHomeScope';
// From the lean write-strings module (NOT deadlineLabels.ts) so the rescue
// widget bundles don't drag the full smart-task copy module in.
import { SMART_TASK_SUB_HOME_UNAVAILABLE } from './objectiveWriteStrings';

// Canonical starvation copy: a device held below target because the house has no
// power to spare for it. Single home for this exact wording so the overview, the
// rescue-widget row subtext, and the device-detail diagnostics map all read
// identically and cannot drift.
//
// Deliberately names NO ceiling. Which limit binds — the hourly pace or today's
// budget — is one house-level fact that moves on its own, and the hero states it
// once (`Safe pace now 1.9 kW · set by today's budget`). Until 2026-08-04 this
// module split every string on a `budget | capacity` bucket; see the header note
// on the rescue gate below for why that bucket is gone.
export const STARVATION_WAITING_FOR_POWER_COPY = 'Waiting for available power';

export type PlanStarvationTone = 'warn' | 'info' | 'muted';

export type PlanStarvationBadgeView = {
  label: string;
  tone: PlanStarvationTone;
  tooltip: string;
};

// One starved state, one badge. A device PELS merely keeps below its target is
// not starved, so there is no "manual"/"external" badge either. `Held back` is
// the same user-facing word the rescue widget's rows use, so the two surfaces
// name the state identically.
export const PLAN_STARVATION_BADGE_LABEL = 'Held back';

export const formatStarvationBadge = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): PlanStarvationBadgeView | null => {
  if (!starvation?.isStarved) return null;
  return {
    label: PLAN_STARVATION_BADGE_LABEL,
    tone: 'warn',
    tooltip: STARVATION_WAITING_FOR_POWER_COPY,
  };
};

export const formatStarvationReason = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): string | null => (
  starvation?.isStarved ? STARVATION_WAITING_FOR_POWER_COPY : null
);

// ─── Held-back-devices widget vocabulary ─────────────────────────────────────
//
// Strings for the standalone "Held-back devices" dashboard widget. Housed in
// shared-domain (single home, no widget-inlined literals) beside the rest of the
// starvation copy so a future runtime log breadcrumb can reuse the wording
// (feedback_ui_text_shared_with_logs). NOTE: no runtime/logging path consumes
// these widget strings today — starvation logging uses its own vocabulary
// (`starvedDeviceCount`, `starvationCause`); this is the single-home placement,
// not actual log parity yet. The widget shows which devices PELS is holding back;
// it does NOT conjure house power (the hard cap is never raised), so the framing
// is device-scoped ("held back") rather than "get power". "Held back" / "limited"
// vocabulary only — no shed/restore/headroom jargon (notes/ui-terminology.md).
// Per feedback_hard_cap_is_physical, no string here suggests raising the hard cap.

export type StarvationRescueRowTone = 'warn' | 'danger';

export const STARVATION_RESCUE_WIDGET_COPY = {
  // List header — names what the widget SHOWS (the devices PELS is holding
  // back), not an action the user takes. Shown only when at least one device is
  // held back; the calm empty state stands alone.
  headerTitle: 'Held-back devices',
  // Empty (calm) state — nothing is held back. This is the steady, good state.
  emptySubtitle: 'No device is being held back right now.',
  // Transient "wiring up to Homey" state, distinct from a hard load failure.
  notReady: 'Connecting to Homey…',
  loadError: 'Could not load devices. Try again later.',
  // Row status-chip word. The widget appends "· 24 min" / "· 2 h 15 min".
  // User-facing register only — no "starvation" jargon.
  starvedChip: 'Held back',
  // Rescue affordance. "Let it run now" is device-scoped — it clears room for
  // THIS device so it runs now, rather than promising house power. The rescue is
  // a bounded near-term run (the confirm sheet surfaces the "By {time}" timing
  // prominently).
  rescueButton: 'Let it run now',
  // A held-back device that already has a smart task: shown in the list (so the
  // user sees it is held back) but with no rescue button — its own task is what
  // brings it to target, so a one-shot rescue would only get in the way.
  smartTaskNote: 'Its smart task will bring it back.',
  temporaryUnavailableNote: 'Temporarily unavailable. Try again shortly.',
  // Rescue confirm sheet.
  // Names the consequence honestly per the money-action guardrail: the rescue
  // lets this device go over today's budget so it reaches its normal target.
  rescueConsequence: 'This lets the device use power beyond today’s budget until it reaches its normal target.',
  rescueConfirmButton: 'Confirm',
  backButton: 'Back',
  scheduledLabel: 'Scheduled',
  // Deadline lead for the when-line ("By 17:00"): the rescue reaches the normal
  // target BY this near-term time. Distinct from the create widget's "Ready by"
  // (a user-chosen time) — this is a fixed near-term horizon, so "By" reads
  // truer than "Ready by".
  byLabel: 'By',
  energyLabel: 'Energy',
  // Same in-isolation caveat the create widget uses — the estimate ignores
  // re-plans and competing tasks.
  estimateCaveat: 'Estimate — the actual run may differ as prices and other tasks change.',
  // Heading for the read-only "what this grants" summary on the confirm sheet.
  // Must stay character-identical to `SMART_TASK_EXTRA_PERMISSIONS_TITLE` in
  // `deadlineLabels.ts` (line items come from SMART_TASK_EXTRA_PERMISSION_LABELS
  // there) so every surface naming these permissions reads the same. Kept as a
  // LITERAL rather than an import on purpose: this module is deliberately off
  // `deadlineLabels.ts` so the rescue widget bundle doesn't drag the full
  // smart-task copy module in — see the import note at the top of this file.
  // Here it is informational, not a set of toggles: the rescue REQUESTS all
  // three permissions (`buildRescueCandidate`), and the per-device gate decides
  // which of them survive to be listed here.
  extraPermissionsTitle: 'Extra permissions',
  // Factual at-cap honesty signal. The in-isolation preview can show the device
  // running now, but if the house is already pressed against the physical hard
  // cap there is no room until something frees up. Names the real measured
  // fact (at the hard cap), NOT a prompt to raise it — the hard cap is not a
  // remedy (feedback_hard_cap_is_physical). Pairs with the "Running as soon as there’s
  // room" flash for the same honesty when the rescue is committed.
  atCapNote: 'Your hard cap is maxed out right now, so it may wait for room before running.',
  // Preview couldn't be projected (no prices yet, missing reading, price
  // optimisation off). Distinct from a hard error.
  previewUnavailable: 'Can’t preview this yet — PELS needs more current data for this window.',
  rescuePending: 'Setting up…',
  // Two honest success flashes, branched on whether the projected plan actually
  // runs the device now. The rescue grants the device priority over lower-
  // priority loads (within the physical hard cap) AND lifts today's budget, but
  // if the house is already at the cap with nothing lower-priority to displace,
  // power isn't instant — so don't promise "on the way" unconditionally.
  rescueDone: 'Power on the way',
  rescueDoneQueued: 'Running as soon as there’s room',
  rescueError: 'Could not let it run now. Try again.',
  // The previewed deadline slipped past while the user lingered — retryable.
  deadlinePassed: 'That timing just passed. Try again.',
} as const;

// Counted starvation minutes for display: floor(accumulatedMs / 60000), matching
// the `starved_duration_minutes` external contract (notes/starvation/README.md —
// "Do not expose seconds").
export const starvationDurationMinutes = (accumulatedMs: number): number => (
  Number.isFinite(accumulatedMs) && accumulatedMs > 0 ? Math.floor(accumulatedMs / 60_000) : 0
);

// Non-breaking space so a duration is one unbreakable token — "2 h 15 min" must
// never split across lines mid-figure at 320 px. Held locally rather than
// imported from `deferredPlanHistoryReceiptStrings` (which owns the identical
// convention for receipt margins): this module is deliberately kept off the
// smart-task copy modules so the rescue widget bundle stays lean — see the
// import note at the top of this file.
const STARVATION_NBSP = ' ';
const MINUTES_PER_HOUR = 60;

// "0 min" / "45 min" / "2 h" / "2 h 15 min" — how long PELS has been holding the
// device below its target. Built on `starvationDurationMinutes`, so the
// no-seconds contract (notes/starvation/README.md) holds here too. Rolls over
// into hours: a 2.6-hour hold read "156 min" before 2026-08-04, which is the
// exact case the overview card now shows on every long hold.
export const formatStarvationDurationLabel = (accumulatedMs: number): string => {
  const totalMinutes = starvationDurationMinutes(accumulatedMs);
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (hours === 0) return `${minutes}${STARVATION_NBSP}min`;
  if (minutes === 0) return `${hours}${STARVATION_NBSP}h`;
  return `${hours}${STARVATION_NBSP}h${STARVATION_NBSP}${minutes}${STARVATION_NBSP}min`;
};

// "Held back · 24 min" / "Held back · 2 h 15 min" status label for a held-back row.
//
// A non-positive or malformed duration drops the suffix entirely rather than
// printing "Held back · 0 min", which reads as a stuck counter. Mirrors the
// card's `resolveStarvedForMs` rule (`planCardReasonLine.ts`), which takes the
// plain stem for the same input. Unreachable on a real row — a device only
// registers as held back after the 15-minute entry latency — so this is
// boundary hardening, not a live case.
export const formatStarvationRowChip = (accumulatedMs: number): string => {
  const chip = STARVATION_RESCUE_WIDGET_COPY.starvedChip;
  return starvationDurationMinutes(accumulatedMs) > 0
    ? `${chip} · ${formatStarvationDurationLabel(accumulatedMs)}`
    : chip;
};

// How many starved rows fit in the widget's fixed 240px height before the list
// scrolls. Beyond this, a "+N more" footer cues the user that rows (possibly the
// device they just got notified about) sit below the fold.
const STARVATION_RESCUE_VISIBLE_ROWS = 2;

// "+2 more" overflow cue, or null when every row is above the fold. `totalCount`
// is the full starved-device count; the cue counts the rows past the visible cap.
export const formatStarvationOverflowCue = (totalCount: number): string | null => {
  if (!Number.isFinite(totalCount) || totalCount <= STARVATION_RESCUE_VISIBLE_ROWS) return null;
  return `+${totalCount - STARVATION_RESCUE_VISIBLE_ROWS} more`;
};

// Tone escalates with how long the device has been held back: a freshly-starved
// device is a `warn`, a long-starved one a `danger`. The 30-minute threshold is
// the entry latency (15 min) plus an equal sustained-hold window, so a device
// that has waited twice as long as it took to enter starvation reads as urgent.
// Compared against the exact millisecond duration, not the rounded label
// (notes/starvation/README.md — duration triggers use exact ms).
const STARVATION_RESCUE_DANGER_THRESHOLD_MS = 30 * 60_000;

export const resolveStarvationRowTone = (accumulatedMs: number): StarvationRescueRowTone => (
  Number.isFinite(accumulatedMs) && accumulatedMs >= STARVATION_RESCUE_DANGER_THRESHOLD_MS ? 'danger' : 'warn'
);

// Format a temperature target for inline copy: a whole number where possible
// ("65 °C"), one decimal otherwise ("21.5 °C"). Uses the same trailing-zero-
// stripped `°C` unit as the rest of the UI. Null/non-finite targets drop the
// felt-symptom clause.
const formatTargetDegrees = (targetC: number | null | undefined): string | null => {
  if (typeof targetC !== 'number' || !Number.isFinite(targetC)) return null;
  const rounded = Math.round(targetC * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} °C`;
};

// Plain-language subtext for a rescue-widget row: the felt symptom, naming the
// target PELS is holding the device below ("Held below 65 °C") when the intended
// normal target is known. Names no ceiling — see `STARVATION_WAITING_FOR_POWER_COPY`
// — and falls back to that canonical wording when there is no target to name.
export const resolveStarvationRowSubtext = (
  intendedNormalTargetC?: number | null,
): string => {
  const degrees = formatTargetDegrees(intendedNormalTargetC);
  return degrees ? `Held below ${degrees}` : STARVATION_WAITING_FOR_POWER_COPY;
};

// The second line under a rescue-widget row.
//
// A device with its own smart task gets the note explaining why the otherwise-
// rescuable row has no button — that task, not a one-shot rescue, is what brings
// it back. Every other row gets the canonical "why", because unlike an Overview
// card this widget is a STANDALONE dashboard surface: there is no hero anywhere
// near it to state the house-level fact once, so a row carrying only its felt
// symptom ("Held below 65 °C") would never say why. Suppressed when the subtext
// already IS that sentence (no known target to name), so the row never prints
// the same line twice.
export const resolveStarvationRowNote = (
  hasSmartTask = false,
  intendedNormalTargetC?: number | null,
): string | null => {
  if (hasSmartTask) return STARVATION_RESCUE_WIDGET_COPY.smartTaskNote;
  return formatTargetDegrees(intendedNormalTargetC) === null
    ? null
    : STARVATION_WAITING_FOR_POWER_COPY;
};

// ─── Overview held-card "Let it run now" rescue affordance ───────────────────
//
// Copy + gate for the contextual action surfaced on an Overview device card
// when the device is held back BY THE DAILY BUDGET (the releasable case). The
// affordance triggers the SAME bounded budget-exempt rescue as the
// starvation_rescue widget's "Let it run now": one tap arms a confirm, and the
// confirm creates a fresh deferred objective carrying `exemptFromBudget` (≈ now
// +3h, until the device reaches its normal target). It is NOT a deep-link into
// the standing per-device exempt toggle — a budget exemption is always BOUNDED
// to a smart task, never a permanent lever (the standing toggle stays available
// on the device-detail page as a separate feature). The chip reuses the widget's
// canonical rescue verb so the two surfaces speak one language. Housed beside
// the rest of the starvation/held-back vocabulary so the copy stays single-homed
// and a future runtime log breadcrumb could reuse the same word
// (feedback_ui_text_shared_with_logs).
//
// Task-free, rescuable held cards get the affordance: a device with its own
// smart task is brought back by that task, and a device with no known target has
// nothing to aim the rescue at.
//
// It is NOT gated on which constraint is holding the device (removed 2026-08-04).
// The flat `budget | capacity` bucket it used to key off was a momentary snapshot
// — overwritten every accumulation tick — so a device alternating between
// budget-bound and capacity-bound cycles had the button appear and vanish under
// the user's finger. And the gate was never a technical precondition:
// `buildRescueCandidate` requests `pauseLowerPriorityDevices` and
// `limitLowerPriorityDevices` alongside the budget exemption precisely because
// these surfaces cannot see which constraint binds, and both of those clear room
// UP TO — never above — the hard cap. Offering the rescue on a capacity-held
// device therefore helps it without implying the cap is a tuning knob
// (feedback_hard_cap_is_physical).
export const BUDGET_EXEMPT_CARD_ACTION_COPY = {
  // Chip label — the canonical rescue verb, identical to the held-back widget's
  // `rescueButton` ("Let it run now"). Device-scoped: it releases THIS device
  // from today's budget so it runs now, never a hard-cap change. The leading
  // bolt glyph distinguishes it from the adjacent "Held back" status badge.
  label: STARVATION_RESCUE_WIDGET_COPY.rescueButton,
  // Tooltip / accessible description — the same honest money-action consequence
  // the widget's confirm sheet names: the rescue lets the device use power
  // beyond today's budget until it reaches its normal target. Never suggests
  // raising the hard cap (never a remedy).
  tooltip: STARVATION_RESCUE_WIDGET_COPY.rescueConsequence,
  // Armed-confirm label (the two-step settings-UI confirm pattern): the first
  // tap arms this, the second commits the rescue. Reuses the widget's confirm
  // verb so the action word is shared across surfaces.
  confirmLabel: STARVATION_RESCUE_WIDGET_COPY.rescueConfirmButton,
} as const;

// Whether an Overview device card is eligible (by the data the card itself
// carries) to surface the rescue chip: it is held back. The full rescuable gate
// (task-free + a known target) is enforced server-side and reflected in the
// rescuable-device list the card view intersects against. That list is a
// snapshot, so a chip shown from a stale one can still be rejected on create —
// rare, and the reject copy covers it rather than the gate preventing it.
//
// A standing budget exemption no longer suppresses it (2026-08-04). That
// suppression made sense while every held-back device was held by the budget: an
// exempt device could not be, so the chip would have been inert. Now that a hold
// can be capacity-bound, an exempt device CAN be held back — and the rescue still
// helps it, because `pauseLowerPriorityDevices` / `limitLowerPriorityDevices`
// clear room from lower-priority load rather than lifting the budget. Keeping the
// term would also have put the two surfaces in disagreement: the rescue widget's
// gate (`starvationRowIsRescuable`) never had it, so the same device would offer
// the action on the dashboard and not on its card.
export const shouldOfferBudgetExemptCardAction = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): boolean => Boolean(starvation?.isStarved);

// Accessible label for the rescue action, naming the device so a screen-reader
// user hears which card the action belongs to (mirrors DeadlineChip's aria
// pattern). Phrased as the rescue ("Let … run now"), matching the chip verb.
export const budgetExemptCardActionAriaLabel = (deviceName: string): string => (
  deviceName !== '' ? `Let ${deviceName} run now` : 'Let this device run now'
);

// Whether a starved row can actually be rescued NOW: a known intended normal
// target to aim the rescue at, no task of its own, on the main home. This mirrors
// the server-side guardrail in the widget API (`resolveRescuableDevice`, which
// rejects `no_target`) so the UI never offers a rescue button that the API then
// rejects.
export const starvationRowIsRescuable = (
  intendedNormalTargetC: number | null,
  hasSmartTask = false,
  smartTaskHomeScope: SmartTaskHomeScope = 'main',
): boolean => (
  smartTaskHomeScope === 'main'
  && !hasSmartTask // a device with its own task is shown but not rescuable
  && intendedNormalTargetC !== null
  && Number.isFinite(intendedNormalTargetC)
);

// Whether the scheduled plan actually runs the device in the CURRENT clock hour
// (vs only in a later, cheaper hour). Drives the rescue success flash: "Power on
// the way" only when the current hour is planned, otherwise "Running as soon as
// there's room". `startsAtMs` values are epoch-hour-floored absolute ms (the same
// basis the preview joins price/scheduled hours on), so we compare against the
// epoch-hour floor of `nowMs` — never the plan's earliest hour, which is the
// cheapest scheduled hour and is routinely in the future.
const ONE_HOUR_MS = 60 * 60 * 1000;
export const scheduledHoursIncludeCurrentHour = (
  scheduledHours: readonly { startsAtMs: number }[],
  nowMs: number,
): boolean => {
  const currentHourStartMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
  return scheduledHours.some((hour) => hour.startsAtMs === currentHourStartMs);
};

// Map a rescue-create rejection reason to the user-facing widget error line.
// Mirrors the create widget's resolver: the retryable deadline-passed case and
// the multi-home scope rejection get bespoke copy; everything else collapses to
// the generic failure line.
export const resolveStarvationRescueRejectCopy = (reason: string | undefined): string => {
  if (reason === 'deadline_passed') return STARVATION_RESCUE_WIDGET_COPY.deadlinePassed;
  // The device is on a separate meter (sub-home) — the rescue is a smart-task
  // create and smart tasks are main-home-only in v1. The live starved list
  // already excludes such devices, so this covers the stale-row race (the
  // device relocated between listing and tap); the generic "try again" line
  // would be dishonest for a rejection no retry can clear.
  if (reason === 'device_in_sub_home') return SMART_TASK_SUB_HOME_UNAVAILABLE;
  return STARVATION_RESCUE_WIDGET_COPY.rescueError;
};

// The armed-state consequence line on the overview device card, composed here
// rather than in the view so the string the user actually reads is single-homed
// with the constants it joins (`feedback_ui_text_shared_with_logs`,
// `views/AGENTS.md` — shared display logic belongs in shared-domain).
//
// The money-action consequence is surfaced inline because Homey's touch WebView
// has no reachable hover tooltip: the user must see what they are authorising
// before the second tap. When the preview resolved the bounded window, the
// "By {time}" anchor is appended (server-formatted in the Homey timezone — the
// view does no Date math). With no preview the consequence already names its own
// bound ("…until it reaches its normal target."), so it stands alone.
//
// Deliberately says nothing about the OTHER granted permissions: those are listed
// verbatim from `formatGrantedRescuePermissionsLine`, so this surface never
// invents a second phrasing for a permission that already has a canonical label.
export const formatStarvationRescueArmedCaption = (deadlineLabel: string | undefined): string => {
  const consequence = STARVATION_RESCUE_WIDGET_COPY.rescueConsequence;
  if (deadlineLabel === undefined || deadlineLabel === '') return consequence;
  return `${consequence} ${STARVATION_RESCUE_WIDGET_COPY.byLabel} ${deadlineLabel}`;
};

export const summarizeStarvation = (
  devices: Array<Pick<SettingsUiPlanDeviceSnapshot, 'starvation'>> | null | undefined,
): string | null => {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const count = devices
    .map((device) => device.starvation)
    .filter((starvation): starvation is SettingsUiPlanDeviceStarvation => (
      Boolean(starvation?.isStarved)
    ))
    .length;
  if (count === 0) return null;
  return count === 1 ? '1 device limited' : `${count} devices limited`;
};
