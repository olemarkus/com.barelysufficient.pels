import {
  CREATE_SMART_TASK_WIDGET_COPY,
  SMART_TASK_EDIT_COPY,
  SMART_TASK_EXTRA_PERMISSION_HINTS,
  SMART_TASK_EXTRA_PERMISSION_LABELS,
  formatQuickTargetDeadline,
  formatQuickTargetTiming,
  formatSmartTaskGoalValue,
  formatSmartTaskGoalContextLine,
  formatSmartTaskNowValueLine,
  formatSmartTaskUnknownNowValueLine,
  resolveSmartTaskPreviewStatusCopy,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import {
  formatCheapestHoursSubtext,
  formatSmartTaskDeadlineLong,
} from '../../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import {
  SMART_TASK_DEVICE_PICKER_COPY,
  resolveSmartTaskDeviceGroup,
  resolveSmartTaskDeviceGroupIconLabel,
} from '../../../../packages/shared-domain/src/smartTaskDevicePickerOrder';
import { renderPreviewChart } from './previewChart';
import { clearChildren, hide, setLine, setVisible } from '../../../_shared/widgetDom';
import { formatPreviewCostLine, formatPreviewEnergyLine } from '../../../_shared/smartTaskPreviewLines';
import type {
  CreateSmartTaskDevice,
  CreateSmartTaskDevicesPayload,
  CreateSmartTaskPreviewResponse,
  CreateSmartTaskQuickTarget,
} from '../createSmartTaskWidgetTypes';

const C = CREATE_SMART_TASK_WIDGET_COPY;

// The quick-target step: loading while the app times each target, then the
// boxes with one selected. Start creates the selected target directly.
export type TimedQuickTargets = { kind: 'ready'; targets: CreateSmartTaskQuickTarget[]; selected: number };
export type QuickTargetsState = { kind: 'loading' } | TimedQuickTargets;

// Where "Back" from the goal form leads: the quick targets it was opened from,
// as they were timed, or the device list when the device offers none (or none
// could be timed).
export type ComposeOrigin = { kind: 'picker' } | { kind: 'quick'; quick: TimedQuickTargets };

// The widget walks five states. `quick`, `compose` and `preview` carry the
// in-progress candidate so a re-render keeps the user's selections; `created`
// is a brief success flash before the controller resets to `picker`.
export type ViewState =
  | { kind: 'picker' }
  | {
    kind: 'quick';
    device: CreateSmartTaskDevice;
    quick: QuickTargetsState;
    submitting: boolean;
    error: string | null;
  }
  | {
    kind: 'compose';
    device: CreateSmartTaskDevice;
    origin: ComposeOrigin;
    // A cleared input stays a draft; preview requires a valid numeric goal.
    goal: number | null;
    readyByLocalTime: string;
    // Opt-in "Extra permissions", both default off and carried through
    // compose → preview → create so the user's choice survives a re-render and
    // the preview/create reflect it. `limitLowerPriorityDevices` is only
    // offered when the device can use it (`device.supportsLimitLowerPriority`).
    exemptFromBudget: boolean;
    limitLowerPriorityDevices: boolean;
  }
  | {
    kind: 'preview';
    device: CreateSmartTaskDevice;
    origin: ComposeOrigin;
    goal: number;
    readyByLocalTime: string;
    exemptFromBudget: boolean;
    limitLowerPriorityDevices: boolean;
    response: CreateSmartTaskPreviewResponse;
    submitting: boolean;
    error: string | null;
  }
  | { kind: 'created' };

export type RenderTargets = {
  root: HTMLElement;
  // Picker
  pickerView: HTMLElement;
  pickerPrompt: HTMLElement;
  pickerCaption: HTMLElement;
  pickerList: HTMLElement;
  pickerEmpty: HTMLElement;
  pickerEmptyHint: HTMLElement;
  pickerRetryBtn: HTMLButtonElement;
  deviceTemplate: HTMLTemplateElement;
  // Quick targets
  quickView: HTMLElement;
  quickBackBtn: HTMLButtonElement;
  quickTitle: HTMLElement;
  quickStatusEl: HTMLElement;
  quickList: HTMLElement;
  quickSummaryEl: HTMLElement;
  quickFinishEl: HTMLElement;
  quickErrorEl: HTMLElement;
  quickCustomizeBtn: HTMLButtonElement;
  quickStartBtn: HTMLButtonElement;
  quickTargetTemplate: HTMLTemplateElement;
  // Compose
  composeView: HTMLElement;
  composeBackBtn: HTMLButtonElement;
  composeTitle: HTMLElement;
  goalLabel: HTMLElement;
  goalValueEl: HTMLInputElement;
  goalUnitEl: HTMLElement;
  goalContextEl: HTMLElement;
  goalDecBtn: HTMLButtonElement;
  goalIncBtn: HTMLButtonElement;
  readyByLabel: HTMLElement;
  readyByInput: HTMLInputElement;
  readyByEchoEl: HTMLElement;
  composeErrorEl: HTMLElement;
  // Extra permissions disclosure
  extraPermsTitle: HTMLElement;
  extraPermsHint: HTMLElement;
  permBudgetInput: HTMLInputElement;
  permBudgetLabel: HTMLElement;
  permBudgetHint: HTMLElement;
  permLimitToggle: HTMLElement;
  permLimitInput: HTMLInputElement;
  permLimitLabel: HTMLElement;
  permLimitHint: HTMLElement;
  previewBtn: HTMLButtonElement;
  // Preview — task intent leads, followed by feasibility and estimates.
  previewView: HTMLElement;
  previewBackBtn: HTMLButtonElement;
  previewTitle: HTMLElement;
  previewDeviceEl: HTMLElement;
  previewGoalEl: HTMLElement;
  previewChartLegendEl: HTMLElement;
  previewChartPriceEl: HTMLElement;
  previewChartScheduledEl: HTMLElement;
  previewWarningHintEl: HTMLElement;
  previewFeasibilityEl: HTMLElement;
  previewCostEl: HTMLElement;
  previewCostSubtextEl: HTMLElement;
  previewChartEl: HTMLElement;
  previewWhenEl: HTMLElement;
  previewEnergyEl: HTMLElement;
  previewCaveatEl: HTMLElement;
  previewUnavailableEl: HTMLElement;
  previewErrorEl: HTMLElement;
  createBtn: HTMLButtonElement;
  previewEditBtn: HTMLButtonElement;
  // Created flash
  createdView: HTMLElement;
  createdMsgEl: HTMLElement;
};

