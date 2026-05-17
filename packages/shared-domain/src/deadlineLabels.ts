/* eslint-disable max-lines -- single home for kind-aware smart-task copy
   (chips, status labels, pending-hero variants, history copy, cost & delivered-
   so-far formatters, EV provenance rows). Splitting per surface would scatter
   copy across files; `feedback_ui_text_shared_with_logs` keeps runtime
   logging and the UI reading the same strings, which requires colocation. */
import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';
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
// Centralised so the two surfaces stay phrased identically — the hero already
// renders `Confidence ${value}` inline; this wraps that single formatting
// rule. Returns `null` when no confidence band is available, so the caller can
// skip rendering without inventing copy.
export const formatConfidenceChipLabel = (
  confidence: ObjectiveProfileConfidence | null | undefined,
): string | null => {
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') return null;
  return `Confidence ${confidence}`;
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
  // device-card line said "Charging plan paused — car unplugged".
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
  cannotMeetChipLabel: string;
  // Honest fallback for `Cannot finish` when no specific reason is available.
  // Never paired with the chip alone — the meta line always names a reason so
  // users are never left with a warning chip and no explanation.
  cannotMeetUnknownReason: string;
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
  cannotMeetRecourse: {
    openBudget: DeadlineCannotMeetRecourse;
    openOverview: DeadlineCannotMeetRecourse;
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
  prices_revised: 'Updated as new prices arrived',
  rate_refined: 'Updated as rates were refined',
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
const CANNOT_MEET_RECOURSE = {
  openBudget: { label: 'Open Budget', targetTab: 'budget' },
  openOverview: { label: 'Adjust device', targetTab: 'overview' },
};

// Recourse target for the pending-hero device-side branches
// (`device_data_missing`, `invalid_session`, `missing_capacity`). The Overview
// tab hosts the device card where the user verifies status / capacity. We
// pick a single, kind-aware label so the button reads as "where the device
// lives", not "Adjust device" (which the cannot-meet branch already uses for
// the post-plan-failure case and would mislead in a pre-plan pending state).
const OVERVIEW_DEVICE_RECOURSE = { label: 'Open device in Overview', targetTab: 'overview' };

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
  recourse: OVERVIEW_DEVICE_RECOURSE,
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
    cannotMeetChipLabel: 'Cannot finish',
    cannotMeetUnknownReason: 'PELS can\'t determine why this task is at risk. '
      + 'Check this heater\'s power readings and setpoint range.',
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
      missing_capacity: () => ({
        headline: 'Learning energy use',
        body: 'PELS needs power readings from this heater while it heats so it can learn how '
          + 'many kWh raise the temperature by one degree. The plan will appear once that is '
          + 'available.',
        headlineReason: 'PELS is still learning this heater’s energy per degree from observed power.',
        recourse: OVERVIEW_DEVICE_RECOURSE,
      }),
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first temperature reading',
        body: 'The plan will appear once the device reports its current temperature.',
      },
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The current temperature already meets the smart task target. PELS will plan again '
          + 'if the temperature drops below target.',
      },
    },
    // Drops the raw progress-unit delta ("Short by about 41.9 °C") that users
    // misread as a wild temperature anomaly. The underlying shortfall is energy
    // / time against the plan, not a raw temperature gap; the copy now states
    // that directly. The hero meta line follows up with the "Needs N kWh · Y
    // hours left · …" line via `formatMetaLine`, which is the right surface for
    // a magnitude. Recourse copy ("Try lowering the target or moving the
    // deadline later") names the two levers that aren't the daily budget; the
    // budget remedy is handled by the dedicated `cannotMeetDailyBudgetExhausted`
    // branch above.
    cannotMeetShortfall: () => (
      'PELS may not reach the target temperature before the deadline. '
        + 'Try lowering the target or moving the deadline later.'
    ),
    cannotMeetDailyBudgetExhausted: 'The daily energy budget is already used up for the rest of the day, so '
      + 'PELS can\'t reserve more for heating before the deadline. Lower the daily budget so future '
      + 'days reserve available power earlier, or move the deadline to a later day.',
    cannotMeetRecourse: CANNOT_MEET_RECOURSE,
    resolveQueuedHeadlineReason,
    completedHero: {
      headline: 'Smart task finished',
      body: 'See Smart tasks for the outcome.',
    },
    targetUnit: '°C',
    planInputsCardTitle: 'Smart task inputs',
    planInputsRateRowLabel: 'Energy per unit',
    planInputsMaxPowerRowLabel: 'Max power per hour',
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
    cannotMeetChipLabel: 'Cannot finish',
    cannotMeetUnknownReason: 'PELS can\'t determine why this charging task is at risk. '
      + 'Check the EV charger\'s power readings and charge-rate configuration.',
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
        headline: 'Charging plan paused — EV unplugged',
        body: 'PELS will resume the plan once the EV is plugged in and reports a valid charging '
          + 'session.',
        headlineReason: 'Charger reports the car isn’t plugged in.',
        recourse: null,
      }),
      missing_capacity: EV_DEVICE_DATA_MISSING,
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first state-of-charge reading',
        body: 'The plan will appear once the EV reports its current state of charge.',
      },
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The EV is already at or above the smart task target. PELS will plan again if the '
          + 'state of charge drops below target.',
      },
    },
    // EV mirrors the thermal copy: drop the raw % shortfall figure (users can
    // read it as "the car lost 30 % of charge") in favour of plain-language
    // recourse. The meta line continues to carry the energy/duration magnitude.
    cannotMeetShortfall: () => (
      'PELS may not have enough time or charging power to reach the target before the deadline. '
        + 'Try lowering the target or moving the deadline later.'
    ),
    cannotMeetDailyBudgetExhausted: 'The daily energy budget is already used up for the rest of the day, so '
      + 'PELS can\'t reserve more for charging before the deadline. Lower the daily budget so future '
      + 'days reserve available power earlier, or move the deadline to a later day.',
    cannotMeetRecourse: CANNOT_MEET_RECOURSE,
    resolveQueuedHeadlineReason,
    completedHero: {
      headline: 'Smart task finished',
      body: 'See Smart tasks for the outcome.',
    },
    targetUnit: '%',
    planInputsCardTitle: 'Smart task inputs',
    planInputsRateRowLabel: 'Energy per unit',
    planInputsMaxPowerRowLabel: 'Max power per hour',
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
    return { kind: 'plug_out_paused', text: 'Charging plan paused — car unplugged' };
  }

  return { kind: 'none' };
};

