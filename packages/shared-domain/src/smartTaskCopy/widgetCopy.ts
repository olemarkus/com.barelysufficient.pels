// Copy for the Smart tasks and device dashboard widgets.
import type { DeviceStatusReading } from '../../../contracts/src/deviceStatus';
import type {
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveActivePlanFloorShortfallCause,
  DeferredObjectiveActivePlanPendingReason,
} from '../../../contracts/src/deferredObjectiveActivePlans';
import { SMART_TASK_SUB_HOME_UNAVAILABLE } from '../objectiveWriteStrings';
import type { SmartTaskListStatusId } from './listStatus';
import {
  resolveSmartTaskPendingReason,
  SMART_TASK_DEVICE_UNMANAGED_RECOURSE,
  SMART_TASK_DEVICE_UNMANAGED_WHY,
  WAITING_FOR_CAR_ASSOCIATION,
} from './pendingReasons';
import {
  RECOURSE_BUDGET_PARTIAL,
  RECOURSE_CANNOT_MEET_BUDGET,
  RECOURSE_CANNOT_MEET_DEVICE,
  resolveSmartTaskAtRiskWhy,
  resolveSmartTaskBudgetRole,
  resolveSmartTaskLiveCause,
  WHY_CANNOT_MEET_BUDGET,
  WHY_CANNOT_MEET_BUDGET_PARTIAL,
  WHY_CANNOT_MEET_DEVICE,
  type DeadlineBudgetRole,
  type SmartTaskCarChargeLimit,
} from './shortfallCauses';
import { formatSmartTaskGoalValue } from './valueFormat';

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
  unavailable: SMART_TASK_SUB_HOME_UNAVAILABLE,
  paused_unplugged: 'EV is unplugged — plug in to resume.',
  paused_unmanaged: SMART_TASK_DEVICE_UNMANAGED_WHY,
  on_track: null, // affirmative line resolved from firstPlannedTimeLabel
  at_risk: null, // disambiguated by budget vs time below
  cannot_meet: null, // resolved by floor cause / budget bucket count
  satisfied: null,
};

const SMART_TASK_WIDGET_WHY_BY_PENDING_REASON:
Partial<Record<DeferredObjectiveActivePlanPendingReason, string>> = {
  not_yet_planned: 'Choosing when to run now.',
  awaiting_horizon_plan: 'Waiting for tomorrow’s prices.',
  device_data_missing: 'Waiting for a reading from this device.',
  waiting_for_car: WAITING_FOR_CAR_ASSOCIATION,
  invalid_session: 'EV is unplugged — plug in to start.',
  missing_capacity: 'Learning energy use from this device.',
  price_feature_disabled: 'Price-aware planning is off.',
  device_in_sub_home: SMART_TASK_SUB_HOME_UNAVAILABLE,
  device_unmanaged: SMART_TASK_DEVICE_UNMANAGED_WHY,
};

// Statuses whose recovery is an action the owner can take, reached through the
// STATUS path rather than the pending one. `paused_unmanaged` needs its own
// entry because a live diagnostic resolves it straight to the status id — the
// pending branch (which carries `resolvePendingRecourseHint`) never sees it —
// and a pause with no way out named is the one thing this state must not be.
// `paused_unplugged` has no entry: its why-line already ends in "plug in to
// resume", and a second line would repeat it.
const SMART_TASK_WIDGET_RECOURSE_BY_STATUS: Partial<Record<SmartTaskListStatusId, string>> = {
  paused_unmanaged: SMART_TASK_DEVICE_UNMANAGED_RECOURSE,
};

const RECOURSE_INVALID_SESSION = 'Plug the EV in to resume.';

// The two pending reasons the owner can act on directly. Everything else is
// PELS waiting on itself (prices, readings, a learned profile), where a
// recourse line would invent an action the user does not have.
const resolvePendingRecourseHint = (
  reason: DeferredObjectiveActivePlanPendingReason,
): string | null => {
  if (reason === 'invalid_session') return RECOURSE_INVALID_SESSION;
  if (reason === 'device_unmanaged') return SMART_TASK_DEVICE_UNMANAGED_RECOURSE;
  return null;
};

export type SmartTaskWidgetDetailCopy = {
  whyLabel: string | null;
  recourseHint: string | null;
};

export type SmartTaskWidgetDetailInput = {
  statusId: SmartTaskListStatusId;
  pendingReason?: DeferredObjectiveActivePlanPendingReason;
  // Live per-cycle cause, refreshed on the plan even when `latest` is cached.
  // Takes precedence over the settle-time `floorShortfallCause` below, which is
  // up to an hour stale.
  diagnosticReasonCode?: DeferredObjectiveActivePlanDiagnosticReason;
  floorShortfallCause?: DeferredObjectiveActivePlanFloorShortfallCause;
  // The budget had a hand in the shortfall without explaining it outright, in
  // which case the cause above reads `time_capacity`. Carried so this surface
  // reaches the same verdict as the deadline-plan hero — the three surfaces
  // share one sentence and must not disagree about who is holding the device.
  budgetContributedToShortfall?: true;
  // Pre-formatted local time of the first planned hour (e.g. "16:00") for the
  // `queued` "Cheaper hours start at HH:MM" line. Locale formatting lives in the
  // caller so shared-domain stays free of Intl.
  firstPlannedTimeLabel?: string | null;
  // The plan's `carChargeLimit` and owner's target, when the car's own
  // charge limit caps an EV task below its target.
  carChargeLimit?: SmartTaskCarChargeLimit;
};

