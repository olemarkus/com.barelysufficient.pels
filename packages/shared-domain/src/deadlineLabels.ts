/* eslint-disable max-lines -- single home for kind-aware smart-task copy
   (chips, status labels, pending-hero variants, history copy, cost & delivered-
   so-far formatters, EV provenance rows). Splitting per surface would scatter
   copy across files; `feedback_ui_text_shared_with_logs` keeps runtime
   logging and the UI reading the same strings, which requires colocation. */
import type {
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveRescueMode,
  DeferredObjectiveSettingsKind,
} from '../../contracts/src/deferredObjectiveSettings';
import type {
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveActivePlanFloorShortfallCause,
  DeferredObjectiveActivePlanPendingReason,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveKwhPerUnitProvenanceV1,
} from '../../contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveProfileConfidence } from '../../contracts/src/objectiveProfileTypes';

export type DeadlinePlanUnavailableReason =
  | 'no_current_reading'
  | 'already_satisfied';

export type DeadlinePlanPendingReason =
  | 'awaiting_horizon_plan'
  | 'price_feature_disabled'
  | 'device_data_missing'
  // EV plugged-out / discharging session — runtime diagnostics emit
  // `objective_invalid_session`; UI surfaces it as a paused state so the user
  // knows the plan resumes once they plug back in.
  | 'invalid_session'
  // Thermal devices have no shipped bootstrap kWh/°C, so a new device sits
  // pending until the energy profile is learned from power readings.
  | 'missing_capacity';

// One-line user-facing copy for the cold-start `missing_capacity` pending
// reason. Thermal smart tasks have no shipped bootstrap kWh/°C, so a new
// heater (or any thermal device without `measure_power`) sits "Waiting"
// indefinitely until the planner has enough power samples to learn the
// energy profile. This copy tells the user what unblocks the plan. The
// thermal `missing_capacity` resolver renders it as the metaLine; the
// canonical joined form lives here so runtime log breadcrumbs can emit
// the same string (per `feedback_ui_text_shared_with_logs.md`).
export const PENDING_REASON_MISSING_CAPACITY_COPY = 'Learning energy use — needs power readings from this device.';

// Hero/list "live" status variants. Sits next to the kind chip and identifies
// the current operational state in plain language. `building_plan` /
// `queued` / `paused_unplugged` are the three disambiguated `Waiting` cases;
// `active` covers "Charging now"/"Heating now"; `ok` is the on-track no-op
// state when there is no active hour yet but a plan exists.
export type DeadlineLiveState =
  | 'active'
  | 'building_plan'
  | 'queued'
  | 'paused_unplugged'
  | 'ok';

// Display label for a smart task list card's status chip.
export type SmartTaskListStatusId =
  | 'building_plan'   // pending, no allocation yet
  | 'queued'          // plan ready, first hour in the future
  | 'paused_unplugged' // EV: car unplugged / session ended
  | 'on_track'
  | 'at_risk'
  | 'cannot_meet'
  | 'satisfied';

// Stable chip label strings for list card status — kind-agnostic.
// Sourced here (shared-domain) so runtime logging and UI use the same strings.
// Note: the internal status id `queued` is kept stable for log schemas /
// contracts; only the user-visible chip label changed from `Queued` →
// `Scheduled` (TODO 691).
export const SMART_TASK_LIST_STATUS_LABELS: Record<SmartTaskListStatusId, string> = {
  building_plan: 'Building plan…',
  queued: 'Scheduled',
  paused_unplugged: 'Paused — unplugged',
  on_track: 'On track',
  at_risk: 'At risk',
  cannot_meet: 'Cannot finish',
  satisfied: 'Satisfied',
};

// Shorter status labels used by the Smart tasks dashboard widget. The widget
// row at 320–480 px has roughly half the horizontal space the settings UI
// list card uses, so the `Paused — unplugged` em-dash variant truncates or
// pushes the row out of layout. The widget reuses the settings UI label for
// every other state — only `paused_unplugged` needs the compressed form.
// Keeping the override here (and not in the widget) preserves the
// "UI text shared with logs" rule: both the list label and the widget label
// resolve from shared-domain helpers, not from hardcoded widget strings.
export const SMART_TASK_WIDGET_STATUS_LABELS: Record<SmartTaskListStatusId, string> = {
  ...SMART_TASK_LIST_STATUS_LABELS,
  paused_unplugged: 'Unplugged',
};

// Widget detail-panel "why" + recourse copy. Composed from producer-resolved
// fields so the browser-side renderer never branches on statusId /
// pendingReason / floor shortfall cause (per
// `feedback_layering_resolution_in_producer.md`). Strings stay short — the
// widget surface is 320–480 px wide and the detail panel must fit in 220 px
// of vertical space alongside the device name, deadline, target, and back
// chevron. Lifted into shared-domain per
// `feedback_ui_text_shared_with_logs.md` so runtime structured logs can
// surface the same one-line reasons when the detail surface fires.

const SMART_TASK_WIDGET_WHY_BY_STATUS: Record<SmartTaskListStatusId, string | null> = {
  building_plan: null, // resolved by pendingReason
  queued: null, // composed from firstPlannedTimeLabel when present
  paused_unplugged: 'EV is unplugged — plug in to resume.',
  on_track: null, // affirmative line resolved from firstPlannedTimeLabel
  at_risk: null, // disambiguated by budget vs time below
  cannot_meet: null, // resolved by floor cause / budget bucket count
  satisfied: null,
};

const SMART_TASK_WIDGET_WHY_BY_PENDING_REASON:
Partial<Record<DeferredObjectiveActivePlanPendingReason, string>> = {
  awaiting_horizon_plan: 'Waiting for tomorrow’s prices.',
  device_data_missing: 'Waiting for a reading from this device.',
  invalid_session: 'EV is unplugged — plug in to start.',
  missing_capacity: 'Learning energy use from this device.',
  price_feature_disabled: 'Price-aware planning is off.',
};

const WHY_CANNOT_MEET_BUDGET = 'Today’s daily budget runs out before the deadline.';
const WHY_CANNOT_MEET_DEVICE = 'Not enough delivery before the deadline.';
// At-risk is the same two causes as cannot-finish, hedged to "may" because the
// task can still land. Disambiguated so the detail panel never shows the
// "time OR budget" guess the user would otherwise have to resolve themselves.
const WHY_AT_RISK_BUDGET = 'Today’s daily budget may run out before the deadline.';
const WHY_AT_RISK_TIME = 'Limited time left before the deadline.';

const RECOURSE_CANNOT_MEET_BUDGET = 'Lower the daily budget so future days reserve power earlier.';
const RECOURSE_CANNOT_MEET_DEVICE = 'Open this device’s settings in the PELS app to see what’s holding it back.';
const RECOURSE_INVALID_SESSION = 'Plug the EV in to resume.';

export type SmartTaskWidgetDetailCopy = {
  whyLabel: string | null;
  recourseHint: string | null;
};

export type SmartTaskWidgetDetailInput = {
  statusId: SmartTaskListStatusId;
  pendingReason?: DeferredObjectiveActivePlanPendingReason;
  floorShortfallCause?: DeferredObjectiveActivePlanFloorShortfallCause;
  dailyBudgetExhaustedBucketCount?: number;
  // Pre-formatted local time of the first planned hour (e.g. "16:00") for the
  // `queued` "Cheaper hours start at HH:MM" line. Locale formatting lives in the
  // caller so shared-domain stays free of Intl.
  firstPlannedTimeLabel?: string | null;
};

// Budget vs device cause. The producer-resolved `floorShortfallCause` is
// authoritative (per `feedback_layering_resolution_in_producer`): when present,
// it alone decides. The `dailyBudgetExhaustedBucketCount` fallback is gated on
// `floorShortfallCause === undefined` (legacy pre-producer-field revisions) AND
// `at_risk` only — mirroring the settings UI (`deadlinePlan.ts`). The producer
// never returns `cannot_meet` with a budget cause, so a non-budget cause that
// merely brushed the budget cap in the run-up (bucket count > 0) must not be
// misclassified as budget-driven.
const isBudgetDriven = (input: SmartTaskWidgetDetailInput): boolean => {
  if (input.floorShortfallCause !== undefined) return input.floorShortfallCause === 'budget';
  return input.statusId === 'at_risk' && (input.dailyBudgetExhaustedBucketCount ?? 0) > 0;
};

export const resolveSmartTaskWidgetDetailCopy = (
  input: SmartTaskWidgetDetailInput,
): SmartTaskWidgetDetailCopy => {
  if (input.statusId === 'cannot_meet') {
    return isBudgetDriven(input)
      ? { whyLabel: WHY_CANNOT_MEET_BUDGET, recourseHint: RECOURSE_CANNOT_MEET_BUDGET }
      : { whyLabel: WHY_CANNOT_MEET_DEVICE, recourseHint: RECOURSE_CANNOT_MEET_DEVICE };
  }
  if (input.statusId === 'at_risk') {
    return isBudgetDriven(input)
      ? { whyLabel: WHY_AT_RISK_BUDGET, recourseHint: RECOURSE_CANNOT_MEET_BUDGET }
      : { whyLabel: WHY_AT_RISK_TIME, recourseHint: null };
  }
  if (input.statusId === 'building_plan') {
    const reason = input.pendingReason ?? 'awaiting_horizon_plan';
    const why = SMART_TASK_WIDGET_WHY_BY_PENDING_REASON[reason]
      ?? SMART_TASK_WIDGET_WHY_BY_PENDING_REASON.awaiting_horizon_plan
      ?? null;
    return {
      whyLabel: why,
      recourseHint: reason === 'invalid_session' ? RECOURSE_INVALID_SESSION : null,
    };
  }
  if (input.statusId === 'queued' && input.firstPlannedTimeLabel) {
    return {
      whyLabel: `Cheaper hours start at ${input.firstPlannedTimeLabel}.`,
      recourseHint: null,
    };
  }
  return {
    whyLabel: SMART_TASK_WIDGET_WHY_BY_STATUS[input.statusId],
    recourseHint: null,
  };
};

// Compressed empty-state pointer for the widget. The settings-UI variant
// (`SMART_TASK_LIST_EMPTY_COPY`) wraps Flow-action names in rich markup the
// widget can't render at 320–480 px; this is the one-sentence form.
export const SMART_TASK_WIDGET_EMPTY_HINT
  = 'Add a smart task from a Flow card to see it here.';

// Widget empty-state subtitle. Lives here (not inlined in the widget package)
// so runtime logging and the widget render the same string per
// `feedback_ui_text_shared_with_logs`.
export const SMART_TASK_WIDGET_EMPTY_SUBTITLE = 'No active smart tasks';
// One-word prefix for the detail-panel plan-meta recap (duration · power · energy)
// so it isn't the least-legible line — names the dense run-on as a forward estimate.
export const SMART_TASK_WIDGET_PLAN_META_LABEL_PREFIX = 'Estimate';

// Overflow line shown beneath the capped widget row list when more active
// tasks exist than the widget renders (`+N in Smart tasks`). Formatter rather
// than a constant because the count is dynamic; sourced from shared-domain so
// the runtime can reuse the exact phrasing.
export const formatSmartTaskWidgetOverflow = (count: number): string =>
  `+${count} in Smart tasks`;

