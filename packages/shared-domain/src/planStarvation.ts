import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanDeviceStarvation,
} from '../../contracts/src/settingsUiApi';

export type PlanStarvationTone = 'warn' | 'info' | 'muted';

export type PlanStarvationBadgeView = {
  label: string;
  tone: PlanStarvationTone;
  tooltip: string;
};

const resolveTone = (cause: SettingsUiPlanDeviceStarvation['cause']): PlanStarvationTone => {
  if (cause === 'capacity') return 'warn';
  if (cause === 'budget') return 'info';
  return 'muted';
};

const resolveBadgeLabel = (cause: SettingsUiPlanDeviceStarvation['cause']): string => {
  if (cause === 'capacity') return 'Low power';
  if (cause === 'budget') return 'Budget limited';
  if (cause === 'manual') return 'Manual hold';
  return 'Waiting';
};

const resolveStarvationMessage = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
  options: { manualSubject: 'the device' | 'this device' },
): string => {
  if (cause === 'capacity') {
    return 'Waiting for available power';
  }
  if (cause === 'budget') {
    return "Limited to stay within today's budget";
  }
  if (cause === 'manual') {
    return `Manual control is holding ${options.manualSubject}`;
  }
  return 'Waiting on external service';
};

export const formatStarvationBadge = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): PlanStarvationBadgeView | null => {
  if (!starvation?.isStarved) return null;
  return {
    label: resolveBadgeLabel(starvation.cause),
    tone: resolveTone(starvation.cause),
    tooltip: resolveStarvationMessage(starvation.cause, { manualSubject: 'the device' }),
  };
};

export const formatStarvationReason = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): string | null => {
  if (!starvation?.isStarved) return null;
  return resolveStarvationMessage(starvation.cause, { manualSubject: 'this device' });
};

// ─── Held-back-devices widget vocabulary ─────────────────────────────────────
//
// Strings for the standalone "Held-back devices" dashboard widget. Housed in
// shared-domain (single home, no widget-inlined literals) beside the rest of the
// starvation copy so a future runtime log breadcrumb can reuse the wording
// (feedback_ui_text_shared_with_logs). NOTE: no runtime/logging path consumes
// these widget strings today — starvation logging uses its own vocabulary
// (`starvedDeviceCount`, `starvationCause`); this is the single-home placement,
// not actual log parity yet. The widget shows which devices PELS is holding back via the
// daily budget; it does NOT conjure house power (the hard cap is physical), so
// the framing is device-scoped ("held back") rather than "get power". "Held
// back" / "limited" vocabulary only — no shed/restore/headroom jargon
// (notes/ui-terminology.md). Per feedback_hard_cap_is_physical, the
// capacity-held copy never suggests raising the hard cap.

export type StarvationRescueRowTone = 'warn' | 'danger';

export const STARVATION_RESCUE_WIDGET_COPY = {
  // List header — names what the widget SHOWS (the devices PELS is holding back
  // via the daily budget), not an action the user takes. Shown only when at
  // least one device is held back; the calm empty state stands alone.
  headerTitle: 'Held-back devices',
  // Empty (calm) state — nothing is held back. This is the steady, good state.
  emptySubtitle: 'No device is being held back right now.',
  // Transient "wiring up to Homey" state, distinct from a hard load failure.
  notReady: 'Connecting to Homey…',
  loadError: 'Could not load devices. Try again later.',
  // Row status-chip word. The widget appends "· N min". Cause-specific so the
  // chip never overclaims: only budget rows (the releasable "Let it run now"
  // state) say "Held back"; capacity/external say "Waiting" (physically held —
  // the hard cap is not a tuning knob, feedback_hard_cap_is_physical) and manual
  // says "On hold". User-facing register only — no "starvation" jargon.
  starvedChip: 'Held back',
  waitingChip: 'Waiting',
  manualChip: 'On hold',
  // Rescue affordance (budget-caused rows only). "Let it run now" is device-
  // scoped — it releases THIS device from the daily budget so it runs now,
  // rather than promising house power. The rescue is a bounded near-term run
  // (the confirm sheet surfaces the "By {time}" timing prominently).
  rescueButton: 'Let it run now',
  // Informational note on capacity / manual / external rows — they get NO rescue
  // affordance. Honest about why, without implying the user can raise the cap.
  // Matches the canonical "Waiting for available power" wording the overview and
  // the row subtext use, so the capacity story reads the same everywhere.
  capacityNote: 'Waiting for available power.',
  manualNote: 'Under manual control.',
  externalNote: 'Waiting on an external service.',
  // A budget-held device that already has a smart task: shown in the list (so the
  // user sees it is held back) but with no rescue button — its own task is what
  // brings it to target, so a one-shot rescue would only get in the way.
  smartTaskNote: 'Its smart task will bring it back.',
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
  rescueError: 'Could not set up the rescue. Try again.',
  // The previewed deadline slipped past while the user lingered — retryable.
  deadlinePassed: 'That timing just passed. Try again.',
} as const;

