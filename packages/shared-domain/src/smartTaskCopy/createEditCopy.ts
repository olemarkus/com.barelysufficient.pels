// Copy for creating and editing a smart task: the create widget, the Smart
// tasks page's New smart task flow, the preview, and the detail-page editor.
import type {
  DeferredObjectivePlanPreviewEstimate,
  DeferredObjectivePlanPreviewUnavailableReason,
} from '../../../contracts/src/deferredObjectivePlanPreview';
import { SMART_TASK_SUB_HOME_UNAVAILABLE } from '../objectiveWriteStrings';
import { WAITING_FOR_CAR_ASSOCIATION } from './pendingReasons';
import { SMART_TASK_EXTRA_PERMISSIONS_TITLE } from './permissionsCopy';
import {
  WHY_AT_RISK_BUDGET,
  WHY_AT_RISK_BUDGET_PARTIAL,
  WHY_AT_RISK_HIGHER_PRIORITY_LOAD,
  WHY_CANNOT_MEET_BUDGET,
  WHY_CANNOT_MEET_BUDGET_PARTIAL,
} from './shortfallCauses';

// ─── Create-smart-task widget copy ───────────────────────────────────────────
// User-facing strings for the standalone "Create smart task" dashboard widget.
// Housed here (not inlined in the widget package) so the strings sit beside the
// rest of the smart-task vocabulary and runtime log breadcrumbs can reuse the
// same wording per `feedback_ui_text_shared_with_logs`. The widget lets the
// user set a goal on an eligible device and preview when it runs and what it
// will cost before committing — "smart task" / "Ready by" / "objective"
// vocabulary only, no shed/restore/headroom jargon (`notes/ui-terminology.md`).
export const CREATE_SMART_TASK_WIDGET_COPY = {
  // Step 1 — device picker.
  pickDeviceTitle: 'Create smart task',
  pickDevicePrompt: 'Choose a device',
  emptyNoDevices: 'No eligible devices',
  // Warmer than a bare capability list: name the device kinds AND the next
  // action, so a user with nothing yet knows exactly how to make a device
  // appear here rather than hitting a dead end.
  emptyNoDevicesHint: 'Add a thermostat, water heater, or EV charger in Homey and it’ll appear here.',
  loadError: 'Could not load devices.',
  // Tap target paired with `loadError`: re-runs the device fetch in place so a
  // stuck load recovers without closing and reopening the widget. Imperative
  // verb (Material text-button convention) rather than the "Try again later"
  // resignation in the subtitle.
  loadErrorRetry: 'Try again',
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
  previewing: 'Previewing…',
  invalidGoal: 'Enter a goal within this device’s range.',
  invalidReadyBy: 'Choose a ready-by time.',
  // Step 3 — preview + confirm.
  previewTitle: 'Preview',
  // Plain schedule-window word ("these hours are scheduled to run") rather
  // than the one-off noun "Runs". NOT the status-chip vocabulary — `Scheduled`
  // was retired as a status chip (the list now says `On track`); it stays
  // valid as a when-window label like this preview row and the widget
  // trajectory's run-band key.
  scheduledLabel: 'Scheduled',
  energyLabel: 'Energy',
  costLabel: 'Cost',
  // The estimate coordinates against the current higher-priority roster, but
  // future prices, measurements, and task edits can still move it. Keep the
  // caveat short for the 320–480 px widget.
  estimateCaveat: 'Estimate — the actual run may differ as prices and other tasks change.',
  createButton: 'Create task',
  createAnywayButton: 'Create anyway',
  chartPrice: 'Price',
  chartScheduled: 'Scheduled',
  cannotMeetHint: 'PELS will work toward this goal within your power limits, but it may not finish in time.',
  backButton: 'Back',
  // Shown when the preview can't be projected and the backend did not provide a
  // more specific missing-input reason. Distinct from a hard error. Avoids the
  // reserved "plan" noun (`feedback_terminology_plan_vs_deadline`).
  previewUnavailable: 'Can’t preview this yet — PELS needs more current data for this window.',
  // Shown specifically when the device has no learned energy profile yet
  // (`unavailableReason === 'needs_observation'`): there is no temperature
  // bootstrap rate, so PELS can't estimate the run until it has watched the
  // device draw power. Tells the user the two ways to make that happen rather
  // than (falsely) blaming prices. Names the real per-device toggle
  // ("Power-limit control", see settings-ui `devices.ts`) so the remedy is
  // actionable. Avoids the reserved "plan" noun.
  previewNeedsObservation:
    'PELS needs to observe this device in action before it can be used for a smart task. '
    + 'Either let it run normally for a while, or turn on Power-limit control for it.',
  // Shown when the candidate's goal is already met (preview `status: 'satisfied'`
  // → zero scheduled hours): there is nothing to schedule, so explain that
  // honestly rather than reusing the no-prices line. Uses the canonical "goal"
  // noun (matches `goalLabel`) and avoids the reserved "plan" noun.
  previewSatisfied: 'This goal is already met — nothing to schedule.',
  // Pending state on the Create button while the /create round-trip is in
  // flight. Distinct from `created` (the confirmed-success label): the button
  // must read as work-in-progress, never as success, until a `{ ok: true }`
  // create actually lands — otherwise a still-pending or later-failed create
  // would have flashed "Smart task created" before anything was persisted.
  creating: 'Creating…',
  // Shown briefly after a successful create before the widget resets.
  created: 'Smart task created',
  // Quick targets: one-tap goals, each timed to the earliest finish plus slack.
  quickLoading: 'Finding the earliest times…',
  quickCustomizeButton: 'Customize',
  quickStartButton: 'Start',
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
  // cap (`feedback_hard_cap_is_physical`). The title is an alias of the
  // surface-neutral constant in `permissionsCopy.ts` — the smart-task editor shows the same
  // string, so it must not live under a create-widget-scoped name.
  extraPermissionsTitle: SMART_TASK_EXTRA_PERMISSIONS_TITLE,
  extraPermissionsHint: 'Off unless you turn them on — only used to hit this deadline.',
  // Shown in the preview when the coordinated projection returns a real planner
  // verdict that the deadline may not be met — `cannot_meet` (won't make it) or
  // `at_risk` (might not). Surfaced as a prominent warning so a user never
  // commits an unreachable ready-by believing it is fine. The estimate
  // can still change with future measurements and re-plans, so the copy is a
  // plain warning, not a soft hint. Distinct from `previewUnavailable`, which is a missing-price /
  // projection gap rather than a feasibility verdict.
  cannotMeet: 'Cannot finish — not enough usable time before this ready-by time.',
  atRisk: 'At risk — this may need most of the available window.',
} as const;