// ─── Create-smart-task widget copy ───────────────────────────────────────────
// User-facing strings for the standalone "New smart task" dashboard widget.
// Housed here (not inlined in the widget package) so the strings sit beside the
// rest of the smart-task vocabulary and runtime log breadcrumbs can reuse the
// same wording per `feedback_ui_text_shared_with_logs`. The widget lets the
// user set a goal on an eligible device and preview when it runs and what it
// will cost before committing — "smart task" / "Ready by" / "objective"
// vocabulary only, no shed/restore/headroom jargon (`notes/ui-terminology.md`).
export const CREATE_SMART_TASK_WIDGET_COPY = {
  // Step 1 — device picker.
  pickDeviceTitle: 'New smart task',
  pickDevicePrompt: 'Choose a device',
  emptyNoDevices: 'No eligible devices',
  // Warmer than a bare capability list: name the device kinds AND the next
  // action, so a user with nothing yet knows exactly how to make a device
  // appear here rather than hitting a dead end.
  emptyNoDevicesHint: 'Add a thermostat, water heater, or EV charger in Homey and it’ll appear here.',
  loadError: 'Could not load devices. Try again later.',
  // Shown while the widget is still wiring up to the Homey app (the SDK bridge
  // hasn't supplied a real API client yet). Distinct from `loadError` (a real
  // fetch that failed): this is a transient "not ready yet" state that resolves
  // on its own once the bridge connects, so it reads as loading rather than a
  // hard failure. The widget never shows canned sample devices on a real boot,
  // and keeps Create disabled until a real client is present, so a user can
  // never see a false "Created" while running against sample data.
  notReady: 'Connecting to Homey…',
  // Step 2 — goal + ready-by.
  goalLabel: 'Goal',
  readyByLabel: 'Ready by',
  previewButton: 'Preview',
  // Step 3 — preview + confirm.
  previewTitle: 'Preview',
  // Canonical "Scheduled" vocabulary (matches `SMART_TASK_LIST_STATUS_LABELS`
  // / `SMART_TASK_LIST_ROW_LABELS` and the terminology guide) rather than the
  // one-off noun "Runs": the preview's when-window is the same concept the list
  // chip names.
  scheduledLabel: 'Scheduled',
  energyLabel: 'Energy',
  costLabel: 'Cost',
  // The estimate is computed in isolation for this one candidate — surface the
  // caveat honestly rather than implying a guarantee (the
  // `DeferredObjectivePlanPreview` contract documents the same in-isolation
  // direction-of-error). Kept short for the 320–480 px widget.
  estimateCaveat: 'Estimate — the actual run may differ as prices and other tasks change.',
  createButton: 'Create smart task',
  backButton: 'Back',
  // Shown when the preview can't be projected (no price horizon yet, missing
  // device reading, price-aware optimisation off). Distinct from a hard error.
  // Avoids the reserved "plan" noun (`feedback_terminology_plan_vs_deadline`).
  previewUnavailable: 'Can’t preview this yet — no prices published for this window yet.',
  // Pending state on the Create button while the /create round-trip is in
  // flight. Distinct from `created` (the confirmed-success label): the button
  // must read as work-in-progress, never as success, until a `{ ok: true }`
  // create actually lands — otherwise a still-pending or later-failed create
  // would have flashed "Smart task created" before anything was persisted.
  creating: 'Creating…',
  // Shown briefly after a successful create before the widget resets.
  created: 'Smart task created',
  // Generic submit failure (rejected candidate / transient SDK miss).
  createError: 'Could not create the smart task. Check the goal and try again.',
  // A transient settings-write refusal (`write_conflict`): the goal was valid,
  // the persist just flaked, so the data is safe and a plain retry resolves it.
  // Distinct from `createError` so we never tell the user to "check the goal"
  // for a failure that has nothing to do with their input.
  writeConflict: 'Could not save the smart task just now. Try again.',
  // The previewed "Ready by" time slipped into the past between previewing and
  // confirming (the user lingered past the chosen minute). The create is
  // rejected rather than silently rolled to the next day so the created task
  // can never disagree with the window the preview promised — re-previewing
  // resolves a fresh future deadline. Retryable, not a hard failure.
  deadlinePassed: 'That ready-by time just passed. Preview again to pick a fresh time.',
  // Step 2 — optional "Extra permissions" disclosure. Collapsed and OFF by
  // default; a user opts in per task. The section hint stays honest about scope
  // (only to hit THIS deadline) and never implies more total power or a raised
  // cap (`feedback_hard_cap_is_physical`). The two toggle labels themselves come
  // from `SMART_TASK_EXTRA_PERMISSION_LABELS` so the widget, the settings-UI
  // breadcrumb, and runtime logs all read identically.
  extraPermissionsTitle: 'Extra permissions',
  extraPermissionsHint: 'Off unless you turn them on — only used to hit this deadline.',
  // Shown under the limit-lower-priority toggle when it is disabled: that
  // permission only has any effect alongside the budget one, so it is gated on it.
  limitLowerPriorityNeedsBudget: 'Turn on “May go over daily budget” to use this.',
} as const;

// Map a create rejection reason to the user-facing widget error line. Two cases
// get bespoke copy: the previewed deadline passing (tells the user to re-preview)
// and a transient write refusal (`write_conflict` — tells the user to retry,
// NOT to check a goal that was already valid). Every other rejection collapses
// to the generic submit-failure line. Lives in shared-domain so the widget never
// inlines the strings and runtime log breadcrumbs can reuse the same wording
// (`feedback_ui_text_shared_with_logs.md`). The argument is the widget
// reject-reason slug; an unknown slug falls through to `createError`.
export const resolveCreateSmartTaskRejectCopy = (reason: string | undefined): string => {
  if (reason === 'deadline_passed') return CREATE_SMART_TASK_WIDGET_COPY.deadlinePassed;
  if (reason === 'write_conflict') return CREATE_SMART_TASK_WIDGET_COPY.writeConflict;
  return CREATE_SMART_TASK_WIDGET_COPY.createError;
};

// Ready-by presets for the light, preset-driven deadline input. Each preset is
// a fixed local 24-hour "HH:mm" the server resolves to the next future
// occurrence (rolling to tomorrow if already past today). Morning-commute and
// evening times cover the common EV-charge / heat-by-bedtime cases without a
// heavy datetime picker. The user picks one of these anchor points directly —
// there is no fine-grained ±minutes control on the widget.
export type CreateSmartTaskReadyByPreset = {
  id: string;
  label: string;
  localTime: string;
};

export const CREATE_SMART_TASK_READY_BY_PRESETS: readonly CreateSmartTaskReadyByPreset[] = [
  { id: 'morning', label: '07:00', localTime: '07:00' },
  { id: 'midday', label: '12:00', localTime: '12:00' },
  { id: 'evening', label: '18:00', localTime: '18:00' },
  { id: 'night', label: '22:00', localTime: '22:00' },
];

export const CREATE_SMART_TASK_READY_BY_DEFAULT_ID = 'morning';

// Shared chip-tone slug union. Matches the `.plan-chip--*` CSS variants in
// `packages/settings-ui/public/style.css` (`info`, `muted`, `ok`, `warn`,
// `alert`). Typing the list-status variant map and the pending-hero tone
// resolver against the same union keeps the two Smart-task surfaces
// (list card / plan-detail pending hero) on a single tone vocabulary so a
// future tone tweak can't drift into one surface only.
export type SmartTaskChipTone = 'alert' | 'info' | 'muted' | 'ok' | 'warn';

// Pending-state chip tone for the "Building plan…" pill, shared between the
// Smart-tasks list card and the plan-detail pending hero. Picked `info`
// (low-key blue, "something's happening") over `muted` so the state the user
// most wants to spot on the list isn't styled as "ignore me". Per
// `feedback_layering_resolution_in_producer.md`, this is a flat producer-side
// resolver — consumers never branch on the state, they just call the helper.
export const resolveBuildingPlanChipTone = (): SmartTaskChipTone => 'info';

// Paused-state chip tone for "Paused — unplugged" — EV plugged-out / discharging
// session. `warn` (amber) signals the user must act (plug back in) without
// the alarm of `alert` (red, reserved for cannot-finish). Same producer-side
// resolution pattern as `resolveBuildingPlanChipTone` so both pending states
// share one tone vocabulary across the list and the pending hero.
export const resolvePausedUnpluggedChipTone = (): SmartTaskChipTone => 'warn';

// CSS modifier class suffix for each list status id (appended to `plan-chip--`).
// `building_plan` / `paused_unplugged` delegate to the shared pending-tone
// resolvers above so the list card and the plan-detail pending hero can never
// disagree on tone — the pending hero's `pendingChipTone` reads the same
// helpers.
export const SMART_TASK_LIST_STATUS_CHIP_VARIANT: Record<SmartTaskListStatusId, SmartTaskChipTone> = {
  building_plan: resolveBuildingPlanChipTone(),
  queued: 'muted',
  paused_unplugged: resolvePausedUnpluggedChipTone(),
  on_track: 'ok',
  at_risk: 'warn',
  cannot_meet: 'alert',
  satisfied: 'ok',
};

// Tone slug for the smart-task list card's "Ready by" accent row. The default
// `accent` (green) tone reads as "healthy" alongside an on-track chip; on
// at-risk / cannot-meet cards the accent green semantically contradicts the
// status pill.
//
// On `cannot_meet` the hero gradient and the status chip both go red; if the
// timestamp also went red, three red surfaces would stack on one card
// (alarming and redundant). Demote the timestamp to `warn` so the hero
// broadcasts context, the chip carries the definitive status, and the
// timestamp drops one tone without echoing the alert. `at_risk` and
// `cannot_meet` collapse to the same timestamp tone here — the chip
// preserves the distinction.
//
// Maps to 'neutral' (primary text, no colour) for healthy / pending / queued /
// satisfied states; 'warn' for at-risk / paused / cannot-meet. Colour on the
// Ready-by line is reserved to signal a PROBLEM — a healthy timestamp stays
// neutral so the brand green isn't overloaded onto a passive readout (it
// already carries nav-selection and primary actions elsewhere). The view layer
// renders `.deadline-list-card__when-row--neutral` / `--warn` / `--alert` per
// the resolved slug — never branches on status itself. The `--alert` CSS
// variant is currently unused by this resolver but kept in place for future
// status codes that may legitimately warrant the strongest tone on the line.
export type SmartTaskListReadyByTone = 'neutral' | 'warn' | 'alert';

// Total mapping (mirrors `SMART_TASK_LIST_STATUS_CHIP_VARIANT` above) so a new
// `SmartTaskListStatusId` member produces a TypeScript error here rather than
// silently falling through to the default tone.
const SMART_TASK_LIST_READY_BY_TONE: Record<SmartTaskListStatusId, SmartTaskListReadyByTone> = {
  building_plan: 'neutral',
  queued: 'neutral',
  paused_unplugged: 'warn',
  on_track: 'neutral',
  at_risk: 'warn',
  cannot_meet: 'warn',
  satisfied: 'neutral',
};

export const resolveSmartTaskListReadyByTone = (
  status: SmartTaskListStatusId,
): SmartTaskListReadyByTone => SMART_TASK_LIST_READY_BY_TONE[status];

// Inline status word appended to the smart-task list card's "Ready by" line so
// the at-risk / cannot-finish / paused signal isn't carried by colour alone
// (`.deadline-list-card__when-row--warn/--alert` were the sole differentiator,
// which a red-green-deficient user can't read off the timestamp). Returns null
// for healthy / pending / queued / satisfied states: green is the default-
// positive case and the status chip already names it ("On track"), so no extra
// word is warranted — only the non-healthy states need the redundant text cue.
//
// The word reuses the canonical `SMART_TASK_LIST_STATUS_LABELS` strings so the
// inline word and the status chip can never disagree (per
// `feedback_ui_text_shared_with_logs.md`). Producer-resolved keyed off status
// so the view never branches on `statusId` itself (per
// `feedback_layering_resolution_in_producer.md`). The total mapping mirrors
// `SMART_TASK_LIST_READY_BY_TONE` so a new status id is a compile error here
// rather than a silent fall-through.
const SMART_TASK_LIST_READY_BY_STATUS_WORD: Record<SmartTaskListStatusId, string | null> = {
  building_plan: null,
  queued: null,
  // The inline word is joined to the timestamp with an em-dash separator
  // ("Ready by … — <word>"). For paused we use the compressed widget label
  // ('Unplugged') rather than the full chip label ('Paused — unplugged'): the
  // latter carries its own em-dash, which would render a confusing double-dash
  // ("… — Paused — unplugged") on the Ready-by line. The chip still shows the
  // full label; this is the same sanctioned shared-domain string, not a new
  // variant.
  paused_unplugged: SMART_TASK_WIDGET_STATUS_LABELS.paused_unplugged,
  on_track: null,
  at_risk: SMART_TASK_LIST_STATUS_LABELS.at_risk,
  cannot_meet: SMART_TASK_LIST_STATUS_LABELS.cannot_meet,
  satisfied: null,
};

export const resolveSmartTaskListReadyByStatusWord = (
  status: SmartTaskListStatusId,
): string | null => SMART_TASK_LIST_READY_BY_STATUS_WORD[status];

