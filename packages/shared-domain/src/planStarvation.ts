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

// ─── Starvation-rescue widget vocabulary ─────────────────────────────────────
//
// Strings for the standalone starvation-rescue dashboard widget. Housed beside
// the rest of the starvation copy so runtime log breadcrumbs can reuse the same
// wording (feedback_ui_text_shared_with_logs) and the widget never inlines
// literals. "Starved" / "limited" vocabulary only — no shed/restore/headroom
// jargon (notes/ui-terminology.md). Per feedback_hard_cap_is_physical, the
// capacity-starved copy never suggests raising the hard cap.

export type StarvationRescueRowTone = 'warn' | 'danger';

export const STARVATION_RESCUE_WIDGET_COPY = {
  // Empty (calm) state — nothing is starved. This is the steady, good state.
  emptySubtitle: 'No device is being held back right now.',
  // Transient "wiring up to Homey" state, distinct from a hard load failure.
  notReady: 'Connecting to Homey…',
  loadError: 'Could not load devices. Try again later.',
  // Row status chip prefix. The widget appends "· N min".
  starvedChip: 'Starved',
  // Rescue affordance (budget-caused rows only). "Use budget now" is honest that
  // the action spends today's budget rather than promising instant delivery —
  // the rescue is a bounded near-term run, not an immediate power switch (the
  // confirm sheet surfaces the "By {time}" timing prominently).
  rescueButton: 'Use budget now',
  // Informational note on capacity / manual / external rows — they get NO rescue
  // affordance. Honest about why, without implying the user can raise the cap.
  // Matches the canonical "Waiting for available power" wording the overview and
  // the row subtext use, so the capacity story reads the same everywhere.
  capacityNote: 'Waiting for available power.',
  manualNote: 'Under manual control.',
  externalNote: 'Waiting on an external service.',
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
  previewUnavailable: 'Can’t preview this yet — no prices published for this window yet.',
  rescuePending: 'Setting up…',
  rescueDone: 'Power on the way',
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

// "Starved · 24 min" status label for a rescue row.
export const formatStarvationRowChip = (accumulatedMs: number): string => (
  `${STARVATION_RESCUE_WIDGET_COPY.starvedChip} · ${starvationDurationMinutes(accumulatedMs)} min`
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

// The informational note (capacity/manual/external rows that get no rescue).
export const resolveStarvationRowNote = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
): string | null => {
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
): boolean => (
  starvationRowOffersRescue(cause)
  && intendedNormalTargetC !== null
  && Number.isFinite(intendedNormalTargetC)
);

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
