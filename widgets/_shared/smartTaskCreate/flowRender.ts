import {
  CREATE_SMART_TASK_WIDGET_COPY,
  SMART_TASK_EDIT_COPY,
  SMART_TASK_EXTRA_PERMISSION_HINTS,
  SMART_TASK_EXTRA_PERMISSION_LABELS,
  formatSmartTaskGoalValue,
  formatSmartTaskGoalContextLine,
  resolveSmartTaskPreviewStatusCopy,
} from '../../../packages/shared-domain/src/deadlineLabels';
import {
  formatCheapestHoursSubtext,
  formatSmartTaskDeadlineLong,
} from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { renderPreviewChart } from './previewChart';
import { clearChildren, hide, setLine, setVisible } from '../widgetDom';
import { formatPreviewCostLine, formatPreviewEnergyLine } from '../smartTaskPreviewLines';
import type { FlowTargets, FlowView, TimedQuickTargets } from './flowView';
import type {
  CreateSmartTaskDevice,
  CreateSmartTaskPreviewResponse,
  CreateSmartTaskQuickTarget,
} from './types';

// A quick-target box's deadline ("by 01:30"), and the selected box's full
// deadline with its projected finish ("Ready by Tomorrow 01:30 · likely done
// around 00:50"), which also says which day the box's bare time is on. The
// times and the deadline label are server-formatted in the Homey timezone.
const formatQuickTargetDeadline = (localTime: string): string => `by ${localTime}`;
const formatQuickTargetTiming = (deadlineLabel: string, likelyFinishLocalTime: string | null): string => (
  likelyFinishLocalTime === null
    ? `Ready by ${deadlineLabel}`
    : `Ready by ${deadlineLabel} · likely done around ${likelyFinishLocalTime}`
);

const C = CREATE_SMART_TASK_WIDGET_COPY;

// ─── Compose ───────────────────────────────────────────────────────────────

// Resolved "Ready by Tomorrow 07:00" echo for the compose step so a bare
// "07:00" chip isn't ambiguous about which day. This is a browser-local hint
// (the authoritative DST-aware deadline is resolved server-side and shown in
// the preview); `formatSmartTaskDeadlineLong` with a null timezone formats in
// the host's own zone, which matches how the user reads the local chip time.
const resolveReadyByEcho = (readyByLocalTime: string): string | null => {
  const match = readyByLocalTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return `${C.readyByLabel} ${formatSmartTaskDeadlineLong(next.getTime(), now.getTime(), null)}`;
};

// The collapsed "Extra permissions" disclosure. Both toggles reflect the view's
// opt-in state; the limit-lower-priority toggle is only OFFERED for a device that
// can use it (`supportsLimitLowerPriority`, gated on effect server-side).
const renderExtraPermissions = (
  targets: FlowTargets,
  view: Extract<FlowView, { kind: 'compose' }>,
): void => {
  const {
    extraPermsTitle, extraPermsHint,
    permBudgetInput, permBudgetLabel, permBudgetHint,
    permLimitToggle, permLimitInput, permLimitLabel, permLimitHint,
  } = targets;
  extraPermsTitle.textContent = C.extraPermissionsTitle;
  extraPermsHint.textContent = C.extraPermissionsHint;
  permBudgetLabel.textContent = SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget;
  permBudgetHint.textContent = SMART_TASK_EXTRA_PERMISSION_HINTS.exemptFromBudget;
  permBudgetInput.checked = view.exemptFromBudget;
  permLimitLabel.textContent = SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices;
  permLimitHint.textContent = SMART_TASK_EXTRA_PERMISSION_HINTS.limitLowerPriorityDevices;
  const offerLimit = view.device.supportsLimitLowerPriority;
  setVisible(permLimitToggle, offerLimit);
  permLimitInput.checked = view.limitLowerPriorityDevices;
};