// Confidence chip label shown on the live hero and the Smart-tasks list card.
// Centralised so the two surfaces stay phrased identically. High confidence is
// the normal state and carries no useful chip signal; low / medium confidence
// render as short action-state words rather than bare quality scores.
export const formatConfidenceChipLabel = (
  confidence: ObjectiveProfileConfidence | null | undefined,
): string | null => {
  if (confidence === 'low') return 'Estimating';
  if (confidence === 'medium') return 'Refining';
  return null;
};

// Min accepted samples before the learned rate stops being treated as
// cold-start. Mirrors the planner's variance-buffer floor: below this the rate
// is genuinely provisional ("Estimating"); at or above it the device is
// learned, and a persistently `low` confidence reflects inherent variance, not
// a cold start — so it must not keep nagging.
export const MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP = 4;

// True only during genuine cold-start: the rate is a bootstrap default, or
// fewer than `MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP` accepted samples back it.
// Producer-resolved flat boolean — consumers never branch on source/samples.
export const resolveSmartTaskLearning = (
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined,
): boolean => {
  if (!provenance) return false;
  if (provenance.source === 'bootstrap') return true;
  return provenance.acceptedSamples < MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP;
};

// Smart-task list confidence chip. Shown only during genuine cold-start
// (`learning`) and never on a settled task: `on_track` is silent (the steady
// case carries no useful signal and a forever-`low` thermal rate would nag),
// and `cannot_meet` already owns its row with the strongest state chip + body.
export const formatSmartTaskListConfidenceChipLabel = (params: {
  confidence: ObjectiveProfileConfidence | null | undefined;
  statusId: SmartTaskListStatusId;
  learning: boolean;
}): string | null => {
  if (params.statusId === 'cannot_meet' || params.statusId === 'on_track') return null;
  if (!params.learning) return null;
  return formatConfidenceChipLabel(params.confidence);
};

// Row label carries the owner/edit affordance so both the detail
// (`DeadlinePlan.tsx`) and list (`DeadlinesList.tsx`) surfaces signal that the
// Flow editor owns the toggle. Hoisted from the value to the label so the
// `(set via Flow)` scope reads as a property of the row (what kind of setting
// this is) rather than scoping to the last joined permission clause. Lives
// here so the wording can't drift between surfaces and runtime log
// breadcrumbs that share the same row label.
export const SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL = 'Extra permissions (set via Flow)';
export const SMART_TASK_LIMIT_LOWER_PRIORITY_DEVICES_NOTE = 'Lower-priority devices may be limited separately.';

// The canonical user-facing names for the two rescue permissions. Exported so
// the create-smart-task widget's "Extra permissions" toggles, the settings-UI
// breadcrumb, and runtime log breadcrumbs all use the SAME wording — never an
// inlined duplicate (`feedback_ui_text_shared_with_logs`).
export const SMART_TASK_EXTRA_PERMISSION_LABELS: Record<keyof DeferredObjectiveRescuePermissions, string> = {
  exemptFromBudget: 'May go over daily budget',
  limitLowerPriorityDevices: 'May limit lower-priority devices',
};

const SMART_TASK_RESCUE_MODE_SUFFIX: Record<DeferredObjectiveRescueMode, string> = {
  always: '',
  at_risk: ' if at risk',
};

export const formatSmartTaskExtraPermissionsValue = (
  rescue: DeferredObjectiveRescuePermissions | undefined,
): string | null => {
  const parts: string[] = [];
  if (rescue?.exemptFromBudget) {
    parts.push(
      `${SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget}${SMART_TASK_RESCUE_MODE_SUFFIX[rescue.exemptFromBudget]}`,
    );
  }
  if (rescue?.limitLowerPriorityDevices) {
    parts.push(
      `${SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices}`
      + `${SMART_TASK_RESCUE_MODE_SUFFIX[rescue.limitLowerPriorityDevices]}`,
    );
  }
  if (parts.length === 0) return null;
  return parts.join(' · ');
};

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
  return `currently ${Math.round(params.currentValue)} %`;
};

// Eyebrow + empty-state copy for the Smart-tasks history surfaces.
// Kept in shared-domain so logging breadcrumbs and the UI render the same
// strings (per `feedback_ui_text_shared_with_logs.md`).
//
// Note: `Smart task` not `Smart task plan` — `feedback_terminology_plan_vs_deadline`
// reserves the "plan" noun for the planner layer; user copy uses "smart task"
// for the user-facing schedule entity.
export const SMART_TASK_HISTORY_EYEBROW = 'Smart task';

// Section heading for the Smart-tasks history archive ("Past tasks"). Shared
// across the loading / empty / ready states of the history list so the heading
// wording can't drift between the three render branches, and runtime log
// breadcrumbs render the identical string (per
// `feedback_ui_text_shared_with_logs.md`).
export const SMART_TASK_PAST_HEADING = 'Past tasks';

// Visually-hidden loading label announced while the history archive fetches.
// Sits beside the heading so the announced wording stays in step with the
// section title.
export const SMART_TASK_PAST_LOADING_LABEL = 'Loading past tasks…';

export const SMART_TASK_PAST_EMPTY_COPY = 'No completed tasks yet — they\'ll appear here after a smart task finishes.';

// Lead label for the past-tasks 7-day hit-rate strip (PR-10). Sits above the
// weekly archive so the recovering-from-mistake user gets a single-glance
// "how did this week go?" signal without rescanning the per-row chips.
// Kept here so runtime log breadcrumbs and the UI render identical strings
// (per `feedback_ui_text_shared_with_logs.md`); the window length (7 days)
// is part of the user-facing copy on purpose — naming the horizon makes the
// strip stand on its own without a tooltip.
//
// ", all devices" disambiguates the strip's scope from the calendar-week
// dividers directly below it: the strip is a rolling 7-day window summed
// across every device and is unaffected by the device-filter chips (it
// resolves from the unfiltered entry list), whereas the week dividers are
// calendar buckets that narrow when a device filter is active. Without the
// cue, an "all devices" strip count sitting above a filtered "This week"
// count reads as two contradictory totals for the same period.
export const SMART_TASK_LIST_7DAY_HIT_RATE_LABEL = 'Last 7 days, all devices';
// Trailing fragment for the hit-rate value. The percent is succeeded ÷
// (succeeded + missed); abandoned/replaced runs are excluded from the
// denominator. The earlier bare `67% hit rate` form hid that denominator, so
// on a strip reading `8 succeeded · 3 missed · 1 abandoned · …` the user had
// no way to see the percent was 8/11≈73% (over the 11 finished runs) rather
// than 8/12 (over all 12). Naming the denominator ("of 11 finished") makes the
// percent reconcile with the counts beside it without changing the math.
//
// "finished" names the succeeded + missed runs the rate is computed over: a
// run that succeeded or missed reached its deadline and got a verdict, so it
// finished; an abandoned/replaced run stopped early and did not, which is why
// it sits outside the denominator. Kept here so runtime log breadcrumbs and
// the UI render the identical fragment (per `feedback_ui_text_shared_with_logs.md`).
export const SMART_TASK_LIST_HIT_RATE_FINISHED_NOUN = 'finished';

// Composes the legible hit-rate fragment ("73% of 11 finished"). `percent` is
// the already-rounded integer the producer computed; `finishedCount` is the
// denominator (succeeded + missed). The producer
// (`resolvePlanHistory7DayHitRateStrip`) owns the arithmetic and only calls
// this helper to phrase the result, so the visible string stays single-sourced.
export const formatSmartTaskHitRateFragment = (
  percent: number,
  finishedCount: number,
): string => `${percent}% of ${finishedCount} ${SMART_TASK_LIST_HIT_RATE_FINISHED_NOUN}`;

// Row labels for the Smart-tasks list card's `<dl>` block (Target / Starts /
// Ready by). Lifted to shared-domain so runtime log breadcrumbs and the UI
// render identical labels (per `feedback_ui_text_shared_with_logs.md`). The
// three labels stay grouped so the list-card surface reads them from a single
// record rather than three loose imports. The `Created` row was dropped from
// the list card because it duplicated `Starts` in nearly every case (a task
// starts on creation); the detail page still shows the created timestamp for
// its audit-trail use case, but reads it directly off the plan-history entry.
export const SMART_TASK_LIST_ROW_LABELS = {
  target: 'Target',
  starts: 'Starts',
  readyBy: 'Ready by',
} as const;

// Word sources for the dashboard widget so its renderer never hardcodes
// user-facing copy (per `feedback_ui_text_shared_with_logs`). Declared after
// `SMART_TASK_LIST_ROW_LABELS` because they reuse it.
//
// The ETA verb pairs the canonical `Ready by` with a `Due` variant for failing
// tasks, where `Ready by HH:MM` next to a `Cannot finish` chip reads as
// contradictory.
export const SMART_TASK_WIDGET_DUE_VERB = 'Due';

export const resolveSmartTaskWidgetEtaVerb = (isFailing: boolean): string => (
  isFailing ? SMART_TASK_WIDGET_DUE_VERB : SMART_TASK_LIST_ROW_LABELS.readyBy
);

// Kind-aware target action verb ("Heat to 65 °C" / "Charge to 80 %"). Kept
// beside the other kind-aware smart-task vocabulary so the heat/charge split
// can't drift; the "temperature never says charge" rule
// (`notes/ui-terminology.md`) is enforced by the kind key.
const SMART_TASK_WIDGET_TARGET_ACTION_VERB: Record<'temperature' | 'ev_soc', string> = {
  temperature: 'Heat to',
  ev_soc: 'Charge to',
};

export const resolveSmartTaskWidgetTargetActionVerb = (
  kind: 'temperature' | 'ev_soc',
): string => SMART_TASK_WIDGET_TARGET_ACTION_VERB[kind];

// Single hour/hours pluralizer shared across the smart-task surfaces (sample
// freshness line here, the create-smart-task scheduled-window helper in
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
  unitSymbol: '°C' | '%',
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
  unitSymbol: '°C' | '%';
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
export const formatSmartTaskGoalContextLine = (params: {
  goalValue: number;
  currentValue: number | null;
  unitSymbol: '°C' | '%';
}): string => {
  const goalLabel = formatSmartTaskGoalValue(params.goalValue, params.unitSymbol);
  if (params.currentValue === null || !Number.isFinite(params.currentValue)) {
    return `Goal ${goalLabel}`;
  }
  const nowLabel = formatSmartTaskGoalValue(params.currentValue, params.unitSymbol);
  if (nowLabel === goalLabel) return `Goal ${goalLabel}`;
  if (params.goalValue > params.currentValue) return `from ${nowLabel} → ${goalLabel}`;
  return `Goal ${goalLabel} · now ${nowLabel}`;
};

// "Target" noun for the list values line when no current reading is available.
// Re-exported from the canonical list-row label so the widget and the
// settings-UI list card share one source.
export const SMART_TASK_WIDGET_TARGET_NOUN = SMART_TASK_LIST_ROW_LABELS.target;

// Empty-state copy for the Smart-tasks list when no smart tasks have been
// scheduled yet. Split into discrete fragments so the JSX renderer can wrap
// the action names in `<strong>` and the example sentences in `<em>` without
// the strings drifting from this canonical source. Runtime log breadcrumbs
// join the fragments with single spaces to recover the full sentence.
export const SMART_TASK_LIST_EMPTY_COPY = {
  intro: 'No smart tasks yet. Open the Flow editor and add the',
  heatingAction: 'Add heating task',
  actionWord: 'action',
  // User-outcome phrasing, not the internal Flow-card field name. The earlier
  // "(Heat … to … °C by Ready by)" leaked the literal `Ready by` input label —
  // it read as a placeholder, not a sentence; this states what the task
  // achieves. Stays on-vocabulary per `notes/ui-terminology.md` (temperature
  // says "temperature", never "charge"; EV says "percent").
  heatingExample: '(heat a device to a target temperature by a time)',
  conjunction: 'or the',
  chargingAction: 'Add charging task',
  chargingExample: '(charge a device to a target percent by a time)',
  outro: 'to schedule a device for a specific ready-by time.',
} as const;

// Banner copy for the Smart-tasks list when the bootstrap fetch fails. Lifted
// to shared-domain so runtime log breadcrumbs and the UI render the same
// sentence (per `feedback_ui_text_shared_with_logs.md`).
export const SMART_TASK_LIST_LOAD_ERROR_COPY = 'Could not load smart tasks. Try again later.';

