// The status a smart task reports: list status ids, chip labels and tones, and
// the resolvers every surface reads its status through.
import type {
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveLiveCompletion,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanStatusV1,
  DeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans';
import { resolveFirstPlannedHourMs } from '../deferredPlanBookedHours';
import { resolveExclusionPendingReason } from './pendingReasons';
import { resolveSmartTaskCarChargeLimit, type SmartTaskCarChargeLimit } from './shortfallCauses';

// Hero/list "live" status variants. Sits next to the kind chip and identifies
// the current operational state in plain language. `building_plan` /
// `queued` / `paused_unplugged` are the three disambiguated `Waiting` cases;
// `active` covers "Charging now"/"Heating now"; `ok` is the on-track no-op
// state when there is no active hour yet but a plan exists.
export type DeadlineLiveState =
  | 'active'
  | 'building_plan'
  | 'queued'
  | 'unavailable'
  | 'paused_unplugged'
  | 'paused_unmanaged'
  | 'ok';

// Display label for a smart task list card's status chip.
export type SmartTaskListStatusId =
  | 'building_plan'   // pending, no allocation yet
  | 'queued'          // plan ready, first hour in the future
  | 'unavailable'     // device moved to a separately-metered home
  | 'paused_unplugged' // EV: car unplugged / session ended
  | 'paused_unmanaged' // "Managed by PELS" turned off for the device
  | 'on_track'
  | 'at_risk'
  | 'cannot_meet'
  | 'satisfied';

// Stable chip label strings for list card status — kind-agnostic.
// Sourced here (shared-domain) so runtime logging and UI use the same strings.
// Note: the internal status id `queued` is kept stable for log schemas /
// contracts; only the user-visible chip label changed (`Queued` → `Scheduled`,
// then `Scheduled` → `On track` in the 2026-07 coherence sweep:
// an allocated, healthy plan whose first hour is still ahead answers "am I on
// track?" the same way the detail hero does — one state, one word across the
// two surfaces; see notes/ui-terminology.md § Smart task list status chips).
export const SMART_TASK_LIST_STATUS_LABELS: Record<SmartTaskListStatusId, string> = {
  building_plan: 'Building plan…',
  queued: 'On track',
  unavailable: 'Unavailable',
  paused_unplugged: 'Paused — unplugged',
  paused_unmanaged: 'Paused — not managed',
  on_track: 'On track',
  at_risk: 'At risk',
  cannot_meet: 'Cannot finish',
  satisfied: 'Satisfied',
};

// Shorter status labels used by the Smart tasks dashboard widget. The widget
// row at 320–480 px has roughly half the horizontal space the settings UI
// list card uses, so the `Paused — unplugged` em-dash variant truncates or
// pushes the row out of layout. The widget reuses the settings UI label for
// every other state — `paused_unplugged` is the only em-dash label, so it is
// the only override. Keeping the override here (and not in the widget) preserves
// the "UI text shared with logs" rule: both the list label and the widget label
// resolve from shared-domain helpers, not from hardcoded widget strings.
export const SMART_TASK_WIDGET_STATUS_LABELS: Record<SmartTaskListStatusId, string> = {
  ...SMART_TASK_LIST_STATUS_LABELS,
  paused_unplugged: 'Unplugged',
  paused_unmanaged: 'Not managed',
};

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

// Same tone, same reasoning, for "Paused — not managed": the owner has an
// action to take (manage the device again) and the task is unharmed until they
// do, so this is `warn`, never `alert`.
export const resolvePausedUnmanagedChipTone = (): SmartTaskChipTone => 'warn';

// CSS modifier class suffix for each list status id (appended to `plan-chip--`).
// `building_plan` / `paused_unplugged` delegate to the shared pending-tone
// resolvers above so the list card and the plan-detail pending hero can never
// disagree on tone — the pending hero's `pendingChipTone` reads the same
// helpers.
export const SMART_TASK_LIST_STATUS_CHIP_VARIANT: Record<SmartTaskListStatusId, SmartTaskChipTone> = {
  building_plan: resolveBuildingPlanChipTone(),
  // Same label AND tone as `on_track` — a queued plan that is allocated and
  // healthy is the same user-facing state; only the internal id differs.
  queued: 'ok',
  unavailable: 'warn',
  paused_unplugged: resolvePausedUnpluggedChipTone(),
  paused_unmanaged: resolvePausedUnmanagedChipTone(),
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
  unavailable: 'warn',
  paused_unplugged: 'warn',
  paused_unmanaged: 'warn',
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
  unavailable: SMART_TASK_LIST_STATUS_LABELS.unavailable,
  // The inline word is joined to the timestamp with an em-dash separator
  // ("Ready by … — <word>"). For paused we use the compressed widget label
  // ('Unplugged') rather than the full chip label ('Paused — unplugged'): the
  // latter carries its own em-dash, which would render a confusing double-dash
  // ("… — Paused — unplugged") on the Ready-by line. The chip still shows the
  // full label; this is the same sanctioned shared-domain string, not a new
  // variant.
  paused_unplugged: SMART_TASK_WIDGET_STATUS_LABELS.paused_unplugged,
  // Compressed widget label ('Not managed') for the same double-em-dash reason
  // as paused_unplugged — the full chip label carries its own em-dash.
  paused_unmanaged: SMART_TASK_WIDGET_STATUS_LABELS.paused_unmanaged,
  on_track: null,
  at_risk: SMART_TASK_LIST_STATUS_LABELS.at_risk,
  cannot_meet: SMART_TASK_LIST_STATUS_LABELS.cannot_meet,
  satisfied: null,
};

export const resolveSmartTaskListReadyByStatusWord = (
  status: SmartTaskListStatusId,
): string | null => SMART_TASK_LIST_READY_BY_STATUS_WORD[status];

// Resolve the list card status id from plan data.

/**
 * Live reason codes that downgrade a healthy reported status: the confirmed
 * device-side causes from the runtime delivery overlay (`deliveryEvidence.ts`). Planner decisions
 * (capacity, budget or priority limiting, settles) never reach this set: the
 * committed verdict already prices them in. Each code has its copy in
 * `resolveSmartTaskLiveCause`.
 */
const LIVE_RISK_REASON_CODES: ReadonlySet<DeferredObjectiveActivePlanDiagnosticReason> = new Set([
  'objective_not_accepting_energy',
  'objective_device_limit',
  'objective_device_schedule',
]);

/** The plan's live facts that decide its reported status. */
type SmartTaskLiveStatusFacts = Pick<
  DeferredObjectiveActivePlanV1, 'diagnosticReasonCode' | 'liveCompletion' | 'carChargeLimit' | 'targetValue'
>;

// A known car limit below the target, reached or not (owner decision): the
// requested target stays the target and the car will stop short of it, so the
// task is not on track. "On track" promises the target. A verdict that already
// says it cannot finish, or a target already met, keeps its word.
const resolveCarLimitStatus = (
  currentStatus: DeferredObjectiveActivePlanStatusV1,
): 'at_risk' | 'cannot_meet' | 'satisfied' => (
  currentStatus === 'cannot_meet' || currentStatus === 'satisfied' ? currentStatus : 'at_risk'
);

const resolveCurrentStatus = (
  planStatus: DeferredObjectiveActivePlanStatusV1,
  liveCompletion: DeferredObjectiveLiveCompletion,
): DeferredObjectiveActivePlanStatusV1 => (
  liveCompletion.kind === 'unavailable' ? planStatus : resolveCompletionStatus(liveCompletion)
);

const resolveReportedStatus = (
  planStatus: DeferredObjectiveActivePlanStatusV1,
  diagnosticReasonCode: DeferredObjectiveActivePlanDiagnosticReason | undefined,
  liveCompletion: DeferredObjectiveLiveCompletion,
  carChargeLimit: SmartTaskCarChargeLimit | null,
): DeferredObjectiveActivePlanStatusV1 => {
  const currentStatus = resolveCurrentStatus(planStatus, liveCompletion);
  if (carChargeLimit !== null) return resolveCarLimitStatus(currentStatus);
  return diagnosticReasonCode !== undefined && LIVE_RISK_REASON_CODES.has(diagnosticReasonCode)
    && currentStatus === 'on_track'
    ? 'at_risk' : currentStatus;
};

/**
 * The status a surface should REPORT, given the committed verdict plus the live
 * per-cycle causes on the plan. The single home for the live overlay: the list
 * chip, the widget row, and the detail hero all resolve through this, so a
 * user opening a row marked `At risk` can never land on a green on-track hero
 * or a `Cannot finish` one.
 *
 * Completion comes from the current diagnostic, independently of the allocation
 * revision. Accepted near-target holds and trustworthy reopening therefore appear
 * immediately without rewriting the frozen schedule. Legacy/unavailable completion
 * preserves the settled verdict; live causes still downgrade health:
 *  - a reason code in `LIVE_RISK_REASON_CODES` turns `on_track` into `at_risk`;
 *  - a known car charge limit below the target (`resolveReportedCarChargeLimit`,
 *    the same rule that gates its copy), reached or not, reads `at_risk`
 *    (or keeps `cannot_meet` / `satisfied`), except a limit the car had not
 *    reached when it was unplugged: that car is just unplugged.
 *
 * EVERY surface that reports a task's status must resolve through here. The full
 * set, so a new one can be checked against it:
 *  - Smart-tasks list chip + Overview smart-task row → `resolveSmartTaskListStatus`
 *  - Smart-tasks widget row → the same resolver, via `smartTasksWidgetPayload`
 *  - Smart-task detail hero (status, tone, `cannotMeet`) and its trajectory →
 *    `deadlinePlan.ts:buildReadyPayload`
 *  - Flow condition `deadline_status_is` → `deadlineObjectiveCards.ts`
 *  - Flow trigger `deadline_status_changed` → the `effectivePlanStatus` carried
 *    on the revision event, published by the recorder when the overlay flips
 *
 * Deliberately NOT overlaid: the persisted revision itself, the frozen history
 * diagnostic, and the daily-budget cause derivation. Those record what the
 * TRAJECTORY was; a device-side stop is not a budget shortfall, and freezing the
 * overlay is what would make it outlive its cause.
 */
export const resolveEffectivePlanStatus = (
  planStatus: DeferredObjectiveActivePlanStatusV1,
  plan: SmartTaskLiveStatusFacts,
): DeferredObjectiveActivePlanStatusV1 => resolveReportedStatus(
  planStatus, plan.diagnosticReasonCode, plan.liveCompletion, resolveReportedCarChargeLimit(plan),
);

/**
 * The car's charge limit as every surface reports it: the resolved cap
 * (`resolveSmartTaskCarChargeLimit`), or null when it explains nothing now.
 *  - A durable exclusion (separate meter, not managed) outranks every overlay:
 *    the task is paused.
 *  - A car unplugged before it reached its limit is just unplugged. The
 *    recorder keeps the last limit while the charger reports no level, but
 *    telling that owner to raise the limit instead of plugging in is wrong.
 *  - A REACHED limit outranks "unplugged": a charger that ends the session at
 *    the car's limit reads unplugged with the car still in.
 * The list chip, the widget, the detail page and both status Flow cards read
 * the limit through here, so none of them can announce a risk the others hide.
 */
export const resolveReportedCarChargeLimit = (
  plan: Pick<DeferredObjectiveActivePlanV1, 'diagnosticReasonCode' | 'carChargeLimit' | 'targetValue'>,
): SmartTaskCarChargeLimit | null => {
  if (resolveExclusionPendingReason(plan.diagnosticReasonCode) !== null) return null;
  const cap = resolveSmartTaskCarChargeLimit(plan.carChargeLimit, plan.targetValue);
  if (cap === null) return null;
  return cap.reached || plan.diagnosticReasonCode !== 'objective_invalid_session' ? cap : null;
};

const resolveCompletionStatus = (
  completion: Exclude<DeferredObjectiveLiveCompletion, { kind: 'unavailable' }>,
): DeferredObjectiveActivePlanStatusV1 => completion.kind === 'satisfied' ? 'satisfied' : completion.status;

// `nowMs` is used to distinguish the `queued` id (plan ready, first action in
// future — labelled "On track" in the UI, same as `on_track`) from other
// non-pending states.
//
// `diagnosticReasonCode` carries the recorder's "current cause" signal — it
// is set even on plans with a cached `latest` revision (e.g. EV unplugged
// mid-plan). When present, it takes precedence over `latest.planStatus` so the chip
// matches the device-card line.
// The live causes that outrank a cached revision, in precedence order.
const resolveCurrentCauseListStatus = (plan: SmartTaskListStatusPlan): SmartTaskListStatusId | null => {
  const { diagnosticReasonCode } = plan;
  // Durable exclusions first: once the device belongs to a separate meter, or
  // PELS no longer manages it, a committed schedule governs nothing, and the
  // detail page and the Flow condition treat the task as paused
  // (`isDeviceExclusionPaused`). No overlay, a car limit included, outranks it.
  if (diagnosticReasonCode === 'objective_device_in_sub_home') return 'unavailable';
  // Un-managed mid-plan: PELS plans nothing for a device it does not manage, so
  // a cached revision is no longer being executed and the chip must say so
  // instead of "On track".
  if (diagnosticReasonCode === 'objective_device_unmanaged') return 'paused_unmanaged';
  // A car limit from the preceding connection says nothing about this car.
  if (diagnosticReasonCode === 'objective_waiting_for_car') return 'building_plan';
  // A known car limit below the target on a COMMITTED plan. A pending plan has
  // no status to overlay and falls through to the pending ladder, as the detail
  // page's pending hero and the Flow's pending status do. The reported limit
  // (`resolveReportedCarChargeLimit`) already leaves out a limit the car had not
  // reached when it was unplugged, so that car falls through to "unplugged"
  // below, while a REACHED limit outranks it: the charger that ends the session
  // at the car's limit reads unplugged with the car still in, and telling that
  // owner to plug in would be wrong.
  const carChargeLimit = resolveReportedCarChargeLimit(plan);
  if (!plan.pending && plan.latest !== null && carChargeLimit !== null) {
    return resolveCarLimitStatus(resolveCurrentStatus(plan.latest.planStatus, plan.liveCompletion));
  }
  // Unplugged-mid-plan: the recorder refreshes `diagnosticReasonCode` even on
  // non-pending plans so this branch fires regardless of whether `latest` is
  // still cached. Without this, the list chip would say "On track" while the
  // device-card line said "Charging paused — car unplugged".
  if (diagnosticReasonCode === 'objective_invalid_session') return 'paused_unplugged';
  return null;
};

/**
 * The plan as the Smart tasks list reads it when it picks a status chip: the
 * stored or resolved plan, narrowed to what decides the chip. The first planned
 * hour comes from `latest.hours`, the car limit from
 * `resolveReportedCarChargeLimit`, so every surface reads them the same way.
 */
type SmartTaskListStatusPlan = Pick<
  DeferredObjectiveActivePlanV1,
  'pending' | 'pendingReason' | 'diagnosticReasonCode' | 'liveCompletion' | 'carChargeLimit' | 'targetValue'
> & {
  latest: Pick<DeferredObjectiveActivePlanRevisionV1, 'planStatus' | 'hours'> | null;
};

export const resolveSmartTaskListStatus = (
  plan: SmartTaskListStatusPlan,
  nowMs: number,
): SmartTaskListStatusId => {
  const { pendingReason, diagnosticReasonCode, latest } = plan;

  const current = resolveCurrentCauseListStatus(plan);
  if (current !== null) return current;

  if (plan.pending || latest === null) {
    if (pendingReason === 'device_in_sub_home') return 'unavailable';
    if (pendingReason === 'invalid_session') return 'paused_unplugged';
    if (pendingReason === 'device_unmanaged') return 'paused_unmanaged';
    return 'building_plan';
  }
  // Live causes (a confirmed device-side stop)
  // overlay the committed verdict, which is still the trajectory truth and says
  // nothing about a device that is not running. The car-limit case returned above.
  const reported = resolveReportedStatus(latest.planStatus, diagnosticReasonCode, plan.liveCompletion, null);

  // Plan verdicts outrank the future-first-action check: `queued` renders the
  // same green `On track` chip as `on_track`, so letting it win here would
  // paint an at-risk / cannot-finish / already-satisfied plan as healthy just
  // because its first hour hasn't started yet. (Pre-sweep this ordering only
  // mislabelled those as a muted "Scheduled"; with the shared `On track`
  // label it would actively assert health.)
  if (reported === 'satisfied') return 'satisfied';
  if (reported === 'cannot_meet') return 'cannot_meet';
  if (reported === 'at_risk') return 'at_risk';

  // Plan is ready and healthy — a future first action keeps the `queued` id
  // (label and tone identical to `on_track`; the distinction stays internal
  // for log schemas and the queued "starts at HH:MM" why-line).
  const firstActionAtMs = resolveFirstPlannedHourMs(latest);
  if (firstActionAtMs !== null && firstActionAtMs > nowMs) return 'queued';

  // 'invalid' collapses to on_track at the list level; the detail page shows more.
  return 'on_track';
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