const renderCompose = (
  targets: FlowTargets,
  view: Extract<FlowView, { kind: 'compose' }>,
): void => {
  const { device, goal, readyByLocalTime } = view;
  const { composeTitle, goalLabel, goalValueEl, goalContextEl, goalDecBtn, goalIncBtn } = targets;
  const { readyByLabel, readyByEchoEl, previewBtn } = targets;
  const { goalUnitEl, readyByInput, composeErrorEl } = targets;
  // Static field labels + the action button sourced from the copy table so a
  // copy edit reaches the UI (the HTML literals are just SSR-less placeholders).
  goalLabel.textContent = C.goalLabel;
  readyByLabel.textContent = C.readyByLabel;
  previewBtn.textContent = C.previewButton;
  renderExtraPermissions(targets, view);
  // Back-label is the plain device name — the kind-aware "Charge to" / "Heat to"
  // verb is built to PRECEDE a value, so pairing it with a bare device name
  // ("Charge to Driveway charger") reads as broken English. The goal value lives
  // on the stepper + the goal-context line below it.
  composeTitle.textContent = device.deviceName;
  goalValueEl.min = String(device.goalMin);
  goalValueEl.max = String(device.goalMax);
  goalValueEl.step = String(device.goalStep);
  const goalText = goal === null ? '' : String(goal);
  if (goalValueEl.value !== goalText) goalValueEl.value = goalText;
  goalUnitEl.textContent = device.unitSymbol;
  if (readyByInput.value !== readyByLocalTime) readyByInput.value = readyByLocalTime;
  // Anchor the goal against the current reading ("Goal 80% · now 42%" /
  // "from 42% → 80%") so the target isn't shown in a vacuum.
  setLine(goalContextEl, goal === null ? null : formatSmartTaskGoalContextLine(
    goal,
    device.currentValue,
    device.unitSymbol,
  ));
  goalDecBtn.disabled = goal === null || goal <= device.goalMin;
  goalIncBtn.disabled = goal === null || goal >= device.goalMax;
  setLine(readyByEchoEl, resolveReadyByEcho(readyByLocalTime));
  const validGoal = goalValueEl.validity.valid;
  const validTime = /^([01]\d|2[0-3]):([0-5]\d)$/.test(readyByLocalTime);
  previewBtn.disabled = !validGoal || !validTime;
  const goalError = !validGoal ? C.invalidGoal : null;
  const timeError = !validTime ? C.invalidReadyBy : null;
  setLine(composeErrorEl, goalError ?? timeError);
};

// ─── Quick targets ───────────────────────────────────────────────────────────

const renderQuickTargetButton = (
  template: HTMLTemplateElement,
  target: CreateSmartTaskQuickTarget,
  index: number,
  unitSymbol: CreateSmartTaskDevice['unitSymbol'],
): HTMLElement | null => {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const button = fragment.querySelector('[data-quick-target]');
  const valueEl = fragment.querySelector('[data-quick-target-value]');
  const byEl = fragment.querySelector('[data-quick-target-by]');
  if (!(button instanceof HTMLElement) || !valueEl || !byEl) return null;
  button.dataset.quickIndex = String(index);
  valueEl.textContent = formatSmartTaskGoalValue(target.target, unitSymbol);
  byEl.textContent = formatQuickTargetDeadline(target.readyByLocalTime);
  button.setAttribute('aria-label', `${valueEl.textContent} ${byEl.textContent}`);
  return button;
};

