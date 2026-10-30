// Copy for the Smart tasks list, its Past tasks archive, and the page banners.
import type { DeferredObjectiveSettingsKind } from '../../../contracts/src/deferredObjectiveSettings';
import type { SmartTaskListStatusId } from './listStatus';

// Scoping noun for the Smart-tasks history surfaces (the history-detail
// article's aria-label and, via `SMART_TASK_USAGE_RETURN_LABEL`, the Usage
// return link). The visible in-card eyebrow it originally named was removed
// when the deadline-plan panel gained the shared `.pels-appbar` title row —
// the bar already says "Smart task" directly above the hero. Kept in
// shared-domain so logging breadcrumbs and the UI render the same strings
// (per `feedback_ui_text_shared_with_logs.md`).
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

// List-card deadline verb. An unavailable task still has a user-set deadline,
// but its cached plan no longer governs after the device moves to a separate
// meter. `Due` states that deadline without promising PELS will make it ready.
// All other list statuses retain the established `Ready by` wording.
export const resolveSmartTaskListDeadlineVerb = (
  status: SmartTaskListStatusId,
): string => resolveSmartTaskWidgetEtaVerb(status === 'unavailable');

// Kind-aware target action verb ("Heat to 65 °C" / "Charge to 80 %"). Kept
// beside the other kind-aware smart-task vocabulary so the heat/charge split
// can't drift; the "temperature never says charge" rule
// (`notes/ui-terminology.md`) is enforced by the kind key.
const SMART_TASK_WIDGET_TARGET_ACTION_VERB: Record<DeferredObjectiveSettingsKind, string> = {
  temperature: 'Heat to',
  ev_soc: 'Charge to',
  energy: 'Deliver',
};

export const resolveSmartTaskWidgetTargetActionVerb = (
  kind: DeferredObjectiveSettingsKind,
): string => SMART_TASK_WIDGET_TARGET_ACTION_VERB[kind];

// "Target" noun for the list values line when no current reading is available.
// Re-exported from the canonical list-row label so the widget and the
// settings-UI list card share one source.
export const SMART_TASK_WIDGET_TARGET_NOUN = SMART_TASK_LIST_ROW_LABELS.target;

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