// A live cause (a confirmed device-side stop, the car's own limit) is its own
// cause — neither the budget nor the clock — on an at-risk and a cannot-finish
// row alike, matching the detail hero.
const resolveLiveCauseCopy = (input: SmartTaskWidgetDetailInput): SmartTaskWidgetDetailCopy | null => {
  const cause = resolveSmartTaskLiveCause(
    input.diagnosticReasonCode, input.carChargeLimit ?? null, resolveSmartTaskBudgetRole(input),
  );
  return cause === null ? null : { whyLabel: cause.why, recourseHint: cause.recourseHint };
};

const AT_RISK_RECOURSE_BY_BUDGET_ROLE: Record<DeadlineBudgetRole, string | null> = {
  sole: RECOURSE_CANNOT_MEET_BUDGET,
  contributing: RECOURSE_BUDGET_PARTIAL,
  none: null,
};

const resolveAtRiskCopy = (input: SmartTaskWidgetDetailInput): SmartTaskWidgetDetailCopy => {
  const live = resolveLiveCauseCopy(input);
  if (live !== null) return live;
  const budgetRole = resolveSmartTaskBudgetRole(input);
  return {
    whyLabel: resolveSmartTaskAtRiskWhy(budgetRole, input.floorShortfallCause),
    recourseHint: AT_RISK_RECOURSE_BY_BUDGET_ROLE[budgetRole],
  };
};

const resolveCannotMeetCopy = (input: SmartTaskWidgetDetailInput): SmartTaskWidgetDetailCopy => {
  const live = resolveLiveCauseCopy(input);
  if (live !== null) return live;
  const budgetRole = resolveSmartTaskBudgetRole(input);
  if (budgetRole === 'sole') {
    return { whyLabel: WHY_CANNOT_MEET_BUDGET, recourseHint: RECOURSE_CANNOT_MEET_BUDGET };
  }
  if (budgetRole === 'contributing') {
    return { whyLabel: WHY_CANNOT_MEET_BUDGET_PARTIAL, recourseHint: RECOURSE_BUDGET_PARTIAL };
  }
  return { whyLabel: WHY_CANNOT_MEET_DEVICE, recourseHint: RECOURSE_CANNOT_MEET_DEVICE };
};