// The card a Smart task carries about its device for the time after the task:
// who starts the device then, as its device settings answer it
// (`packages/settings-ui/src/ui/deviceStartRule.ts`), with a link to those
// settings. During the task the task decides, so this is the part of the
// device's behaviour the task does not cover, and the part owners forget.
export const SMART_TASK_AFTER_TASK_COPY = {
  title: 'When the task is done',
  changeAction: 'Change',
} as const;

// The Smart tasks page's New smart task flow. Shares the create widget's field,
// preview and error copy (`CREATE_SMART_TASK_WIDGET_COPY`); these are the
// strings only the page has.
export const SMART_TASK_CREATE_PAGE_COPY = {
  newTaskAction: 'New smart task',
  pickPrompt: 'Choose the managed device the task is for.',
  // The list holds managed devices only, so the fix is Managed by PELS, not
  // adding a device in Homey (the widget's wording).
  noDevices: 'No device can take a smart task yet. Turn on Managed by PELS for a thermostat, '
    + 'water heater, EV charger, or an on/off device with a power reading.',
  // Picker row for a device that already has an open task: choosing it opens
  // that task, because a device carries one task at a time.
  openTask: 'Open its smart task',
  previewTask: 'Preview task',
  editGoal: 'Edit goal',
  chooseAnotherDevice: 'Choose another device',
  // The device page's Smart task box.
  boxTitle: 'Smart task',
  addTask: 'Add smart task',
  addTaskHint: 'Set a goal and when this device should reach it.',
  viewTask: 'View task',
} as const;

// First-run body on the Smart tasks page, beside its New smart task action.
export const SMART_TASK_LIST_CREATE_HINT
  = 'No smart tasks yet. Set a goal and ready-by time for a managed device. PELS will choose when it runs.';

const PREVIEW_UNAVAILABLE_COPY_BY_REASON: Record<DeferredObjectivePlanPreviewUnavailableReason, string> = {
  invalid_deadline: 'Can’t preview this ready-by time yet.',
  invalid_session: 'Can’t preview this yet — plug the EV in to start.',
  missing_capacity: 'Can’t preview this yet — PELS needs power readings from this device.',
  missing_device: 'Can’t preview this yet — PELS can’t find this device.',
  device_unmanaged: 'Can’t preview this yet — turn “Managed by PELS” on for this device.',
  needs_observation: CREATE_SMART_TASK_WIDGET_COPY.previewNeedsObservation,
  missing_prices: 'Can’t preview this yet — prices through this window are not available yet.',
  missing_reading: 'Can’t preview this yet — PELS needs a current device reading.',
  price_feature_disabled: 'Can’t preview this yet — price-aware planning is off.',
  waiting_for_car: WAITING_FOR_CAR_ASSOCIATION,
  progress_stale: 'Can’t preview this yet — PELS needs a fresher device reading.',
  settings_unavailable: 'Can’t preview this yet — PELS couldn’t read Smart tasks. Try again.',
  unknown: CREATE_SMART_TASK_WIDGET_COPY.previewUnavailable,
};