// ─── Smart task status notification text ─────────────────────────────────────

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

const SMART_TASK_STATUS_DISPLAY_LABEL: Record<SmartTaskStatusNotificationId, string> = {
  waiting: 'Waiting',
  on_track: 'On track',
  at_risk: 'At risk',
  unachievable: 'Cannot finish',
  satisfied: 'Satisfied',
};

// Compose the one-line notification body for `deadline_status_changed`.
// Format examples:
//   "Boiler smart task is At risk — target 55 °C by 07:00"
//   "Tesla smart task is On track — target 80 % by 07:00"
//   "Boiler smart task is Waiting"  (target/deadline omitted when unknown)
//
// The text is the value of the `notification_text` flow token; downstream
// users compose final notifications via Logic/text. Display formatting (the
// `Status` label) is composed here once instead of asking every flow author
// to map ids to human strings.
export const composeSmartTaskStatusNotificationText = (params: {
  deviceName: string;
  status: SmartTaskStatusNotificationId;
  targetText: string;
  deadlineLocalTime: string;
}): string => {
  const head = `${params.deviceName} smart task is ${SMART_TASK_STATUS_DISPLAY_LABEL[params.status]}`;
  const target = params.targetText.trim();
  const deadline = params.deadlineLocalTime.trim();
  const detail = [target && `target ${target}`, deadline && `by ${deadline}`].filter(Boolean).join(' ');
  return detail === '' ? head : `${head} — ${detail}`;
};

// ─── EV learning provenance rows ──────────────────────────────────────────────

// A row in the plan-inputs card describing one provenance fact (source, value,
// sample count, confidence, last accepted at). Pre-resolved at this layer so
// the view never branches on `source` / null values.
export type KwhPerUnitProvenanceRow = { label: string; value: string };