// Error/loading banner copy for the deadline-plan SPA route. Lifted to
// shared-domain so runtime log breadcrumbs and the UI render identical
// wording (per `feedback_ui_text_shared_with_logs.md`); the "plan" noun is
// reserved for the planner layer (`notes/ui-terminology.md § Plan vs deadline`)
// so each surface here names the user-facing entity ("smart task") instead.
//
// `SMART_TASK_BANNER_LOAD_ERROR_PREFIX` is concatenated with a transport-level
// cause sentence so the user sees both the framing and the underlying failure;
// the trailing space + colon is part of the constant so callers don't drift on
// punctuation.
export const SMART_TASK_BANNER_LOAD_ERROR_PREFIX = 'Smart task data could not be loaded: ';
export const SMART_TASK_BANNER_UNAVAILABLE_TITLE = 'Smart task unavailable';
export const SMART_TASK_BANNER_UNAVAILABLE_FOR_DEVICE = 'Smart task data is not available for this device.';
export const SMART_TASK_BANNER_RECORD_NOT_FOUND_TITLE = 'Smart task record not found';
export const SMART_TASK_BANNER_RECORD_NOT_FOUND_BODY = 'This past smart task is no longer recorded. '
  + 'Older entries roll off as new ones are saved. Return to Smart tasks to see what is still available.';
export const SMART_TASK_LOADING_LABEL = 'Loading smart task…';

export const SMART_TASK_USAGE_RETURN_DEFAULT_HREF = './?page=deadline-plan';
export const SMART_TASK_USAGE_RETURN_LABEL = SMART_TASK_HISTORY_EYEBROW;
export const SMART_TASK_USAGE_RETURN_CONTEXT = 'Showing household usage.';

// Resolve the list card status id from plan data.
// `nowMs` is used to distinguish the `queued` id (plan ready, first action in
// future — labelled "Scheduled" in the UI) from other non-pending states.
//
// `diagnosticReasonCode` carries the recorder's "current cause" signal — it
// is set even on plans with a cached `latest` revision (e.g. EV unplugged
// mid-plan). When present, it takes precedence over `planStatus` so the chip
// matches the device-card line.
export const resolveSmartTaskListStatus = (params: {
  pending: boolean;
  pendingReason: DeferredObjectiveActivePlanPendingReason | undefined;
  diagnosticReasonCode: DeferredObjectiveActivePlanDiagnosticReason | undefined;
  planStatus: 'at_risk' | 'cannot_meet' | 'invalid' | 'on_track' | 'satisfied' | undefined;
  firstActionAtMs: number | null;
  nowMs: number;
}): SmartTaskListStatusId => {
  const { pending, pendingReason, diagnosticReasonCode, planStatus, firstActionAtMs, nowMs } = params;

  // Unplugged-mid-plan: the recorder refreshes `diagnosticReasonCode` even on
  // non-pending plans so this branch fires regardless of whether `latest` is
  // still cached. Without this, the list chip would say "On track" while the
  // device-card line said "Charging paused — car unplugged".
  if (diagnosticReasonCode === 'objective_invalid_session') return 'paused_unplugged';

  if (pending || planStatus === undefined) {
    if (pendingReason === 'invalid_session') return 'paused_unplugged';
    return 'building_plan';
  }

  // Plan is ready — check if the first action is in the future (queued).
  if (firstActionAtMs !== null && firstActionAtMs > nowMs) return 'queued';

  if (planStatus === 'satisfied') return 'satisfied';
  if (planStatus === 'cannot_meet') return 'cannot_meet';
  if (planStatus === 'at_risk') return 'at_risk';
  // 'invalid' collapses to on_track at the list level; the detail page shows more.
  return 'on_track';
};

export type DeadlinePlanCompletedReason = 'deadline_passed';

// Whether tomorrow's prices arrive via a user-managed Flow (`external_flow`,
// the `flow` price scheme) or via PELS' own fetcher (`managed`, e.g. Norway
// spot or Homey Energy). `unknown` is the safe fallback when scheme can't be
// resolved — copy treats it like `managed` (passive wait).
export type DeadlinePendingPriceSource = 'external_flow' | 'managed' | 'unknown';

export type DeadlinePendingContext = {
  priceSource: DeadlinePendingPriceSource;
  // Pre-formatted local time of the last successful price refresh (e.g. "14:32"),
  // or null when no refresh has happened yet. Formatting lives in the caller so
  // shared-domain stays free of locale/Date helpers.
  lastFetchedShort: string | null;
  // Active task's device id (e.g. "homey:device:abc123"). Empty string when
  // the device snapshot hasn't loaded yet; device-side pending resolvers
  // (`device_data_missing`, `invalid_session`, `missing_capacity`) stamp this
  // onto the recourse so the click dispatcher can deep-link into the
  // device-settings overlay in one tap — matching the cannot-meet recourse
  // pattern (see `DeadlineCannotMeetRecourse.deviceId`).
  deviceId: string;
  // Device name (e.g. "Connected 300") so the per-reason headlineReason copy
  // can name the source of the stall ("PELS can't read the current temperature
  // from {device}"). Empty string is a safe fallback when the device snapshot
  // hasn't loaded yet; resolvers degrade to a kind-only sentence.
  deviceName: string;
  // Pre-formatted local time of the deadline (e.g. "07:00"), used by the
  // `awaiting_horizon_plan` resolver to surface the horizon the planner is
  // waiting on. Caller resolves so shared-domain stays free of locale helpers.
  deadlineTime: string;
};

// Recourse action surfaced under the cannot-finish hero body and the pending
// hero. The producer resolves a stable `targetTab` slug
// (Homey settings-UI shell tab id) so the view just forwards it to the click
// dispatcher without branching on cause codes. Adding a new action means
// adding a label here, picking a target tab, and the dispatcher in
// `deadlinePlanMount.ts` already handles the click → `showTab(targetTab)`
// flow.
//
// Cannot-meet branches (resolved in `resolveCannotMeetRecourse`):
//   daily-budget-exhausted        → `targetTab: 'budget'`
//                                   (per `feedback_hard_cap_is_physical.md`,
//                                   the recourse path is "lower the daily
//                                   budget," not "raise the hard cap").
//   device-side shortfall / other → `targetTab: 'overview'`
//                                   (where the device card hosts the in-app
//                                   detail drawer; reaching across surfaces
//                                   to the device-detail overlay directly
//                                   from the smart-task panel would couple
//                                   two otherwise-independent panels).
//
// Pending branches: `device_data_missing` and `missing_capacity` point at
// `targetTab: 'overview'` (same device-card surface). `invalid_session`
// (EV unplugged) and `awaiting_horizon_plan` carry no recourse — both
// resolve on their own when the user plugs in / when prices land.
export type DeadlineCannotMeetRecourse = {
  label: string;
  targetTab: string;
  // Optional deep-link target. When present, the click dispatcher fires the
  // `open-device-detail` custom event *after* landing on `targetTab` so the
  // user lands on the device-settings overlay in a single click. Carried as
  // a producer-resolved field so the consumer never branches on history-entry
  // source / evidence (per `feedback_layering_resolution_in_producer.md`).
  // Used today by the missed-history "Review device" recourse — the
  // user reads the postmortem and tapping the recourse opens the device that
  // missed, not just a tab list. Live-hero recourses leave this absent.
  deviceId?: string;
};

// `headlineReason` is the subline rendered below the pending headline — a
// short one-sentence answer to "why is this still building?". `recourse` is
// the actionable next step (when there is one); rendered as the same
// button shape PR 2 uses for the cannot-meet hero, with the same shell-tab
// dispatcher in `deadlinePlanMount.ts`. Both fields are nullable so a
// resolver can decline to fabricate either when honest absence is the right
// answer (e.g. `awaiting_horizon_plan` has no user-side recourse — the
// planner runs every ~5 min on its own).
export type DeadlinePendingCopy = {
  headline: string;
  body: string;
  headlineReason: string | null;
  recourse: DeadlineCannotMeetRecourse | null;
};

export type DeadlinePendingCopyResolver = (ctx: DeadlinePendingContext) => DeadlinePendingCopy;

// Headline-reason copy explaining *why* a queued smart task hasn't started yet.
// Lives in shared-domain so the same strings can also be emitted to the
// structured logger (per `feedback_ui_text_shared_with_logs.md`). Helper is
// pure — locale/Date formatting stays in the caller.
export type DeadlineHeadlineReasonResolverParams = {
  // First planned start time, pre-formatted by the caller (e.g. "16:00").
  // The producer resolves this from `firstChargingHour.startsAtMs`.
  firstPlannedTime: string;
  // True when the latest revision's `computedFromPricesUpTo` does not yet
  // reach the deadline (prices for tomorrow have not arrived). The caller
  // pre-resolves the comparison so shared-domain stays free of arithmetic on
  // optional timestamps.
  pricesShortOfDeadline: boolean;
  // Pre-formatted local time of the deadline (e.g. "16:00") used in the
  // "Waiting for tomorrow's prices through HH:MM" branch. Caller supplies
  // a formatter to keep shared-domain free of locale helpers.
  deadlineTime: string;
  // True when one or more horizon buckets in the run-up had their per-bucket
  // cap collapse to zero because the daily budget cap was hit.
  dailyBudgetExhausted: boolean;
};

// Returns null when none of the three primary cases apply (e.g. price-aware
// optimisation is off, or the hour was chosen on a non-price basis); the
// view layer suppresses the subline in that case rather than fabricating a
// reason. Honest absence beats invented copy here.
export type DeadlineHeadlineReasonResolver = (
  params: DeadlineHeadlineReasonResolverParams,
) => string | null;

export type DeadlineLabels = {
  kindChipLabel: string;
  activeChipLabel: string;
  // Hero eyebrow / section label. Kind-aware so the user-facing surface uses
  // "EV smart task" / "Heating smart task" instead of the planner-layer noun
  // "EV plan" / "Temperature plan". Per `notes/ui-terminology.md` §"Plan vs
  // deadline terminology".
  sectionLabel: string;
  // Live-state chip labels (kind-aware). The hero, smart-task list, and device
  // card all draw from this map so the three surfaces stay in sync. Replaces
  // the prior single `waitingChipLabel`; see `DeadlineLiveState`.
  liveStateChipLabel: Record<DeadlineLiveState, string>;
  atRiskChipLabel: string;
  cannotMeetChipLabel: string;
  deviceSeriesName: string;
  originalDeviceSeriesName: string;
  actualDeviceSeriesName: string;
  backgroundSeriesName: string;
  // Legend / series name for the target-progress line on the deadline-plan
  // chart. Kind-aware so users see "Charge level" for EV or "Temperature" for
  // thermal instead of the planner-layer "Target progress".
  progressSeriesName: string;
  // Chart-tooltip word for idle (not-planned) hours. Planned hours are already
  // identified by the device-series line ("Heating 2.0 kWh" / "Charging 2.0 kWh"),
  // so only the idle case needs its own copy line.
  planTooltipIdle: string;
  pendingHeroByReason: Record<DeadlinePlanPendingReason, DeadlinePendingCopyResolver>;
  unavailableByReason: Record<DeadlinePlanUnavailableReason, { headline: string; body: string }>;
  // Shortfall sentence for cannot-meet. The producer passes raw progress-unit
  // values (°C / %) only when they communicate something meaningful — energy
  // and time shortfalls render via this sentence too. We avoid rendering raw
  // °C deltas (e.g. "Short by about 41.9 °C") because users read those as a
  // device anomaly; the underlying truth is "the smart task can't reach the
  // target temperature in time", which the copy now states directly.
  cannotMeetShortfall: () => string;
  // Replaces the shortfall/fallback cannot-meet copy when the diagnostic
  // reports that the daily budget cap had been hit before the deadline.
  // Surfaces the budget — not the device or schedule — as the constraint so
  // the user knows where to look. The hard-cap-is-physical guideline forbids
  // suggesting the user raise their capacity hard cap; the recommended remedy
  // is a lower daily budget so future days reserve available power earlier.
  cannotMeetDailyBudgetExhausted: string;
  // Recourse-action labels for the cannot-finish hero. The producer resolves
  // which `kind` to surface based on the cause; the view renders one button
  // per call. Both labels live here so the strings stay in sync with the rest
  // of the smart-task copy (kind chip / device-card lines).
  //
  // `openOverview` omits `deviceId` — the producer
  // (`resolveCannotMeetRecourse`) spreads the active task's device id onto
  // the payload so the click dispatcher deep-links to the device-settings
  // overlay (mirrors `MISSED_HISTORY_RECOURSE_SHORTFALL` for history-detail).
  cannotMeetRecourse: {
    openBudget: DeadlineCannotMeetRecourse;
    openOverview: Omit<DeadlineCannotMeetRecourse, 'deviceId'>;
  };
  // Resolver for the "why is the smart task starting at HH:MM" subline that
  // sits below the queued headline. Branches resolve in this order:
  //   1. prices_short_of_deadline → "Waiting for tomorrow's prices through HH:MM."
  //   2. daily_budget_exhausted   → "Today's budget is full — next cheap window after midnight."
  //   3. cheaper window chosen    → "Cheaper than now — starts at HH:MM."
  //   4. none of the above        → null (the subline is suppressed).
  resolveQueuedHeadlineReason: DeadlineHeadlineReasonResolver;
  completedHero: { headline: string; body: string };
  targetUnit: '°C' | '%';
  planInputsCardTitle: string;
  planInputsRateRowLabel: string;
  planInputsMaxPowerRowLabel: string;
  perUnitRateUnit: 'kWh/°C' | 'kWh/%';
  // Subtext shown next to the "Energy per unit" row when the planner is using
  // a bootstrap kWh-per-unit value (no learned profile yet). `null` when the
  // kind has no bootstrap path — only EV SoC ships with one in v1.
  planInputsRateBootstrapNote: string | null;
  // User-friendly tooltip line for hours that were revised. Keys are the
  // revision reasons emitted by the active-plan recorder. Reasons that are not
  // expected to appear on revised hours (device_unavailable, measured_deviation)
  // are omitted; callers fall back to null for unknown keys.
  revisionReasonTooltipLine: Partial<Record<DeferredObjectiveActivePlanRevisionReason, string>>;
};