export const resolveSmartTaskWidgetDetailCopy = (
  input: SmartTaskWidgetDetailInput,
): SmartTaskWidgetDetailCopy => {
  if (input.pendingReason === 'device_in_sub_home') {
    return {
      whyLabel: SMART_TASK_WIDGET_WHY_BY_PENDING_REASON.device_in_sub_home
        ?? SMART_TASK_SUB_HOME_UNAVAILABLE,
      recourseHint: null,
    };
  }
  if (input.diagnosticReasonCode === 'objective_waiting_for_car') {
    return { whyLabel: WAITING_FOR_CAR_ASSOCIATION, recourseHint: null };
  }
  if (input.statusId === 'cannot_meet') return resolveCannotMeetCopy(input);
  if (input.statusId === 'at_risk') return resolveAtRiskCopy(input);
  if (input.statusId === 'building_plan') {
    const reason = resolveSmartTaskPendingReason(input.pendingReason);
    const why = SMART_TASK_WIDGET_WHY_BY_PENDING_REASON[reason]
      ?? SMART_TASK_WIDGET_WHY_BY_PENDING_REASON.not_yet_planned
      ?? null;
    return {
      whyLabel: why,
      recourseHint: resolvePendingRecourseHint(reason),
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
    recourseHint: SMART_TASK_WIDGET_RECOURSE_BY_STATUS[input.statusId] ?? null,
  };
};

// Compressed empty-state pointer for the widget, which has no create action of
// its own. Names both routes a dashboard owner has: a Flow card or the separate
// "Create smart task" widget.
export const SMART_TASK_WIDGET_EMPTY_HINT
  = 'Add a smart task from a Flow card for a managed device, or use the Create smart task widget to see it here.';

// Widget empty-state subtitle. Lives here (not inlined in the widget package)
// so runtime logging and the widget render the same string per
// `feedback_ui_text_shared_with_logs`.
export const SMART_TASK_WIDGET_EMPTY_SUBTITLE = 'No active smart tasks';

// Shown until the widget's first API response lands. The app can be slow to
// respond right after a restart (cold-start device enumeration / busy event
// loop), and without this the widget sat on the blank "No active smart tasks"
// state for the whole wait, reading as "nothing here" rather than "loading".
export const SMART_TASK_WIDGET_LOADING = 'Loading…';

// Error subtitle after repeated failed refreshes. Sourced here (like the
// headroom / plan_budget widgets) so runtime log breadcrumbs reuse the exact
// phrasing the user saw, rather than the widget inlining it.
export const SMART_TASK_WIDGET_LOAD_ERROR_SUBTITLE = 'Could not load. Reopen the dashboard.';
// One-word prefix for the detail-panel plan-meta recap (duration · power · energy)
// so it isn't the least-legible line — names the dense run-on as a forward estimate.
export const SMART_TASK_WIDGET_PLAN_META_LABEL_PREFIX = 'Estimate';

// Heading above the recently-ended-tasks section in the widget list. Sourced
// here (not inlined in the widget) so the section label stays beside the rest
// of the smart-task vocabulary per `feedback_ui_text_shared_with_logs`. "Ended"
// is outcome-neutral — the section mixes succeeded / missed / abandoned runs.
export const SMART_TASK_WIDGET_ENDED_HEADING = 'Recently ended';

// Legend words for the widget's trajectory chart, sourced here so the chart's
// colour-coded key reads identically wherever the series are named.
// `planned` = the booked schedule's progress line; `measured` = the observed
// progress so far (live) / what actually happened (ended); `target` prefixes
// the goal value on the reference line ("Target 55 °C"). Kept terse for the
// 220 px widget. Outcome-neutral and kind-agnostic (the value/unit carries °C
// vs %).
export const SMART_TASK_WIDGET_CHART_PLANNED_LABEL = 'Planned';
export const SMART_TASK_WIDGET_CHART_MEASURED_LABEL = 'Measured';
export const SMART_TASK_WIDGET_CHART_TARGET_LABEL = 'Target';

// Key for the shaded scheduled-run bands behind the widget trajectory. The
// settings-page charts label their band with the kind verb ("Heating" /
// "Charging" via `deviceSeriesName`), but the widget chart payload is
// kind-agnostic, so the band key uses the plain schedule-window word
// `Scheduled` ("these hours are scheduled to run"). Note this is NOT the
// status-chip vocabulary — `Scheduled` was retired as a status chip in the
// 2026-07 coherence sweep (`notes/ui-terminology.md` § Smart task list status
// chips); it stays valid as a schedule/when-window label like this one.
export const SMART_TASK_WIDGET_CHART_RUN_BAND_LABEL = 'Scheduled';

// Overflow line shown beneath the capped widget row list when more active
// tasks exist than the widget renders (`+N in Smart tasks`). Formatter rather
// than a constant because the count is dynamic; sourced from shared-domain so
// the runtime can reuse the exact phrasing.
export const formatSmartTaskWidgetOverflow = (count: number): string =>
  `+${count} in Smart tasks`;

// ─── Device insight widget ────────────────────────────────────────────────────
//
// One device's tile: its overview status and its smart task. A tap opens the
// task's detail, or the shared creation flow when the device has no open task.
// The status lines themselves are the overview card's, from the backend; these
// are only the tile's own words.
export const DEVICE_WIDGET_COPY = {
  // Before a device is chosen in the widget's settings.
  chooseDevice: 'Choose a device in the widget settings.',
  // The chosen device is no longer in PELS's plan (removed, or not managed).
  notManaged: 'PELS no longer manages this device. Choose another device in the widget settings.',
  // No plan yet since the app started: no status rather than a guessed one.
  starting: 'PELS is starting. Status shows after the first power reading.',
  loadError: 'Could not load this device.',
  smartTaskTitle: 'Smart task',
  // What a tap on the tile does, read after the tile's content by assistive
  // tech; the chevron shows it.
  openTaskAction: 'Open the smart task',
  startTaskAction: 'Start a smart task',
} as const;

// "Next run 02:00": when a running task's next planned hour starts.
export const formatDeviceWidgetNextRun = (localTime: string): string => `Next run ${localTime}`;
// The task is inside one of its planned hours now.
export const DEVICE_WIDGET_RUNNING_NOW = 'Planned to run now';

// The ended task's one detail line: when it reached its goal ("Reached at
// 05:42"), else why it was missed, else when it ended ("Ended Today 06:00").
export const formatDeviceWidgetEndedDetail = (
  reachedAtLabel: string | null,
  whyLabel: string | null,
  finishedLabel: string,
): string => {
  if (reachedAtLabel !== null) return reachedAtLabel.charAt(0).toUpperCase() + reachedAtLabel.slice(1);
  return whyLabel ?? `Ended ${finishedLabel}`;
};

// The tile's lead figure from a status reading: "54.0 °C" with "target 65 °C",
// or "58%" with the linked car's name, spaced as smart-task goals are.
export const formatDeviceWidgetFigure = (
  reading: DeviceStatusReading,
  carName: string | null,
): { value: string; context: string } => (
  reading.kind === 'temperature'
    ? { value: `${reading.currentC.toFixed(1)} °C`, context: `target ${reading.targetC.toFixed(0)} °C` }
    : { value: formatSmartTaskGoalValue(Math.round(reading.percent), '%'), context: carName ?? '' }
);