// Confidence text is rendered next to the learned mean. Lowercase to fit the
// neighbouring sentence ("12 samples · medium confidence"); the chip surface
// uses sentence-case copy elsewhere.
const CONFIDENCE_TEXT: Record<'low' | 'medium' | 'high', string> = {
  low: 'low confidence',
  medium: 'medium confidence',
  high: 'high confidence',
};

const formatLearnedValue = (kWhPerUnit: number, unitSuffix: DeadlineLabels['perUnitRateUnit']): string => (
  `${kWhPerUnit.toFixed(2)} ${unitSuffix}`
);

const formatSamplesLine = (acceptedSamples: number, confidence: 'low' | 'medium' | 'high' | null): string => {
  const sampleWord = acceptedSamples === 1 ? 'sample' : 'samples';
  const base = `${acceptedSamples} accepted ${sampleWord}`;
  return confidence === null ? base : `${base} · ${CONFIDENCE_TEXT[confidence]}`;
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
// branch, Overview (where the device lives) for shortfall.
const MISSED_HISTORY_RECOURSE = {
  lowerDailyBudget: { label: 'Lower daily budget', targetTab: 'budget' },
  moveDeadlineLater: { label: 'Move deadline later', targetTab: 'overview' },
} as const;

// Resolves the recourse action for a missed history entry. Producer-side
// branch on `dailyBudgetExhausted` so the consumer never branches on the
// snapshot's optional `dailyBudgetExhaustedBucketCount`. Per
// `feedback_hard_cap_is_physical.md` the budget branch lands on
// `targetTab: 'budget'` — never the capacity hard cap.
//
// Two-branch resolver:
//   - budget exhausted → `Lower daily budget` (targetTab: 'budget')
//   - everything else  → `Move deadline later` (targetTab: 'overview')
//
// Returns `null` when the entry is not a missed run — the receipt-shape
// succeeded hero and the muted abandoned hero carry no recourse.
export const resolveMissedHistoryRecourse = (params: {
  outcome: 'met' | 'missed' | 'abandoned' | 'replaced' | 'unknown';
  dailyBudgetExhausted: boolean;
}): DeadlineCannotMeetRecourse | null => {
  if (params.outcome !== 'missed') return null;
  if (params.dailyBudgetExhausted) return MISSED_HISTORY_RECOURSE.lowerDailyBudget;
  return MISSED_HISTORY_RECOURSE.moveDeadlineLater;
};

// Resolve display rows for the kWhPerUnit provenance snapshot. The caller
// supplies `formatAcceptedAt` because shared-domain stays free of locale and
// timezone helpers — the UI passes a browser-side formatter, while runtime
// callers can pass a timezone-aware `Intl.DateTimeFormat` formatter.
//
// Producer-side resolution: the UI just renders these rows; it never branches
// on `source`, raw kWh values, or null fields.
export const resolveKwhPerUnitProvenanceRows = (params: {
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined;
  unitSuffix: DeadlineLabels['perUnitRateUnit'];
  formatAcceptedAt: (ms: number) => string;
}): KwhPerUnitProvenanceRow[] => {
  const { provenance, unitSuffix, formatAcceptedAt } = params;
  if (!provenance) return [];
  if (provenance.source === 'bootstrap') {
    // Bootstrap rows describe the cold-start state. The plan-inputs row note
    // already says "Estimated — refining as PELS observes charging", so a
    // single Source row is enough here — adding "0 samples" would be noisy.
    return [{ label: 'Source', value: 'Bootstrap estimate' }];
  }
  const rows: KwhPerUnitProvenanceRow[] = [{ label: 'Source', value: 'Learned profile' }];
  if (provenance.kWhPerUnit !== null && Number.isFinite(provenance.kWhPerUnit) && provenance.kWhPerUnit > 0) {
    rows.push({ label: 'Learned rate', value: formatLearnedValue(provenance.kWhPerUnit, unitSuffix) });
  }
  if (provenance.acceptedSamples > 0) {
    rows.push({ label: 'Samples', value: formatSamplesLine(provenance.acceptedSamples, provenance.confidence) });
  }
  if (provenance.lastAcceptedAtMs !== null && Number.isFinite(provenance.lastAcceptedAtMs)) {
    rows.push({ label: 'Last sample', value: formatAcceptedAt(provenance.lastAcceptedAtMs) });
  }
  return rows;
};