// Shared across all objective kinds — revision reasons are recorder-level
// concepts that don't vary by device category.
const REVISION_REASON_TOOLTIP_LINE: Partial<Record<DeferredObjectiveActivePlanRevisionReason, string>> = {
  flow_card: 'Updated after a flow card fired',
  prices_arrived: 'Updated as prices became available',
  objective_changed: 'Updated after the target changed',
  // Only fires when the planner consumed a newer price horizon than the
  // previous revision. `schedule_revised` carries internal replans.
  prices_revised: 'Updated as new prices arrived',
  // Schedule shifted without a new price horizon — daily-budget pressure
  // moved a bucket, planStatus flipped, etc. Honest about the cause without
  // claiming a publication event.
  schedule_revised: 'Updated as the schedule was revised',
  rate_refined: 'Updated as rates were refined',
  flow_permission_changed: 'Updated after a Flow changed what this smart task may do',
};

// Short "what changed" copy for the per-revision log on the smart-task history
// detail page. Reuses the same `DeferredObjectiveActivePlanRevisionReason` enum
// the recorder emits — strings here are deliberately tighter than
// `REVISION_REASON_TOOLTIP_LINE` (which sits in the live hover tooltip and can
// afford a sentence) because the history-detail surface stacks these in a
// vertical list.
//
// Per `feedback_ui_text_shared_with_logs.md`, copy lives in shared-domain so
// runtime log breadcrumbs and the history-detail view render identical labels.
//
// Reasons absent from this map fall through to `REVISION_REASON_FALLBACK` so
// the view never invents copy for a recorder code it hasn't yet learned about
// — better to surface "Plan refreshed" than to omit the entry entirely (which
// would silently under-count the revision log).
const REVISION_REASON_LABEL: Record<DeferredObjectiveActivePlanRevisionReason, string> = {
  flow_card: 'Updated by a Flow card',
  prices_arrived: 'Prices arrived',
  // Reserved for revisions where the planner saw a fresher price horizon
  // than the previous revision (Nordpool typically publishes 1–2 times per
  // day). Internal replans surface as `schedule_revised` so this label
  // doesn't claim a publication event that didn't happen.
  prices_revised: 'Tomorrow’s prices published',
  schedule_revised: 'Schedule revised',
  rate_refined: 'Rate estimate refined',
  objective_changed: 'Smart task settings changed',
  // Per `feedback_homey_sdk_unreliable.md`: a single SDK read miss triggers this
  // reason — the recorder doesn't witness a sustained "offline" state. Copy
  // names the *event the recorder saw* ("couldn't read"), not a state it
  // assumes.
  device_unavailable: 'Device was unreachable',
  // `measured_deviation` fires when observed delivery rate diverged from the
  // planned rate enough to trigger a replan. Naming the *cause-effect* (rate
  // differed → replan) reads more clearly than naming an abstract field
  // ("rate updated", which leaves the user asking which rate).
  measured_deviation: 'Measured rate differed from plan',
  // A Flow toggled a rescue permission (exempt-from-budget etc.), so PELS re-solved
  // under the new limits. Names the action the user took, per the transparency rule.
  flow_permission_changed: 'Flow changed what this smart task may do',
};

const REVISION_REASON_FALLBACK = 'Plan refreshed';

// View-facing fallback variant used when a row template wants to make the
// absent diff chip self-explanatory. `REVISION_REASON_FALLBACK` is the
// producer label (used for the live-panel summary line + runtime log
// breadcrumbs so those surfaces stay terse); the row templates on both the
// live-task panel and the post-finalization history-detail card render this
// longer variant when `isFallback === true` so the user understands why the
// row carries no `+/−Nh` chip. Per `feedback_ui_text_shared_with_logs.md`,
// view layers consume it from shared-domain rather than inlining the copy.
export const REVISION_REASON_FALLBACK_WITH_DETAIL = 'Plan refreshed (details unavailable)';

// Title for the live-task revision panel `<summary>` on the smart-task detail
// page. The "plan" noun is intentional here — this is the planning-layer
// revision panel, which `notes/ui-terminology.md` § "Plan vs deadline" sanctions
// (the reservation governs the user-facing schedule entity, not the planner's
// own surfaces). Sourced from shared-domain so the heading and runtime log
// breadcrumbs render the identical string (per
// `feedback_ui_text_shared_with_logs.md`).
export const REVISION_PANEL_TITLE = 'Recent plan changes';

// Optional disambiguation signals for `schedule_revised`. When the live-task
// surface passes these in, `revisionReason` returns a more specific label
// instead of the bare `Schedule revised`. History detail and runtime log
// breadcrumbs don't carry these signals on their entry shape (see
// `DeferredObjectivePlanHistoryRevisionLogEntry`) so they continue to render
// the bare label — and that's fine; the active panel is the surface where
// "why now?" matters most.
//
// All fields optional individually so callers can supply only what they have.
// The producer resolves precedence; consumers never branch on which signal
// drove the variant.
export type RevisionReasonDisambiguation = {
  // True when the prior revision's planStatus differed from this revision's.
  // Drives the `risk changed` variant when no budget / hour-add signal applies.
  planStatusChanged?: boolean;
  // Any positive value means the daily budget cap squeezed at least one bucket
  // on this revision. Drives the `daily budget shifted` variant.
  dailyBudgetExhaustedBucketCount?: number;
  // Producer-resolved verdict on what bound the floor schedule. Treated as the
  // strongest budget signal — overrides count-of-exhausted-buckets which can
  // stay at zero on the per-bucket background squeeze case.
  floorShortfallCause?: DeferredObjectiveActivePlanFloorShortfallCause;
  // Hour-diff symmetric-difference counts vs the prior revision. Drives the
  // `cheaper hour opened` variant when hours grew without budget pressure.
  hoursAdded?: number;
  hoursRemoved?: number;
};

const SCHEDULE_REVISED_BASE = 'Schedule revised';
// Em-dash separator (U+2014) to match the typographic dash used elsewhere in
// the smart-task UI for `…—…` clauses.
const SCHEDULE_REVISED_BUDGET = `${SCHEDULE_REVISED_BASE} — daily budget shifted`;
const SCHEDULE_REVISED_RISK = `${SCHEDULE_REVISED_BASE} — risk changed`;
const SCHEDULE_REVISED_OPENED = `${SCHEDULE_REVISED_BASE} — cheaper hour opened`;

// Precedence for `schedule_revised` disambiguation. Budget is the strongest
// signal (the most actionable explanation for the user — "your daily budget
// caused the shift, here's how to relieve it"), then planStatus transition
// (risk story), then hour-add (optimizer found new affordable space). Falls
// through to the bare label when none of the signals are conclusive — better
// to under-promise than to mislabel.
const resolveScheduleRevisedLabel = (
  d: RevisionReasonDisambiguation,
): string => {
  const budgetExhausted = typeof d.dailyBudgetExhaustedBucketCount === 'number'
    && d.dailyBudgetExhaustedBucketCount > 0;
  const budgetCause = d.floorShortfallCause === 'budget';
  if (budgetExhausted || budgetCause) return SCHEDULE_REVISED_BUDGET;
  if (d.planStatusChanged === true) return SCHEDULE_REVISED_RISK;
  const added = typeof d.hoursAdded === 'number' ? d.hoursAdded : 0;
  const removed = typeof d.hoursRemoved === 'number' ? d.hoursRemoved : 0;
  if (added > 0 && removed === 0) return SCHEDULE_REVISED_OPENED;
  return SCHEDULE_REVISED_BASE;
};

// Resolved short-label record for a revision-reason code.
//
//   `label`        the short "what changed" copy. Always a non-empty string;
//                  unknown / falsy reason codes fall through to
//                  `REVISION_REASON_FALLBACK` so the view never has to invent
//                  copy for a recorder code it hasn't learned about.
//   `isFallback`   true when the reason code was unknown / falsy and the
//                  fallback label was used. Consumers can use this to suppress
//                  the hour-diff chip (the chip would otherwise misattribute
//                  the diff to a "Plan refreshed" line that says nothing about
//                  why hours changed), or to emit a one-shot logging
//                  breadcrumb so the gap gets noticed.
export type ResolvedRevisionReason = {
  label: string;
  isFallback: boolean;
};

// Resolves the per-revision label plus a structural `isFallback` flag for
// consumers that want to treat unknown-code rows differently. See the
// `ResolvedRevisionReason` doc for the contract.
//
// `kind` is accepted so callers (heating vs EV) can pass it without branching
// at the call site — the underlying copy is kind-agnostic today because
// revision causes are recorder-level events (a price publish is a price
// publish regardless of device category). The parameter name is prefixed `_`
// to reserve the slot for future kind-aware copy without churning every
// caller.
//
// `disambiguation` is honored only when `reasonId === 'schedule_revised'`;
// other reason codes already carry enough signal in the code itself. Callers
// that don't have the disambiguation signals (history detail entries,
// runtime log breadcrumbs) omit the third arg and get the bare
// `Schedule revised` — the same string they got before this resolver
// learned to disambiguate.
export const resolveRevisionReason = (
  reasonId: string | null | undefined,
  _kind: DeferredObjectiveSettingsKind,
  disambiguation?: RevisionReasonDisambiguation,
): ResolvedRevisionReason => {
  if (!reasonId) return { label: REVISION_REASON_FALLBACK, isFallback: true };
  if (Object.prototype.hasOwnProperty.call(REVISION_REASON_LABEL, reasonId)) {
    if (reasonId === 'schedule_revised' && disambiguation) {
      return { label: resolveScheduleRevisedLabel(disambiguation), isFallback: false };
    }
    return {
      label: REVISION_REASON_LABEL[reasonId as DeferredObjectiveActivePlanRevisionReason],
      isFallback: false,
    };
  }
  return { label: REVISION_REASON_FALLBACK, isFallback: true };
};

// Thin wrapper preserving the original `revisionReason` signature for callers
// that don't need the `isFallback` flag (history detail rows, runtime log
// breadcrumbs). Live-task surfaces should prefer `resolveRevisionReason`.
export const revisionReason = (
  reasonId: string | null | undefined,
  kind: DeferredObjectiveSettingsKind,
  disambiguation?: RevisionReasonDisambiguation,
): string => resolveRevisionReason(reasonId, kind, disambiguation).label;

const withLastFetched = (base: string, lastFetchedShort: string | null): string => (
  lastFetchedShort ? `${base} Last price update: ${lastFetchedShort}.` : base
);