export const resolveSmartTaskPreviewUnavailableCopy = (
  reason: DeferredObjectivePlanPreviewUnavailableReason | undefined,
): string => PREVIEW_UNAVAILABLE_COPY_BY_REASON[reason ?? 'unknown'];

export const resolveSmartTaskPreviewStatusCopy = (
  estimate: Pick<
    DeferredObjectivePlanPreviewEstimate,
    'status' | 'unavailableReason' | 'budgetRole' | 'floorShortfallCause'
  >,
): string | null => {
  const { status, budgetRole } = estimate;
  switch (status) {
    case 'unavailable':
      return resolveSmartTaskPreviewUnavailableCopy(estimate.unavailableReason);
    case 'cannot_meet':
      if (budgetRole === 'sole') return `Cannot finish — ${WHY_CANNOT_MEET_BUDGET}`;
      if (budgetRole === 'contributing') return `Cannot finish — ${WHY_CANNOT_MEET_BUDGET_PARTIAL}`;
      return CREATE_SMART_TASK_WIDGET_COPY.cannotMeet;
    case 'at_risk':
      if (budgetRole === 'sole') return `At risk — ${WHY_AT_RISK_BUDGET}`;
      if (budgetRole === 'contributing') return `At risk — ${WHY_AT_RISK_BUDGET_PARTIAL}`;
      // Room taken by higher-priority load is not a short window.
      if (estimate.floorShortfallCause === 'higher_priority_load') {
        return `At risk. ${WHY_AT_RISK_HIGHER_PRIORITY_LOAD}`;
      }
      return CREATE_SMART_TASK_WIDGET_COPY.atRisk;
    case 'satisfied':
      return CREATE_SMART_TASK_WIDGET_COPY.previewSatisfied;
    case 'invalid':
    case 'on_track':
      return null;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

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
  if (reason === 'device_in_sub_home') return SMART_TASK_SUB_HOME_UNAVAILABLE;
  return CREATE_SMART_TASK_WIDGET_COPY.createError;
};

// ─── Smart-task detail-page edit/clear (settings UI) ─────────────────────────
//
// The detail page can change a running task's ready-by time and target, and
// clear the task. "Clear" is the canonical removal verb (matches the "Clear
// smart task" Flow card); never "Cancel/Stop/Abort" (`notes/ui-terminology.md`).
// Field labels reuse the create widget's vocabulary (`goalLabel`,
// `readyByLabel`) so composing and editing a task read as one language.
export const SMART_TASK_EDIT_COPY = {
  editButton: 'Edit task',
  // Section hint for the editor's "Extra permissions" disclosure. The create
  // widget's variant opens "Off unless you turn them on", which is false on an
  // existing task whose permissions may already be granted — so this one only
  // keeps the scope half, which is the part that must never be overstated
  // (these buy the task priority for THIS deadline; they do not raise the cap
  // or create more power).
  permissionsHint: 'Only used to hit this ready-by time.',
  saveButton: 'Save changes',
  saving: 'Saving…',
  discardButton: 'Discard',
  clearButton: 'Clear task',
  clearing: 'Clearing…',
  // Confirmation dialog for Clear. Names the device, because the page may be
  // one of several open task pages the owner has moved between.
  clearDialogTitle: 'Clear smart task?',
  clearDialogBody: (deviceName: string): string => (
    `PELS will stop scheduling the task for ${deviceName}. The run so far moves to Past tasks.`
  ),
  clearDialogKeep: 'Keep task',
  clearDialogConfirm: 'Clear task',
  // Honest about the mechanics: saving re-plans the task, and the run so far
  // is filed under Past tasks (where it wears the Abandoned chip) — said here
  // so the user who later scans history isn't surprised by a run they never
  // knowingly abandoned.
  updated: 'Smart task updated — the earlier run is now in Past tasks.',
  // A permission-only save changes no goal, no ready-by, and no deadline, so
  // `objectivesMatch` holds and the recorder no-ops: the run continues and
  // NOTHING lands in Past tasks. Claiming otherwise would send the user looking
  // for a history entry that doesn't exist — and read as though flipping a
  // toggle had broken their task. Says "this run", not "re-planned": *plan* is
  // reserved for the planning layer on smart-task surfaces
  // (`notes/ui-terminology.md` § "Plan vs deadline").
  updatedPermissionsOnly: 'Smart task updated — the new permissions apply to this run.',
  cleared: 'Smart task cleared.',
  // The task ended (completed/expired/cleared elsewhere) while the editor was
  // open — the editor closes rather than offering a retry that would re-create
  // it. Verb-neutral so the line reads correctly after a save AND after a
  // clear tap.
  taskEnded: 'This task has already ended.',
  clearError: 'Could not clear the task just now. Try again.',
  // Save failure umbrella for an edit (mirrors `createError` but names the
  // save action — the task itself is unchanged and still running).
  updateError: 'Could not save the changes. Check the goal and try again.',
  // Edit-specific deadline-slip line. The create widget's variant says
  // "Preview again" — a button this surface doesn't have (previews run
  // automatically); the recourse must name an action that exists here.
  deadlinePassed: 'That ready-by time just passed. Pick a later time and save again.',
  // Shown in the preview slot while the debounced estimate round-trip is in
  // flight, so the landing/cost lines don't pop in and out of the layout.
  previewing: 'Updating estimate…',
  // Draft landing-line prefixes (see `composeSmartTaskDraftLandingLine`).
  ifYouSavePrefix: 'If you save:',
  ifYouSaveRunsWord: 'runs',
} as const;

// The open editor's landing line for an UNSAVED draft: "If you save: runs
// 02:00–04:00 · Ready by Tomorrow 06:30". Explicitly conditional — the hero
// above still shows the CURRENT plan, so without the prefix the two schedules
// would contradict each other on one screen; and never the word "Scheduled",
// which claims a commitment that hasn't happened yet. Both halves arrive
// pre-formatted from the server (Homey timezone) — string-stitching only.
export const composeSmartTaskDraftLandingLine = (params: {
  scheduledWindowLabel: string | null;
  deadlineLabel: string;
}): string => {
  const readyByPart = `${CREATE_SMART_TASK_WIDGET_COPY.readyByLabel} ${params.deadlineLabel}`;
  if (params.scheduledWindowLabel === null) {
    return `${SMART_TASK_EDIT_COPY.ifYouSavePrefix} ${readyByPart}`;
  }
  return `${SMART_TASK_EDIT_COPY.ifYouSavePrefix} ${SMART_TASK_EDIT_COPY.ifYouSaveRunsWord} `
    + `${params.scheduledWindowLabel} · ${readyByPart}`;
};

// The create preview's landing line ("Scheduled 02:00–04:00 · Ready by
// Tomorrow 07:00"), the widget's wording: there is no current plan beside it
// to tell a draft apart from, so it needs no "If you save:".
export const composeSmartTaskCreateLandingLine = (params: {
  scheduledWindowLabel: string | null;
  deadlineLabel: string;
}): string => {
  const readyByPart = `${CREATE_SMART_TASK_WIDGET_COPY.readyByLabel} ${params.deadlineLabel}`;
  if (params.scheduledWindowLabel === null) return readyByPart;
  return `${CREATE_SMART_TASK_WIDGET_COPY.scheduledLabel} ${params.scheduledWindowLabel} · ${readyByPart}`;
};

// Goal-field range hint ("Range 30–75 °C."), shared-domain-homed so the
// wording can't drift per surface.
export const formatSmartTaskGoalRangeHint = (min: number, max: number, unit: string): string => (
  `Range ${min}–${max} ${unit}.`
);

// Map an edit/clear rejection to its user-facing line. Shares the create
// widget's copy for `write_conflict`, carries edit-specific lines for
// `task_not_found` and `deadline_passed`; everything else collapses to the
// edit-flavoured generic line.
export const resolveSmartTaskEditRejectCopy = (reason: string | undefined): string => {
  if (reason === 'task_not_found') return SMART_TASK_EDIT_COPY.taskEnded;
  if (reason === 'deadline_passed') return SMART_TASK_EDIT_COPY.deadlinePassed;
  if (reason === 'write_conflict') return CREATE_SMART_TASK_WIDGET_COPY.writeConflict;
  // The device moved to a separate-meter sub-home while the task existed — the
  // save is refused with the shared scope line ("check the goal" would be
  // dishonest; the goal is fine, the device is out of scope).
  if (reason === 'device_in_sub_home') return SMART_TASK_SUB_HOME_UNAVAILABLE;
  return SMART_TASK_EDIT_COPY.updateError;
};