// ─── Picker ──────────────────────────────────────────────────────────────────

const renderDeviceRow = (
  template: HTMLTemplateElement,
  device: CreateSmartTaskDevice,
): HTMLElement => {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const li = fragment.querySelector('.row');
  if (!(li instanceof HTMLElement)) throw new Error('device template missing .row');
  const button = li.querySelector('[data-device-button]');
  if (button instanceof HTMLElement) {
    button.dataset.deviceId = device.deviceId;
    button.setAttribute('aria-label', `${device.deviceName}, ${C.pickDevicePrompt}`);
  }
  const iconEl = li.querySelector('[data-device-icon]');
  if (iconEl instanceof HTMLElement) {
    // The CSS picks the glyph mask from `data-group`; the aria-label names the
    // device family so the icon isn't an unlabelled image to a screen reader.
    const group = resolveSmartTaskDeviceGroup(device);
    iconEl.dataset.group = group;
    iconEl.setAttribute('aria-label', resolveSmartTaskDeviceGroupIconLabel(group));
  }
  const nameEl = li.querySelector('[data-device-name]');
  const metaEl = li.querySelector('[data-device-meta]');
  if (nameEl instanceof HTMLElement) nameEl.textContent = device.deviceName;
  if (metaEl instanceof HTMLElement) {
    // "Now 42%" / "Now 48 °C" hint (shared formatter), or an explicit unknown
    // state when the device has not reported a reading.
    metaEl.textContent = formatSmartTaskNowValueLine({
      currentValue: device.currentValue,
      unitSymbol: device.unitSymbol,
    }) ?? formatSmartTaskUnknownNowValueLine(device.kind);
  }
  return li;
};

const renderPicker = (targets: RenderTargets, payload: CreateSmartTaskDevicesPayload | null): void => {
  const {
    pickerPrompt, pickerCaption, pickerList, pickerEmpty, pickerEmptyHint, pickerRetryBtn, deviceTemplate,
  } = targets;
  pickerPrompt.textContent = C.pickDevicePrompt;
  clearChildren(pickerList);
  if (!payload || payload.state !== 'ready') {
    // Two non-ready shapes share the empty-state layout but read differently:
    // `error` (a failed fetch, or a null payload before the first load) offers
    // tap-to-retry; `empty` (no eligible devices) is a calm dead-end with an
    // eligibility hint and no retry — retrying would change nothing.
    const isError = !payload || payload.state === 'error';
    // The empty state's own hint already explains eligibility — don't double up
    // with the caption.
    setLine(pickerCaption, null);
    pickerList.hidden = true;
    pickerEmpty.hidden = false;
    pickerEmpty.textContent = payload?.state === 'empty' ? payload.subtitle : C.loadError;
    const hint = payload?.state === 'empty' ? payload.hint : null;
    if (hint) {
      pickerEmptyHint.hidden = false;
      pickerEmptyHint.textContent = hint;
    } else {
      pickerEmptyHint.hidden = true;
    }
    pickerRetryBtn.hidden = !isError;
    pickerRetryBtn.textContent = C.loadErrorRetry;
    return;
  }
  setLine(pickerCaption, SMART_TASK_DEVICE_PICKER_COPY.eligibilityCaption);
  pickerList.hidden = false;
  pickerEmpty.hidden = true;
  pickerEmptyHint.hidden = true;
  pickerRetryBtn.hidden = true;
  for (const device of payload.devices) {
    pickerList.appendChild(renderDeviceRow(deviceTemplate, device));
  }
};

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
  targets: RenderTargets,
  view: Extract<ViewState, { kind: 'compose' }>,
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
  targets: RenderTargets,
  view: Extract<ViewState, { kind: 'compose' }>,
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
  targets: RenderTargets,
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

const renderQuick = (targets: RenderTargets, view: Extract<ViewState, { kind: 'quick' }>): void => {
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
const renderOkPreview = (targets: RenderTargets, response: OkPreview): void => {
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

const hidePreviewLines = (targets: RenderTargets): void => {
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
  targets: RenderTargets,
  view: Extract<ViewState, { kind: 'preview' }>,
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

export const renderWidget = (
  targets: RenderTargets,
  payload: CreateSmartTaskDevicesPayload | null,
  view: ViewState,
): void => {
  const { root, pickerView, quickView, composeView, previewView, createdView, createdMsgEl } = targets;
  root.dataset.view = view.kind;
  setVisible(pickerView, view.kind === 'picker');
  setVisible(quickView, view.kind === 'quick');
  setVisible(composeView, view.kind === 'compose');
  setVisible(previewView, view.kind === 'preview');
  setVisible(createdView, view.kind === 'created');

  if (view.kind === 'picker') {
    renderPicker(targets, payload);
    return;
  }
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