// Counted starvation minutes for display: floor(accumulatedMs / 60000), matching
// the `starved_duration_minutes` external contract (notes/starvation/README.md —
// "Do not expose seconds").
export const starvationDurationMinutes = (accumulatedMs: number): number => (
  Number.isFinite(accumulatedMs) && accumulatedMs > 0 ? Math.floor(accumulatedMs / 60_000) : 0
);

// Status-chip word per cause: only budget rows are the releasable "Held back"
// state; capacity/external are "Waiting" (physically held — the hard cap is not
// a tuning knob) and manual is "On hold". Keeps the chip honest per-cause so a
// capacity row is never mislabeled as the budget-releasable "Held back" state.
const resolveStarvationRowChipWord = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
): string => {
  if (cause === 'budget') return STARVATION_RESCUE_WIDGET_COPY.starvedChip;
  if (cause === 'manual') return STARVATION_RESCUE_WIDGET_COPY.manualChip;
  return STARVATION_RESCUE_WIDGET_COPY.waitingChip; // capacity + external
};

// "Held back · 24 min" (budget) / "Waiting · 24 min" (capacity, external) /
// "On hold · 24 min" (manual) status label for a held-back row.
export const formatStarvationRowChip = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
  accumulatedMs: number,
): string => (
  `${resolveStarvationRowChipWord(cause)} · ${starvationDurationMinutes(accumulatedMs)} min`
);

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
// ("65°"), one decimal otherwise ("21.5°"). Mirrors the degree glyph the rest of
// the UI uses. Null/non-finite targets drop the felt-symptom clause.
const formatTargetDegrees = (targetC: number | null | undefined): string | null => {
  if (typeof targetC !== 'number' || !Number.isFinite(targetC)) return null;
  const rounded = Math.round(targetC * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}°`;
};

// Plain-language subtext for a rescue-widget row, derived from the
// producer-resolved flat `cause` (never re-derived from internals —
// feedback_layering_resolution_in_producer). Budget rows get the actionable
// felt-symptom line naming the target the budget is holding the device below
// ("Held below 65° by today's budget") when the intended normal target is known,
// falling back to the plain budget line otherwise. Capacity reuses the canonical
// "Waiting for available power" overview wording so the two surfaces agree; the
// rest get honest informational copy.
export const resolveStarvationRowSubtext = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
  intendedNormalTargetC?: number | null,
): string => {
  if (cause === 'budget') {
    const degrees = formatTargetDegrees(intendedNormalTargetC);
    return degrees ? `Held below ${degrees} by today’s budget` : "Held by today’s budget";
  }
  if (cause === 'capacity') return 'Waiting for available power';
  if (cause === 'manual') return 'Under manual control';
  return 'Waiting on an external service';
};

// The informational note for a row that gets no rescue button: capacity/manual/
// external rows, plus a budget row whose device already has a smart task (the
// task handles it). The `hasSmartTask` note wins for budget rows so the user sees
// WHY the otherwise-rescuable row has no button.
export const resolveStarvationRowNote = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
  hasSmartTask = false,
): string | null => {
  if (cause === 'budget') return hasSmartTask ? STARVATION_RESCUE_WIDGET_COPY.smartTaskNote : null;
  if (cause === 'capacity') return STARVATION_RESCUE_WIDGET_COPY.capacityNote;
  if (cause === 'manual') return STARVATION_RESCUE_WIDGET_COPY.manualNote;
  if (cause === 'external') return STARVATION_RESCUE_WIDGET_COPY.externalNote;
  return null;
};

// Whether a starved row may offer the budget-exempt rescue. ONLY budget-caused
// rows: capacity is physical (the hard cap is not a tuning knob —
// feedback_hard_cap_is_physical) and manual/external are outside PELS's control.
export const starvationRowOffersRescue = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
): boolean => cause === 'budget';

// Whether a starved row can actually be rescued NOW: a budget-caused row AND a
// known intended normal target to aim the rescue at. This mirrors the
// server-side guardrail in the widget API (`resolveRescuableDevice`, which
// rejects `no_target`) so the UI never offers a rescue button that the API then
// rejects. `starvationRowOffersRescue` is the cause-only gate; this is the
// full actionable predicate the button visibility uses.
export const starvationRowIsRescuable = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
  intendedNormalTargetC: number | null,
  hasSmartTask = false,
): boolean => (
  starvationRowOffersRescue(cause)
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
// Mirrors the create widget's resolver: only the retryable deadline-passed case
// gets bespoke copy; everything else collapses to the generic failure line.
export const resolveStarvationRescueRejectCopy = (reason: string | undefined): string => (
  reason === 'deadline_passed'
    ? STARVATION_RESCUE_WIDGET_COPY.deadlinePassed
    : STARVATION_RESCUE_WIDGET_COPY.rescueError
);

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