// Shared across both kinds — the "why is the smart task starting at HH:MM"
// resolver branches on data the planner already publishes (`computedFromPricesUpTo`
// vs `deadlineAtMs`, `dailyBudgetExhaustedBucketCount`). The caller resolves
// the comparisons to flat booleans so this stays free of timestamp math.
const resolveQueuedHeadlineReason: DeadlineHeadlineReasonResolver = (params) => {
  if (params.pricesShortOfDeadline) {
    return `Waiting for tomorrow’s prices through ${params.deadlineTime}.`;
  }
  if (params.dailyBudgetExhausted) {
    return 'Today’s budget is full — next cheap window after midnight.';
  }
  return `Cheaper than now — starts at ${params.firstPlannedTime}.`;
};

// Shared recourse-action labels + target tabs across both kinds. The producer
// picks which one to surface based on cause; the chosen object is the only
// payload the view layer sees. Both `targetTab` values resolve to shell tab
// ids defined in `packages/settings-ui/public/index.html` (`#shell-nav
// [data-tab]`); keep this list in sync if those tab ids change.
//
// `openOverview` omits `deviceId` here so the producer (`resolveCannotMeetRecourse`
// in `deadlinePlanHero.ts`) can spread the active task's device id onto the
// payload — mirroring the history-detail "Review device" pattern in
// `MISSED_HISTORY_RECOURSE_SHORTFALL` so one click closes the panel and opens
// the device-settings overlay instead of dead-ending on the Overview tab.
const CANNOT_MEET_RECOURSE: {
  openBudget: DeadlineCannotMeetRecourse;
  openOverview: Omit<DeadlineCannotMeetRecourse, 'deviceId'>;
} = {
  openBudget: { label: 'Open Budget', targetTab: 'budget' },
  openOverview: { label: 'Adjust device', targetTab: 'overview' },
};

// Recourse target for the pending-hero device-side branches
// (`device_data_missing`, `invalid_session`, `missing_capacity`). The Overview
// tab hosts the device card where the user verifies status / capacity. We
// pick a single, kind-aware label so the button reads as "where the device
// lives", not "Adjust device" (which the cannot-meet branch already uses for
// the post-plan-failure case and would mislead in a pre-plan pending state).
// Resolvers spread `deviceId` from the pending context so the click dispatcher
// deep-links to the device-settings overlay in one tap (mirrors the live
// cannot-meet recourse).
const OVERVIEW_DEVICE_RECOURSE_BASE = { label: 'Open device in Overview', targetTab: 'overview' };
const overviewDeviceRecourse = (deviceId: string): DeadlineCannotMeetRecourse => (
  { ...OVERVIEW_DEVICE_RECOURSE_BASE, deviceId }
);

// `awaiting_horizon_plan` is the most common pending reason — the planner
// runs every ~5 min and needs prices through the deadline. `headlineReason`
// repeats the salient horizon time at headline height so the user knows what
// they're waiting on; `recourse` is null because the planner replans itself
// when prices arrive (no user action).
const awaitingHorizonCopy = (kindNoun: 'heat plan' | 'charging plan'): DeadlinePendingCopyResolver => (
  (ctx) => {
    const isFlow = ctx.priceSource === 'external_flow';
    const body = isFlow
      ? `PELS needs prices through the deadline before it can build a ${kindNoun}. `
        + 'In flow price mode, prices arrive only when a Flow calls the '
        + '“Set external prices (tomorrow)” action. Check the Flow that publishes prices '
        + 'if this message stays up after tomorrow’s prices should have arrived.'
      : `PELS will build a ${kindNoun} as soon as prices through the deadline are available.`;
    return {
      headline: isFlow ? 'Waiting for tomorrow’s prices from your Flow' : 'Waiting for tomorrow’s prices',
      body: withLastFetched(body, ctx.lastFetchedShort),
      // Avoid restating "Waiting for tomorrow’s prices" from the headline; the
      // panic-visitor's actionable detail is the horizon time the planner
      // needs to cover.
      headlineReason: `Need prices through ${ctx.deadlineTime} before the smart task can start.`,
      recourse: null,
    };
  }
);

// `device_data_missing` / `missing_capacity` (and the thermal fall-through
// for `invalid_session`) share one resolver — same headline, same body, same
// recourse — keyed by the kind's reading-word + device-noun fallback.
// Shared with structured-log breadcrumbs (`feedback_ui_text_shared_with_logs`).
const deviceDataMissingResolver = (kind: {
  headline: string;
  body: string;
  readingNoun: 'current temperature' | 'state of charge';
  fallbackDeviceNoun: 'the heater' | 'the EV';
}): DeadlinePendingCopyResolver => (ctx) => ({
  headline: kind.headline,
  body: kind.body,
  headlineReason: `PELS can’t read the ${kind.readingNoun} from `
    + `${ctx.deviceName.trim() || kind.fallbackDeviceNoun}.`,
  recourse: overviewDeviceRecourse(ctx.deviceId),
});

// Split `PENDING_REASON_MISSING_CAPACITY_COPY` into the headline tag and the
// metaLine sentence at the em-dash separator, then re-capitalise the body so
// it reads as a complete sentence in the muted metaLine slot. Done once at
// module load so the constant stays the canonical user-facing string and the
// resolver doesn't drift if the wording is tweaked later. The asserted shape
// is `<headline> — <body-fragment>` (em-dash + space on each side); the
// constant lives at the top of this file with the same shape.
const [MISSING_CAPACITY_HEADLINE, MISSING_CAPACITY_BODY_FRAGMENT]
  = PENDING_REASON_MISSING_CAPACITY_COPY.split(' — ');
const MISSING_CAPACITY_BODY = `${MISSING_CAPACITY_BODY_FRAGMENT[0].toUpperCase()}`
  + `${MISSING_CAPACITY_BODY_FRAGMENT.slice(1)}`;

const HEATER_DEVICE_DATA_MISSING = deviceDataMissingResolver({
  headline: 'Waiting for a reading from the device',
  body: 'PELS needs a current temperature, a useful capacity, or a recent observation '
    + 'from this heater before it can plan the smart task.',
  readingNoun: 'current temperature',
  fallbackDeviceNoun: 'the heater',
});

const EV_DEVICE_DATA_MISSING = deviceDataMissingResolver({
  headline: 'Waiting for a reading from the EV',
  body: 'PELS needs a current state of charge, a charge rate, or a recent observation '
    + 'from this EV before it can plan the smart task.',
  readingNoun: 'state of charge',
  fallbackDeviceNoun: 'the EV',
});

const DEADLINE_LABELS: Record<DeferredObjectiveSettingsKind, DeadlineLabels> = {
  temperature: {
    kindChipLabel: 'Temperature',
    activeChipLabel: 'Heating',
    sectionLabel: 'Heating smart task',
    liveStateChipLabel: {
      active: 'Heating',
      building_plan: 'Building plan…',
      queued: 'Scheduled',
      // Thermal devices can't be unplugged; the variant is unreachable here
      // and falls back to the generic scheduled copy if the resolver ever
      // hands a stale value through.
      paused_unplugged: 'Scheduled',
      ok: 'On track',
    },
    atRiskChipLabel: SMART_TASK_LIST_STATUS_LABELS.at_risk,
    cannotMeetChipLabel: 'Cannot finish',
    deviceSeriesName: 'Heating',
    originalDeviceSeriesName: 'Original Heating',
    actualDeviceSeriesName: 'Measured Heating',
    backgroundSeriesName: 'Background usage',
    progressSeriesName: 'Temperature',
    planTooltipIdle: 'Idle',
    // Thermal `invalid_session` is unreachable today (heaters can't be
    // unplugged); we map it to `device_data_missing` so a future diagnostic
    // can't leak EV-specific copy. `missing_capacity` is the cold-start
    // "learning energy profile" state — no shipped bootstrap kWh/°C — and
    // recourse lands on Overview where the user can verify the heater is
    // actually running and reporting power.
    pendingHeroByReason: {
      awaiting_horizon_plan: awaitingHorizonCopy('heat plan'),
      price_feature_disabled: () => ({
        headline: 'Price-aware optimisation is off',
        body: 'Enable price-aware optimisation in Settings → Electricity prices to compute a heat plan.',
        headlineReason: 'Price-aware optimisation is off in Settings.',
        recourse: { label: 'Open Settings', targetTab: 'settings' },
      }),
      device_data_missing: HEATER_DEVICE_DATA_MISSING,
      invalid_session: HEATER_DEVICE_DATA_MISSING,
      // Cold-start `missing_capacity` collapses to a single user-facing line —
      // headline + metaLine combined parse as `PENDING_REASON_MISSING_CAPACITY_COPY`
      // ("Learning energy use — needs power readings from this device."). Earlier
      // copy split the explanation across body + headlineReason, which buried the
      // "give it power readings" lever in a paragraph. The pending-reason path
      // here intentionally addresses only `objective_missing_capacity`
      // (no-profile cold-start); the thermal `objective_missing_charge_rate`
      // fall-through still routes to this resolver via `THERMAL_LEARNING_CAPACITY_REASON_CODES`
      // in the recorder, which is the same "still learning" user state from
      // their point of view.
      missing_capacity: (ctx) => ({
        headline: MISSING_CAPACITY_HEADLINE,
        body: MISSING_CAPACITY_BODY,
        headlineReason: null,
        recourse: overviewDeviceRecourse(ctx.deviceId),
      }),
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first temperature reading',
        body: 'The schedule will appear once the device reports its current temperature.',
      },
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The current temperature already meets the smart task target. PELS will schedule it '
          + 'again if the temperature drops below target.',
      },
    },
    // Drops the raw progress-unit delta ("Short by about 41.9 °C") that users
    // misread as a wild temperature anomaly. The underlying shortfall is energy
    // / time against the plan, not a raw temperature gap; the chip + headline
    // already say the verdict ("Cannot finish"); body states the cause and the
    // user-side levers. The hero meta line follows with the "Needs N kWh · Y
    // hours left · …" line via `formatMetaLine`, which is the right surface for
    // magnitude. Recourse copy names the two levers that aren't the daily
    // budget; the budget remedy is handled by the dedicated
    // `cannotMeetDailyBudgetExhausted` branch above.
    cannotMeetShortfall: () => (
      'Not enough time for this target. Lower the target or move the deadline.'
    ),
    cannotMeetDailyBudgetExhausted: 'Today\'s daily budget is fully booked. '
      + 'Lower it so future days reserve power earlier, or move the deadline.',
    cannotMeetRecourse: CANNOT_MEET_RECOURSE,
    resolveQueuedHeadlineReason,
    completedHero: {
      headline: 'Smart task finished',
      body: 'See Smart tasks for the outcome.',
    },
    targetUnit: '°C',
    planInputsCardTitle: 'What PELS has learned',
    planInputsRateRowLabel: 'Energy needed per °C',
    planInputsMaxPowerRowLabel: 'Device power used',
    perUnitRateUnit: 'kWh/°C',
    planInputsRateBootstrapNote: null,
    revisionReasonTooltipLine: REVISION_REASON_TOOLTIP_LINE,
  },
  ev_soc: {
    kindChipLabel: 'EV',
    activeChipLabel: 'Charging',
    sectionLabel: 'EV smart task',
    liveStateChipLabel: {
      active: 'Charging',
      building_plan: 'Building plan…',
      queued: 'Scheduled',
      paused_unplugged: 'Paused — unplugged',
      ok: 'On track',
    },
    atRiskChipLabel: SMART_TASK_LIST_STATUS_LABELS.at_risk,
    cannotMeetChipLabel: 'Cannot finish',
    deviceSeriesName: 'Charging',
    originalDeviceSeriesName: 'Original Charging',
    actualDeviceSeriesName: 'Measured Charging',
    backgroundSeriesName: 'Background usage',
    progressSeriesName: 'Charge level',
    planTooltipIdle: 'Idle',
    // EV `invalid_session` is the plugged-out / discharging pause state. The
    // body already says "PELS will resume…", the headlineReason restates the
    // *cause* at headline height, and recourse is null because plugging in
    // is a physical action with no in-app tab to land on. EV
    // `missing_capacity` should never fire (bootstrap fallback exists); the
    // device-data-missing copy is kept as a safety net.
    pendingHeroByReason: {
      awaiting_horizon_plan: awaitingHorizonCopy('charging plan'),
      price_feature_disabled: () => ({
        headline: 'Price-aware optimisation is off',
        body: 'Enable price-aware optimisation in Settings → Electricity prices to compute a charging plan.',
        headlineReason: 'Price-aware optimisation is off in Settings.',
        recourse: { label: 'Open Settings', targetTab: 'settings' },
      }),
      device_data_missing: EV_DEVICE_DATA_MISSING,
      invalid_session: () => ({
        headline: 'Charging paused — EV unplugged',
        body: 'PELS will resume the schedule once the EV is plugged in and reports a valid '
          + 'charging session.',
        headlineReason: 'Charger reports the car isn’t plugged in.',
        recourse: null,
      }),
      missing_capacity: EV_DEVICE_DATA_MISSING,
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first state-of-charge reading',
        body: 'The schedule will appear once the EV reports its current state of charge.',
      },
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The EV is already at or above the smart task target. PELS will schedule it again '
          + 'if the state of charge drops below target.',
      },
    },
    // EV mirrors the thermal copy: drop the raw % shortfall figure (users can
    // read it as "the car lost 30 % of charge") in favour of plain-language
    // recourse. The meta line continues to carry the energy/duration magnitude.
    cannotMeetShortfall: () => (
      'Not enough time or charging power for this target. Lower the target or move the deadline.'
    ),
    cannotMeetDailyBudgetExhausted: 'Today\'s daily budget is fully booked. '
      + 'Lower it so future days reserve power earlier, or move the deadline.',
    cannotMeetRecourse: CANNOT_MEET_RECOURSE,
    resolveQueuedHeadlineReason,
    completedHero: {
      headline: 'Smart task finished',
      body: 'See Smart tasks for the outcome.',
    },
    targetUnit: '%',
    planInputsCardTitle: 'What PELS has learned',
    planInputsRateRowLabel: 'Energy needed per %',
    planInputsMaxPowerRowLabel: 'Device power used',
    perUnitRateUnit: 'kWh/%',
    planInputsRateBootstrapNote: 'Estimated — refining as PELS observes charging.',
    revisionReasonTooltipLine: REVISION_REASON_TOOLTIP_LINE,
  },
};

