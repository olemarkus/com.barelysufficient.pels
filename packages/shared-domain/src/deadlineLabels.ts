/* eslint-disable max-lines -- single home for kind-aware smart-task copy
   (chips, status labels, pending-hero variants, history copy, cost & delivered-
   so-far formatters, EV provenance rows). Splitting per surface would scatter
   copy across files; `feedback_ui_text_shared_with_logs` keeps runtime
   logging and the UI reading the same strings, which requires colocation. */
import type {
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveRescueMode,
  DeferredObjectiveSettingsKind,
} from '../../contracts/src/deferredObjectiveSettings.js';
import type {
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveActivePlanPendingReason,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveKwhPerUnitProvenanceV1,
} from '../../contracts/src/deferredObjectiveActivePlans.js';
import type { ObjectiveProfileConfidence } from '../../contracts/src/objectiveProfileTypes.js';

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

// CSS modifier class suffix for each list status id (appended to `plan-chip--`).
export const SMART_TASK_LIST_STATUS_CHIP_VARIANT: Record<SmartTaskListStatusId, string> = {
  building_plan: 'muted',
  queued: 'muted',
  paused_unplugged: 'warn',
  on_track: 'ok',
  at_risk: 'warn',
  cannot_meet: 'alert',
  satisfied: 'ok',
};

// Tone slug for the smart-task list card's "Ready by" accent row. The default
// `accent` (green) tone reads as "healthy" alongside an on-track chip; on
// at-risk / cannot-meet cards the accent green semantically contradicts the
// status pill. This resolver mirrors the chip tone so the two signals agree.
//
// Returns 'accent' (default green) for healthy / pending / queued / satisfied
// states; 'warn' for at-risk / paused; 'alert' for cannot-meet. The view layer
// renders `.deadline-list-card__when-row--accent` / `--warn` / `--alert` per
// the resolved slug — never branches on status itself.
export type SmartTaskListReadyByTone = 'accent' | 'warn' | 'alert';

export const resolveSmartTaskListReadyByTone = (
  status: SmartTaskListStatusId,
): SmartTaskListReadyByTone => {
  if (status === 'cannot_meet') return 'alert';
  if (status === 'at_risk' || status === 'paused_unplugged') return 'warn';
  return 'accent';
};

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

const SMART_TASK_EXTRA_PERMISSION_LABELS: Record<keyof DeferredObjectiveRescuePermissions, string> = {
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

export const SMART_TASK_PAST_EMPTY_COPY = 'No completed tasks yet — they\'ll appear here after a smart task finishes.';

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

// Resolves a single short label for a revision-reason code. `_kind` is
// accepted so callers (heating vs EV) can pass it without branching at the
// call site — the underlying copy is kind-agnostic today because revision
// causes are recorder-level events (a price publish is a price publish
// regardless of device category). The parameter name is prefixed `_` to
// reserve the slot for future kind-aware copy without churning every caller.
//
// Unknown / falsy / unmapped codes resolve to `Plan refreshed` so the log
// always renders a label rather than swallowing an entry.
export const revisionReason = (
  reasonId: string | null | undefined,
  _kind: DeferredObjectiveSettingsKind,
): string => {
  if (!reasonId) return REVISION_REASON_FALLBACK;
  if (Object.prototype.hasOwnProperty.call(REVISION_REASON_LABEL, reasonId)) {
    return REVISION_REASON_LABEL[reasonId as DeferredObjectiveActivePlanRevisionReason];
  }
  return REVISION_REASON_FALLBACK;
};

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
      missing_capacity: (ctx) => ({
        headline: 'Learning energy use',
        body: 'PELS needs power readings from this heater while it heats so it can learn how '
          + 'many kWh raise the temperature by one degree. The schedule will appear once that is '
          + 'available.',
        headlineReason: 'PELS is still learning this heater’s energy per degree from observed power.',
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
export type KwhPerUnitProvenanceRow = { label: string; value: string };

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
const formatLastSampleValue = (params: {
  lastMs: number;
  nowMs: number;
  formatAcceptedAt: (ms: number) => string;
}): string => {
  const { lastMs, nowMs, formatAcceptedAt } = params;
  const ageMs = Math.max(0, nowMs - lastMs);
  if (ageMs >= SAMPLE_STALE_THRESHOLD_MS) {
    return `Stale — ${formatAcceptedAt(lastMs)}`;
  }
  if (ageMs < ONE_MINUTE_MS) return 'Updated just now';
  if (ageMs < ONE_HOUR_MS) {
    const minutes = Math.max(1, Math.round(ageMs / ONE_MINUTE_MS));
    return `Updated ${minutes} min ago`;
  }
  const hours = Math.max(1, Math.round(ageMs / ONE_HOUR_MS));
  const unit = hours === 1 ? 'hour' : 'hours';
  return `Updated ${hours} ${unit} ago`;
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
//   - `cannot_meet`            → `Delivered X of Y kWh · still {curr} of {target} · won't reach by {deadline}`
//   - on-track / at-risk / queued → `Delivered X of Y kWh · {start →} {curr} of {target}`
//
// The "start → current" arrow is rendered only when `startProgress` is known
// (caller resolves the back-calc from current − delivered × kWh-per-unit). When
// it's not, the line collapses to `now {curr} of {target}` so the user still
// sees current vs target without us inventing a starting value.
//
// `targetUnit` is `°C` / `%` and matches `DeadlineLabels.targetUnit`. The
// caller formats `deadlineTime` (e.g. `16:00`) — shared-domain stays free of
// locale and Date helpers.
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
    return `${energyPart} · still ${currentLabel} of ${targetLabel} target `
      + `· won’t reach by ${params.deadlineTime}`;
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
//   2. `provenance.confidence` — legacy raw-CV stat. Kept on the provenance
//      for log/diagnostic parity; covers plans persisted after provenance
//      shipped but before `displayConfidence` shipped.
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
    return [{ label: 'Source', value: 'Starting estimate' }];
  }
  // `Learned from power readings` source no longer carries a redundant `Learned rate` row
  // (the card's headline already shows the rate value). Surface only the
  // facts the headline doesn't repeat: sample count + confidence, and the
  // recency of the latest reading used (recency is a separate signal from the
  // confidence chip — the chip is "how many / how tight," "Latest reading
  // used" is "how long since we saw fresh evidence").
  const rows: KwhPerUnitProvenanceRow[] = [{ label: 'Source', value: 'Learned from power readings' }];
  if (provenance.acceptedSamples > 0) {
    rows.push({ label: 'Readings used', value: formatSamplesLine(provenance.acceptedSamples, provenance.confidence) });
  }
  if (provenance.lastAcceptedAtMs !== null && Number.isFinite(provenance.lastAcceptedAtMs)) {
    rows.push({
      label: 'Latest reading used',
      value: formatLastSampleValue({
        lastMs: provenance.lastAcceptedAtMs,
        nowMs,
        formatAcceptedAt,
      }),
    });
  }
  return rows;
};