const renderQuickList = (
  targets: FlowTargets,
  quick: TimedQuickTargets,
  unitSymbol: CreateSmartTaskDevice['unitSymbol'],
): void => {
  const { quickList, quickTargetTemplate } = targets;
  // Keep the buttons across a selection change so keyboard focus stays put.
  if (quickList.childElementCount !== quick.targets.length) {
    clearChildren(quickList);
    quick.targets.forEach((target, index) => {
      const button = renderQuickTargetButton(quickTargetTemplate, target, index, unitSymbol);
      if (button) quickList.appendChild(button);
    });
  }
  for (const button of quickList.querySelectorAll<HTMLElement>('[data-quick-target]')) {
    const selected = button.dataset.quickIndex === String(quick.selected);
    button.dataset.selected = selected ? 'true' : 'false';
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
};

const renderQuick = (targets: FlowTargets, view: Extract<FlowView, { kind: 'quick' }>): void => {
  const { quick, device, submitting, error } = view;
  const {
    quickTitle, quickCustomizeBtn, quickBackBtn, quickStartBtn, quickStatusEl, quickList,
    quickSummaryEl, quickFinishEl, quickErrorEl,
  } = targets;
  quickTitle.textContent = device.deviceName;
  quickCustomizeBtn.textContent = C.quickCustomizeButton;
  quickBackBtn.disabled = submitting;
  setLine(quickStatusEl, quick.kind === 'loading' ? C.quickLoading : null);
  if (quick.kind === 'loading') {
    clearChildren(quickList);
    hide(quickSummaryEl);
    hide(quickFinishEl);
    hide(quickErrorEl);
    quickStartBtn.textContent = C.quickStartButton;
    quickStartBtn.disabled = true;
    quickCustomizeBtn.disabled = true;
    return;
  }
  renderQuickList(targets, quick, device.unitSymbol);
  const selected = quick.targets[quick.selected];
  const estimateParts = selected ? [
    formatPreviewEnergyLine(selected.estimate, C.energyLabel),
    formatPreviewCostLine(selected.estimate),
  ].filter((part): part is string => part !== null) : [];
  setLine(quickSummaryEl, estimateParts.length > 0 ? estimateParts.join(' · ') : null);
  setLine(quickFinishEl, selected
    ? formatQuickTargetTiming(selected.deadlineLabel, selected.likelyFinishLocalTime) : null);
  setLine(quickErrorEl, error);
  quickStartBtn.textContent = submitting ? C.creating : C.quickStartButton;
  quickStartBtn.disabled = submitting || selected === undefined;
  quickCustomizeBtn.disabled = submitting;
};

// ─── Preview ─────────────────────────────────────────────────────────────────

type OkPreview = Extract<CreateSmartTaskPreviewResponse, { ok: true }>;

const hasScheduledHours = (response: OkPreview): boolean => response.estimate.scheduledHours.length > 0;

// A charger with no car plugged in has nothing to plan yet, but the task is
// still worth creating: it waits for the car and plans once it is connected.
export const canCreateFromPreview = (response: CreateSmartTaskPreviewResponse): boolean => (
  response.ok
  && response.estimate.status !== 'invalid'
  && (response.estimate.status !== 'unavailable' || response.estimate.unavailableReason === 'invalid_session')
);

// Render a successfully-projected (or zero-hour) preview. Scheduled hours and
// estimates follow the task summary. The
// "cheapest hours before HH:MM" subtext rides under the cost only when there is
// a cost figure to explain. Preview verdicts sit above the figures when they
// need attention, so `cannot_meet` cannot masquerade as an ordinary estimate.
const renderOkPreview = (targets: FlowTargets, response: OkPreview): void => {
  const { previewChartPriceEl, previewChartScheduledEl } = targets;
  const scheduled = hasScheduledHours(response);
  const estimated = response.estimate.status !== 'unavailable';
  // Cost is the headline ("Cost ≈ 4.20 kr"). Null when no price was available
  // for the scheduled buckets, which suppresses both the cost line and its
  // "cheapest hours" subtext.
  const costLine = scheduled ? formatPreviewCostLine(response.estimate) : null;
  const verdictLine = resolveSmartTaskPreviewStatusCopy(
      response.estimate.status,
      response.estimate.unavailableReason,
      response.estimate.budgetRole,
    );
  setLine(targets.previewFeasibilityEl, estimated ? verdictLine : null);
  setLine(targets.previewCostEl, costLine);
  setLine(
    targets.previewCostSubtextEl,
    costLine !== null ? formatCheapestHoursSubtext(response.deadlineLabel) : null,
  );
  // The price curve with the scheduled hours highlighted — shown only when the
  // projection is usable and the backend supplied a price series. Falls back to
  // the text lines (when/energy) when there's nothing chartable.
  const charted = scheduled && response.estimate.priceSeries !== undefined
    && renderPreviewChart(targets.previewChartEl, {
      priceSeries: response.estimate.priceSeries,
      scheduledHours: response.estimate.scheduledHours,
    });
  setVisible(targets.previewChartEl, charted);
  setVisible(targets.previewChartLegendEl, charted);
  previewChartPriceEl.textContent = C.chartPrice;
  previewChartScheduledEl.textContent = C.chartScheduled;
  setLine(targets.previewWhenEl, response.scheduledWindowLabel
    ? `${C.scheduledLabel} ${response.scheduledWindowLabel}` : null);
  // Energy is the demoted secondary line — kept (it answers "how much will it
  // pull") but muted below the cost headline + when-window. When the chart is
  // shown, drop it: the chart + cost are the stars and the tile's vertical
  // budget is better spent keeping the honest estimate caveat un-clipped.
  // Energy stays as the text fallback when there's no chart.
  setLine(
    targets.previewEnergyEl,
    estimated && !charted ? formatPreviewEnergyLine(response.estimate, C.energyLabel) : null,
  );
  // Show a verdict line for unavailable / at-risk / cannot-finish / satisfied
  // previews. This keeps cannot-finish from looking like a normal estimate, and
  // avoids blaming every unavailable preview on missing prices.
  setLine(targets.previewUnavailableEl, estimated ? null : verdictLine);
  setLine(targets.previewCaveatEl, estimated && response.estimate.status !== 'satisfied' ? C.estimateCaveat : null);
};

const hidePreviewLines = (targets: FlowTargets): void => {
  hide(targets.previewFeasibilityEl);
  hide(targets.previewCostEl);
  hide(targets.previewCostSubtextEl);
  hide(targets.previewChartEl);
  hide(targets.previewChartLegendEl);
  hide(targets.previewWhenEl);
  hide(targets.previewEnergyEl);
  hide(targets.previewUnavailableEl);
  hide(targets.previewCaveatEl);
};

const renderPreview = (
  targets: FlowTargets,
  view: Extract<FlowView, { kind: 'preview' }>,
): void => {
  const { response, submitting, error } = view;
  const { createBtn, previewTitle, previewDeviceEl, previewGoalEl, previewEditBtn, previewBackBtn } = targets;
  previewTitle.textContent = C.previewTitle;
  previewDeviceEl.textContent = view.device.deviceName;
  const goalSummary = `${C.goalLabel} ${formatSmartTaskGoalValue(view.goal, view.device.unitSymbol)}`;
  previewGoalEl.textContent = response.ok
    ? `${goalSummary} · ${C.readyByLabel} ${response.deadlineLabel}` : goalSummary;
  previewEditBtn.textContent = SMART_TASK_EDIT_COPY.editButton;
  previewEditBtn.disabled = submitting;
  previewBackBtn.disabled = submitting;
  const cannotFinish = response.ok && response.estimate.status === 'cannot_meet';
  setLine(targets.previewWarningHintEl, cannotFinish ? C.cannotMeetHint : null);
  const createLabel = cannotFinish ? C.createAnywayButton : C.createButton;
  createBtn.textContent = submitting ? C.creating : createLabel;
  if (!response.ok) {
    // A failed preview (bad request / unavailable backend) collapses to the
    // unavailable line; the user can go back and adjust.
    hidePreviewLines(targets);
    setLine(targets.previewUnavailableEl, C.previewUnavailable);
    hide(targets.previewErrorEl);
    createBtn.disabled = true;
    return;
  }
  renderOkPreview(targets, response);
  setLine(targets.previewErrorEl, error);
  createBtn.disabled = submitting || !canCreateFromPreview(response);
};

// ─── Top-level ─────────────────────────────────────────────────────────────

/** Show the current step and hide the others; `null` hides the whole flow. */
export const renderFlow = (targets: FlowTargets, view: FlowView | null): void => {
  const { quickView, composeView, previewView, createdView, createdMsgEl } = targets;
  setVisible(quickView, view?.kind === 'quick');
  setVisible(composeView, view?.kind === 'compose');
  setVisible(previewView, view?.kind === 'preview');
  setVisible(createdView, view?.kind === 'created');
  if (view === null) return;
  if (view.kind === 'quick') {
    renderQuick(targets, view);
    return;
  }
  if (view.kind === 'compose') {
    renderCompose(targets, view);
    return;
  }
  if (view.kind === 'preview') {
    renderPreview(targets, view);
    return;
  }
  createdMsgEl.textContent = C.created;
};