export const deadlineLabels = (kind: DeferredObjectiveSettingsKind): DeadlineLabels => DEADLINE_LABELS[kind];

// ─── EV device-card state lines ───────────────────────────────────────────────

const EV_CARD_HOUR_MS = 60 * 60 * 1000;

export type EvCardStateLine =
  | { kind: 'next_start'; text: string }
  | { kind: 'active_charging'; text: string }
  | { kind: 'plug_out_paused'; text: string }
  | { kind: 'none' };

// Resolve the most-actionable EV state line for a device card.
//
// Priority (most actionable first):
//   1. Active charging: current bucket is planned → show planned finish time.
//   2. Next planned start: a future first bucket exists → show its start time.
//   3. Plug-out paused: session is invalid (car unplugged) → static message.
//
// `isPlugOutPaused` comes from the diagnostic reason `objective_invalid_session`.
// `formatTime` is supplied by the caller (UI layer) so shared-domain stays
// free of locale/Date helpers — see the rule on `DeadlinePendingContext`.
export const resolveEvCardStateLine = (params: {
  hours: ReadonlyArray<{ startsAtMs: number }>;
  nowMs: number;
  isPlugOutPaused: boolean;
  formatTime: (ms: number) => string;
}): EvCardStateLine => {
  const { hours, nowMs, isPlugOutPaused, formatTime } = params;

  if (hours.length > 0) {
    const lastHour = hours[hours.length - 1];
    const lastHourEndMs = lastHour.startsAtMs + EV_CARD_HOUR_MS;
    // Active charging requires `nowMs` to fall inside one of the planned
    // hour buckets, not just between first and last. EV schedules can be
    // non-contiguous (e.g. planned hours at 01:00 and 05:00 with `now` at
    // 03:00); during a gap the card should show "Waiting · charging starts
    // HH:MM" with the next planned hour, not the active-charging line.
    const insidePlannedHour = hours.some(
      (hour) => hour.startsAtMs <= nowMs && hour.startsAtMs + EV_CARD_HOUR_MS > nowMs,
    );
    if (insidePlannedHour) {
      return { kind: 'active_charging', text: `Charging · planned finish ${formatTime(lastHourEndMs)}` };
    }
    const nextHour = hours.find((hour) => hour.startsAtMs > nowMs);
    if (nextHour !== undefined) {
      return { kind: 'next_start', text: `Waiting · charging starts ${formatTime(nextHour.startsAtMs)}` };
    }
  }

  if (isPlugOutPaused) {
    return { kind: 'plug_out_paused', text: 'Charging paused — car unplugged' };
  }

  return { kind: 'none' };
};

// ─── Smart task status token id ──────────────────────────────────────────────

// Stable lowercase ids surfaced by the `deadline_status_changed` flow-card
// `status` token. This is a **frozen public-API contract**: renaming a value
// breaks user flows that filter on it. Repeated here (rather than imported
// from `flowCards/`) because shared-domain must not pull from runtime layers.
//
// Intentionally distinct from `SmartTaskListStatusId` above — that one is the
// richer UI list-card status (with `building_plan`, `queued`,
// `paused_unplugged`, `cannot_meet`) which is allowed to evolve as the UI
// grows. This one collapses those finer states to the five values flow
// authors filter against (`waiting` absorbs the three pending sub-states;
// `unachievable` is the trigger-side name for `cannot_meet`). Do not merge
// the two enums.
export type SmartTaskStatusNotificationId =
  | 'waiting'
  | 'on_track'
  | 'at_risk'
  | 'unachievable'
  | 'satisfied';

// ─── EV learning provenance rows ──────────────────────────────────────────────

// A row in the plan-inputs card describing one provenance fact (source, value,
// sample count, confidence, last accepted at). Pre-resolved at this layer so
// the view never branches on `source` / null values.
//
// `tone` is a producer-resolved affordance slug for the row's value cell. Null
// for neutral rows; `'warn'` signals an at-risk fact (e.g. the latest learned
// reading is older than 24 h). The view dispatches the slug to a CSS modifier
// (`.plan-inputs__row-value--warn`) so the value cell picks up a status colour
// instead of the row staying visually indistinguishable from healthy siblings.
// Per `feedback_layering_resolution_in_producer.md`, the staleness boolean
// stays in shared-domain — consumers never re-derive it from the value text.
//
// `freshnessOfMs` is set only on the "Latest reading used" row so the view can
// re-derive both `value` and `tone` on a 60s tick (without it the rendered
// "Updated 5 min ago" would freeze on the original render's `nowMs` until the
// next plan refresh — see TODO ~line 1160, v2.8.0 adversarial-review). The
// producer still emits a pre-formatted `value`/`tone` pair so non-React
// consumers (runtime breadcrumbs, the producer-side test) keep working
// unchanged. The view recomputes via `formatLastSampleValue` when this field
// is present — the tone can flip (`null` → `'warn'`) when a sample crosses
// the 24 h staleness threshold while the page is open.
export type KwhPerUnitProvenanceRowTone = 'warn';
export type KwhPerUnitProvenanceRow = {
  label: string;
  value: string;
  tone: KwhPerUnitProvenanceRowTone | null;
  freshnessOfMs?: number;
};

// Confidence text is rendered next to the learned mean. Lowercase to fit the
// neighbouring sentence ("12 readings · medium confidence"); the chip surface
// uses sentence-case copy elsewhere.
const CONFIDENCE_TEXT: Record<'low' | 'medium' | 'high', string> = {
  low: 'low confidence',
  medium: 'medium confidence',
  high: 'high confidence',
};

const formatSamplesLine = (acceptedSamples: number, confidence: 'low' | 'medium' | 'high' | null): string => {
  const sampleWord = acceptedSamples === 1 ? 'reading' : 'readings';
  const base = `${acceptedSamples} accepted power ${sampleWord}`;
  return confidence === null ? base : `${base} · ${CONFIDENCE_TEXT[confidence]}`;
};

// Freshness window before a learned profile counts as stale. After this, the
// row shows "Stale — <timestamp>" so the user knows the value behind the chip
// is older than yesterday's reality.
const SAMPLE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

// Browser-side relative-time text for the most recent accepted sample. Stays
// in shared-domain so runtime breadcrumbs and the UI render the same phrasing
// (per `feedback_ui_text_shared_with_logs.md`). The caller supplies
// `formatAcceptedAt` only for the stale branch — runtime callers pass a
// timezone-aware Intl formatter; the UI passes a `toLocaleString` wrapper.
//
// Returns `{ text, tone }` where `tone` is `'warn'` when the latest accepted
// sample is older than the 24 h freshness window and `null` otherwise. The
// producer resolves the staleness signal once here so the UI consumer never
// re-derives it from the rendered text (per
// `feedback_layering_resolution_in_producer.md`).
//
// Exported so the settings UI can re-derive `{ text, tone }` on its 60s
// freshness tick (`PlanInputsCard` in `views/DeadlinePlan.tsx`) without
// re-running the whole row builder. Producer-side
// `resolveKwhPerUnitProvenanceRows` calls this once to seed `value`/`tone`;
// the view recomputes via the same helper so the phrasing never drifts
// between the initial render and the tick — and so the tone can flip from
// `null` to `'warn'` when a sample crosses the 24 h staleness threshold
// without a fresh producer pass.
export const formatLastSampleValue = (params: {
  lastMs: number;
  nowMs: number;
  formatAcceptedAt: (ms: number) => string;
}): { text: string; tone: KwhPerUnitProvenanceRowTone | null } => {
  const { lastMs, nowMs, formatAcceptedAt } = params;
  const ageMs = Math.max(0, nowMs - lastMs);
  if (ageMs >= SAMPLE_STALE_THRESHOLD_MS) {
    return { text: `Stale — ${formatAcceptedAt(lastMs)}`, tone: 'warn' };
  }
  if (ageMs < ONE_MINUTE_MS) return { text: 'Updated just now', tone: null };
  if (ageMs < ONE_HOUR_MS) {
    const minutes = Math.max(1, Math.round(ageMs / ONE_MINUTE_MS));
    return { text: `Updated ${minutes} min ago`, tone: null };
  }
  const hours = Math.max(1, Math.round(ageMs / ONE_HOUR_MS));
  return { text: `Updated ${hours} ${pluralHour(hours)} ago`, tone: null };
};

// ─── Energy estimate range (variance buffer) ─────────────────────────────────

// Formats the energy estimate as a range when the planned (buffered) figure
// sits above the expected (mean) figure — PELS books for the high end while the
// rate is still being refined. Collapses to a single "8.0 kWh" when the two
// round equal (steady device, cold-start, or no buffer), so the UI never shows
// a degenerate "8.0–8.0" range. The range itself signals approximation, so no
// `≈` glyph here — unlike a lone planned figure, which needs the hedge.
//
// `energyExpectedKWh` is optional/absent on plans persisted before the variance
// buffer shipped; absent is treated as equal to planned (range collapses).
export const formatEnergyEstimateKWh = (params: {
  energyPlannedKWh: number;
  energyExpectedKWh?: number | null;
}): string => {
  const planned = params.energyPlannedKWh;
  const expected = typeof params.energyExpectedKWh === 'number' ? params.energyExpectedKWh : planned;
  const lowText = expected.toFixed(1);
  const highText = planned.toFixed(1);
  if (lowText === highText || planned <= expected) return `${highText} kWh`;
  return `${lowText}–${highText} kWh`; // en-dash
};

// ─── Cost + delivered-so-far hero lines (v2.7.2 PR 2) ────────────────────────

// `≈` (U+2248) signals "approximate" — the in-flight cost is a planned figure
// that the actual delivered run will overshoot or undershoot. Spelling the
// glyph out here (rather than burying it in caller string concat) so the
// `pels-copy-and-terminology` reviewer can grep for it and so we never drift
// to ASCII `~` or the word "approx" again. Matches `notes/ui-terminology.md`.
// Exported so the history-detail cost helpers in `deferredPlanHistory.ts`
// render the same glyph across live and past surfaces — the user reads the
// same approximation marker whether the run is in-flight or finalized.
export const APPROX_GLYPH = '≈';

// Resolver for the `Cost ≈ X.XX kr` meta line on the smart-task live hero.
// Both branches live in shared-domain so runtime log breadcrumbs and the UI
// surface the same phrasing (per `feedback_ui_text_shared_with_logs.md`).
//
// Branches resolve in this order:
//   1. `deliveredCost !== null` AND > 0 → composite "so far · planned" form.
//   2. Otherwise                         → planned-only form.
//
// Returns `null` when the planned cost cannot be summarised honestly — either
// the unit is missing (Flow / Homey scheme with no `priceUnit` provided) or the
// planned total is non-finite / zero (no allocated kWh, e.g. cannot-meet on a
// sub-second remaining bucket). The caller suppresses the line cleanly rather
// than rendering "Cost ≈ 0.00 kr planned" which would mislead.
export const formatDeadlineCostMetaLine = (params: {
  plannedTotalCost: number;
  deliveredCost: number | null;
  costUnit: string;
}): string | null => {
  const unit = params.costUnit.trim();
  if (unit.length === 0) return null;
  if (!Number.isFinite(params.plannedTotalCost)) return null;
  // Allow zero and negative planned cost: Norwegian Nordpool spot prices
  // can go negative during oversupply windows, so a zero/negative total is
  // a real outcome the user should see ("Cost ≈ -0.30 kr" = you got paid to
  // charge). Only non-finite values still suppress the line.
  const plannedLabel = `${params.plannedTotalCost.toFixed(2)} ${unit}`;
  if (params.deliveredCost !== null && Number.isFinite(params.deliveredCost)) {
    const deliveredLabel = `${params.deliveredCost.toFixed(2)} ${unit}`;
    return `Cost ${APPROX_GLYPH} ${deliveredLabel} so far · ${plannedLabel} planned`;
  }
  return `Cost ${APPROX_GLYPH} ${plannedLabel}`;
};

// Resolver for the "Delivered so far" hero subline. Branches by plan status:
//   - `cannot_meet`            → `Delivered X of Y kWh · still {curr} of {target}`
//   - on-track / at-risk / queued → `Delivered X of Y kWh · {start →} {curr} of {target}`
//
// The "start → current" arrow is rendered only when `startProgress` is known
// (caller resolves the back-calc from current − delivered × kWh-per-unit). When
// it's not, the line collapses to `now {curr} of {target}` so the user still
// sees current vs target without us inventing a starting value.
//
// `targetUnit` is `°C` / `%` and matches `DeadlineLabels.targetUnit`. The
// caller formats `deadlineTime` (e.g. `16:00`) — shared-domain stays free of
// locale and Date helpers. `deadlineTime` is retained in the input shape so
// callers don't have to branch on status to decide whether to pass it, but it
// is unused after the cannot-meet branch dropped its `· won't reach by` tail
// (TODO ~1586): the chip ("Cannot finish") + meta line ("Not enough time for
// this target. …") already announce the verdict; restating it as a third tail
// on the magnitude line read as alarm spam in the 2026-05-16 live walk. The
// "still {curr} of {target}" stem (vs the on-track "now …") still tonally
// pairs with the alert chip without re-asserting the failure.
//
// Returns `null` when planned energy is non-finite / zero (no allocation yet,
// or revision predates the field) or when both delivered and progress data
// are absent — the line has nothing concrete to say so the view suppresses it
// rather than emit "Delivered 0 of 0 kWh".
export type DeadlineDeliveredSoFarStatus =
  | 'cannot_meet'
  | 'on_track_or_queued';

export const formatDeadlineDeliveredSoFarLine = (params: {
  status: DeadlineDeliveredSoFarStatus;
  deliveredKWh: number;
  plannedTotalKWh: number;
  currentProgress: number;
  startProgress: number | null;
  targetValue: number;
  targetUnit: '°C' | '%';
  // Kept for backward compatibility with callers (the live cannot-meet hero
  // and the unit tests). Unused after the `won't reach by` tail was dropped;
  // see header comment.
  deadlineTime: string;
}): string | null => {
  if (!Number.isFinite(params.plannedTotalKWh) || params.plannedTotalKWh <= 0) return null;
  if (!Number.isFinite(params.currentProgress) || !Number.isFinite(params.targetValue)) return null;
  const deliveredKWhSafe = Number.isFinite(params.deliveredKWh) && params.deliveredKWh > 0
    ? params.deliveredKWh : 0;
  const energyPart = `Delivered ${deliveredKWhSafe.toFixed(1)} of ${params.plannedTotalKWh.toFixed(1)} kWh`;
  const currentLabel = formatProgressValueForUnit(params.currentProgress, params.targetUnit);
  const targetLabel = formatProgressValueForUnit(params.targetValue, params.targetUnit);
  if (params.status === 'cannot_meet') {
    return `${energyPart} · still ${currentLabel} of ${targetLabel} target`;
  }
  // Compare formatted labels rather than raw numeric deltas: for percent
  // values (`Math.round`) two readings 0.4 percentage points apart still
  // render identically, and a "45% → 45%" arrow is meaningless to the user.
  // Falling through to "now X" keeps the line honest when the rounded
  // start-vs-current motion is invisible at display precision.
  const startLabel = params.startProgress !== null && Number.isFinite(params.startProgress)
    ? formatProgressValueForUnit(params.startProgress, params.targetUnit)
    : null;
  if (startLabel !== null && startLabel !== currentLabel) {
    return `${energyPart} · ${startLabel} → ${currentLabel} of ${targetLabel} target`;
  }
  return `${energyPart} · now ${currentLabel} of ${targetLabel} target`;
};

const formatProgressValueForUnit = (
  value: number,
  unit: '°C' | '%',
): string => (
  unit === '°C' ? `${value.toFixed(1)} °C` : `${Math.round(value)}%`
);

// ─── History-detail missed-hero recourse (v2.7.2 PR 3) ───────────────────────

// Recourse action for a missed history entry. Mirrors the live hero's
// `DeadlineCannotMeetRecourse` shape so the click dispatcher in
// `deadlinePlanMount.ts` handles both surfaces with the same handler.
//
// Labels are action-oriented for the postmortem context: the user is reading
// what happened *after* the deadline missed, so the recourse is advice for
// the next run rather than a "fix the current plan" affordance. The
// `targetTab` slug still routes the click — Budget for the budget-exhausted
// branch; the shortfall branch lands on Overview AND deep-links the
// device-settings overlay for the device that missed (deadlines are
// configured per-device via Flow cards, so the device-settings surface is
// the closest landing place — Overview alone is a dead end, see owner walk
// 2026-05-17).
//
// Label note: the prior "Move deadline later" copy promised an action the
// destination doesn't offer (the deadline-plan panel doesn't edit
// deadlines, nor does device-settings). "Review device" is honest about
// where the click lands — the device-settings overlay shows shed behaviour,
// target power, boost, modes and deltas; the user audits the device that
// missed and can adjust those settings (or the Flow wiring) from there.
const MISSED_HISTORY_RECOURSE_LOWER_BUDGET: DeadlineCannotMeetRecourse = {
  label: 'Lower daily budget',
  targetTab: 'budget',
};

// Shortfall sibling of `MISSED_HISTORY_RECOURSE_LOWER_BUDGET`. Hoisted so the
// two branches of `resolveMissedHistoryRecourse` share the same producer
// pattern (constant + spread of the per-entry `deviceId`) instead of one
// branch returning a constant and the other returning an inline literal.
const MISSED_HISTORY_RECOURSE_SHORTFALL: Omit<DeadlineCannotMeetRecourse, 'deviceId'> = {
  label: 'Review device',
  targetTab: 'overview',
};

// Resolves the recourse action for a missed history entry. Producer-side
// branch on `dailyBudgetExhausted` so the consumer never branches on the
// snapshot's optional `dailyBudgetExhaustedBucketCount`. Per
// `feedback_hard_cap_is_physical.md` the budget branch lands on
// `targetTab: 'budget'` — never the capacity hard cap.
//
// Two-branch resolver:
//   - budget exhausted → `Lower daily budget` (targetTab: 'budget')
//   - everything else  → `Review device` (targetTab: 'overview' +
//                        deviceId deep link)
//
// Returns `null` when the entry is not a missed run — the receipt-shape
// succeeded hero and the muted abandoned hero carry no recourse.
export const resolveMissedHistoryRecourse = (params: {
  outcome: 'met' | 'missed' | 'abandoned' | 'replaced' | 'unknown';
  dailyBudgetExhausted: boolean;
  deviceId: string;
}): DeadlineCannotMeetRecourse | null => {
  if (params.outcome !== 'missed') return null;
  if (params.dailyBudgetExhausted) return MISSED_HISTORY_RECOURSE_LOWER_BUDGET;
  return { ...MISSED_HISTORY_RECOURSE_SHORTFALL, deviceId: params.deviceId };
};

// Resolve the smart-task chip's underlying confidence value from the persisted
// provenance + the live profile. Producer-side resolution lives here, not in
// the UI consumer, per `feedback_layering_resolution_in_producer.md`.
//
// Preference order:
//   1. `provenance.displayConfidence` — band-aware aggregate the recorder
//      writes today. Drives `Estimating` / `Refining` honestly because it
//      reflects the bands actually integrated, not raw per-sample CV.
//   2. `provenance.confidence` — band-aware once bands have fit (it mirrors
//      the live `kwhPerUnit.confidence`, which Step 2 of the Cause-#1 fix
//      re-resolves against the pooled within-band residual), falls back to
//      raw-CV when no bands exist. Kept on the provenance for log/diagnostic
//      parity; covers plans persisted after provenance shipped but before
//      `displayConfidence` shipped.
//   3. Live profile's `kwhPerUnit.confidence` — final fallback for plans
//      persisted before provenance existed at all. Drainable population.
//   4. `null` — no signal; the chip suppresses.
//
// Returning a single flat value lets the UI consumer treat the result as
// opaque — it never sees `provenance` / `kind` / `source`.
export const resolveChipConfidence = (params: {
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined;
  profileConfidence: 'low' | 'medium' | 'high' | null | undefined;
}): 'low' | 'medium' | 'high' | null => (
  params.provenance?.displayConfidence
    ?? params.provenance?.confidence
    ?? params.profileConfidence
    ?? null
);

// Resolve display rows for the kWhPerUnit provenance snapshot. The caller
// supplies `formatAcceptedAt` because shared-domain stays free of locale and
// timezone helpers — the UI passes a browser-side formatter, while runtime
// callers can pass a timezone-aware `Intl.DateTimeFormat` formatter.
//
// Producer-side resolution: the UI just renders these rows; it never branches
// on `source`, raw kWh values, or null fields.
export const resolveKwhPerUnitProvenanceRows = (params: {
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined;
  nowMs: number;
  formatAcceptedAt: (ms: number) => string;
}): KwhPerUnitProvenanceRow[] => {
  const { provenance, nowMs, formatAcceptedAt } = params;
  if (!provenance) return [];
  if (provenance.source === 'bootstrap') {
    // Bootstrap rows describe the cold-start state. The plan-inputs row note
    // already says "Estimated — refining as PELS observes charging", so a
    // single Source row is enough here — adding "0 readings" would be noisy.
    return [{ label: 'Source', value: 'Starting estimate', tone: null }];
  }
  // `Learned from power readings` source no longer carries a redundant `Learned rate` row
  // (the card's headline already shows the rate value). Surface only the
  // facts the headline doesn't repeat: sample count + confidence, and the
  // recency of the latest reading used (recency is a separate signal from the
  // confidence chip — the chip is "how many / how tight," "Latest reading
  // used" is "how long since we saw fresh evidence").
  const rows: KwhPerUnitProvenanceRow[] = [
    { label: 'Source', value: 'Learned from power readings', tone: null },
  ];
  if (provenance.acceptedSamples > 0) {
    rows.push({
      label: 'Readings used',
      value: formatSamplesLine(provenance.acceptedSamples, provenance.confidence),
      tone: null,
    });
  }
  if (provenance.lastAcceptedAtMs !== null && Number.isFinite(provenance.lastAcceptedAtMs)) {
    const lastSample = formatLastSampleValue({
      lastMs: provenance.lastAcceptedAtMs,
      nowMs,
      formatAcceptedAt,
    });
    rows.push({
      label: 'Latest reading used',
      value: lastSample.text,
      tone: lastSample.tone,
      // Carrying the raw timestamp lets the React view re-derive `value` and
      // `tone` every 60s without freezing on the initial `nowMs` for the whole
      // session. Non-React consumers ignore this field and read `value`/`tone`.
      freshnessOfMs: provenance.lastAcceptedAtMs,
    });
  }
  return rows;
};
