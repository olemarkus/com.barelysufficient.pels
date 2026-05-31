import {
  CREATE_SMART_TASK_WIDGET_COPY,
  CREATE_SMART_TASK_READY_BY_PRESETS,
  SMART_TASK_EXTRA_PERMISSION_LABELS,
  formatEnergyEstimateKWh,
  formatDeadlineCostMetaLine,
  formatSmartTaskGoalValue,
  formatSmartTaskGoalContextLine,
  formatSmartTaskNowValueLine,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import {
  composeSmartTaskScheduledLine,
  formatCheapestHoursSubtext,
  formatSmartTaskDeadlineLong,
} from '../../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import {
  SMART_TASK_DEVICE_PICKER_COPY,
  resolveSmartTaskDeviceGroupIconLabel,
} from '../../../../packages/shared-domain/src/smartTaskDevicePickerOrder';
import { renderPreviewChart } from './previewChart';
import type {
  CreateSmartTaskDevice,
  CreateSmartTaskDevicesPayload,
  CreateSmartTaskPreviewResponse,
} from '../createSmartTaskWidgetTypes';

const C = CREATE_SMART_TASK_WIDGET_COPY;

// The widget walks four states. `compose` and `preview` carry the in-progress
// candidate so a re-render keeps the user's goal/ready-by selections; `created`
// is a brief success flash before the controller resets to `picker`.
export type ViewState =
  | { kind: 'picker' }
  | {
    kind: 'compose';
    device: CreateSmartTaskDevice;
    goal: number;
    readyById: string;
    // Opt-in "Extra permissions", both default off and carried through
    // compose → preview → create so the user's choice survives a re-render and
    // the preview/create reflect it. `limitLowerPriorityDevices` is forced off
    // whenever `exemptFromBudget` is off (it is inert alone) or the device
    // can't use it (`device.supportsLimitLowerPriority`).
    exemptFromBudget: boolean;
    limitLowerPriorityDevices: boolean;
  }
  | {
    kind: 'preview';
    device: CreateSmartTaskDevice;
    goal: number;
    readyById: string;
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
  deviceTemplate: HTMLTemplateElement;
  // Compose
  composeView: HTMLElement;
  composeBackBtn: HTMLButtonElement;
  composeTitle: HTMLElement;
  goalLabel: HTMLElement;
  goalValueEl: HTMLElement;
  goalContextEl: HTMLElement;
  goalDecBtn: HTMLButtonElement;
  goalIncBtn: HTMLButtonElement;
  readyByLabel: HTMLElement;
  readyByList: HTMLElement;
  readyByEchoEl: HTMLElement;
  // Extra permissions disclosure
  extraPermsTitle: HTMLElement;
  extraPermsHint: HTMLElement;
  permBudgetInput: HTMLInputElement;
  permBudgetLabel: HTMLElement;
  permLimitToggle: HTMLElement;
  permLimitInput: HTMLInputElement;
  permLimitLabel: HTMLElement;
  permLimitNote: HTMLElement;
  previewBtn: HTMLButtonElement;
  readyByTemplate: HTMLTemplateElement;
  // Preview — cost leads, the when-window pairs with it, energy is demoted.
  previewView: HTMLElement;
  previewBackBtn: HTMLButtonElement;
  previewTitle: HTMLElement;
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
  // Created flash
  createdView: HTMLElement;
  createdMsgEl: HTMLElement;
};

const clearChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

/* eslint-disable no-param-reassign --
   The DOM-write helpers below take an element as a write sink; mutating its
   text/visibility is the helper's whole job (mirrors smart_tasks/render.ts). */

// Show `el` with `text`, or hide it when `text` is null/blank.
const setLine = (el: HTMLElement, text: string | null): void => {
  const visible = Boolean(text && text.trim());
  el.textContent = visible ? text : '';
  el.hidden = !visible;
};

const hide = (el: HTMLElement): void => { el.hidden = true; };

const setVisible = (el: HTMLElement, visible: boolean): void => { el.hidden = !visible; };

/* eslint-enable no-param-reassign */

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
    iconEl.dataset.group = device.group;
    iconEl.setAttribute('aria-label', resolveSmartTaskDeviceGroupIconLabel(device.group));
  }
  const nameEl = li.querySelector('[data-device-name]');
  const metaEl = li.querySelector('[data-device-meta]');
  if (nameEl instanceof HTMLElement) nameEl.textContent = device.deviceName;
  if (metaEl instanceof HTMLElement) {
    // "Now 42%" / "Now 48 °C" hint (shared formatter), or just the unit when
    // the device hasn't reported a reading.
    metaEl.textContent = formatSmartTaskNowValueLine({
      currentValue: device.currentValue,
      unitSymbol: device.unitSymbol,
    }) ?? device.unitSymbol;
  }
  return li;
};

const renderPicker = (targets: RenderTargets, payload: CreateSmartTaskDevicesPayload | null): void => {
  const { pickerPrompt, pickerCaption, pickerList, pickerEmpty, pickerEmptyHint, deviceTemplate } = targets;
  pickerPrompt.textContent = C.pickDevicePrompt;
  clearChildren(pickerList);
  if (!payload || payload.state === 'empty') {
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
    return;
  }
  setLine(pickerCaption, SMART_TASK_DEVICE_PICKER_COPY.eligibilityCaption);
  pickerList.hidden = false;
  pickerEmpty.hidden = true;
  pickerEmptyHint.hidden = true;
  for (const device of payload.devices) {
    pickerList.appendChild(renderDeviceRow(deviceTemplate, device));
  }
};

// ─── Compose ───────────────────────────────────────────────────────────────

const markChipSelected = (button: HTMLElement, selected: boolean): void => {
  /* eslint-disable-next-line no-param-reassign -- toggling chip selection is
     the whole job of this helper (mirrors the setLine DOM-write helpers). */
  button.dataset.selected = selected ? 'true' : 'false';
  button.setAttribute('aria-pressed', selected ? 'true' : 'false');
};

const renderReadyByChips = (targets: RenderTargets, selectedId: string): void => {
  const { readyByList, readyByTemplate } = targets;
  // Re-rendering the compose view on every goal step would otherwise rebuild
  // these chips and steal keyboard focus from a chip the user just tabbed to.
  // When the chips already exist (only the selection changed), flip the
  // selected/aria attributes in place instead of recreating the nodes.
  const existing = readyByList.querySelectorAll('[data-ready-by]');
  if (existing.length === CREATE_SMART_TASK_READY_BY_PRESETS.length) {
    for (const button of existing) {
      if (button instanceof HTMLElement) {
        markChipSelected(button, button.dataset.readyById === selectedId);
      }
    }
    return;
  }
  clearChildren(readyByList);
  for (const preset of CREATE_SMART_TASK_READY_BY_PRESETS) {
    const fragment = readyByTemplate.content.cloneNode(true) as DocumentFragment;
    const button = fragment.querySelector('[data-ready-by]');
    if (!(button instanceof HTMLElement)) continue;
    button.dataset.readyById = preset.id;
    button.textContent = preset.label;
    markChipSelected(button, preset.id === selectedId);
    readyByList.appendChild(button);
  }
};

// Resolved "Ready by Tomorrow 07:00" echo for the compose step so a bare
// "07:00" chip isn't ambiguous about which day. This is a browser-local hint
// (the authoritative DST-aware deadline is resolved server-side and shown in
// the preview); `formatSmartTaskDeadlineLong` with a null timezone formats in
// the host's own zone, which matches how the user reads the local chip time.
const resolveReadyByEcho = (readyById: string): string | null => {
  const preset = CREATE_SMART_TASK_READY_BY_PRESETS.find((entry) => entry.id === readyById);
  if (!preset) return null;
  const match = preset.localTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return `${C.readyByLabel} ${formatSmartTaskDeadlineLong(next.getTime(), now.getTime(), null)}`;
};

// The collapsed "Extra permissions" disclosure. Both toggles reflect the view's
// opt-in state; the limit-lower-priority toggle is only OFFERED for a device that
// can use it (`supportsLimitLowerPriority`, gated on effect server-side) and only
// ENABLED once budget exemption is on — inert alone, so a one-line note explains
// the gate when it is disabled.
const renderExtraPermissions = (
  targets: RenderTargets,
  view: Extract<ViewState, { kind: 'compose' }>,
): void => {
  const {
    extraPermsTitle, extraPermsHint,
    permBudgetInput, permBudgetLabel,
    permLimitToggle, permLimitInput, permLimitLabel, permLimitNote,
  } = targets;
  extraPermsTitle.textContent = C.extraPermissionsTitle;
  extraPermsHint.textContent = C.extraPermissionsHint;
  permBudgetLabel.textContent = SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget;
  permBudgetInput.checked = view.exemptFromBudget;
  permLimitLabel.textContent = SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices;
  const offerLimit = view.device.supportsLimitLowerPriority;
  setVisible(permLimitToggle, offerLimit);
  permLimitInput.checked = view.limitLowerPriorityDevices;
  permLimitInput.disabled = !view.exemptFromBudget;
  setLine(permLimitNote, offerLimit && !view.exemptFromBudget ? C.limitLowerPriorityNeedsBudget : null);
};

const renderCompose = (
  targets: RenderTargets,
  view: Extract<ViewState, { kind: 'compose' }>,
): void => {
  const { device, goal, readyById } = view;
  const { composeTitle, goalLabel, goalValueEl, goalContextEl, goalDecBtn, goalIncBtn } = targets;
  const { readyByLabel, readyByEchoEl, previewBtn } = targets;
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
  goalValueEl.textContent = formatSmartTaskGoalValue(goal, device.unitSymbol);
  // Anchor the goal against the current reading ("Goal 80% · now 42%" /
  // "from 42% → 80%") so the target isn't shown in a vacuum.
  setLine(goalContextEl, formatSmartTaskGoalContextLine({
    goalValue: goal,
    currentValue: device.currentValue,
    unitSymbol: device.unitSymbol,
  }));
  goalDecBtn.disabled = goal <= device.goalMin;
  goalIncBtn.disabled = goal >= device.goalMax;
  renderReadyByChips(targets, readyById);
  setLine(readyByEchoEl, resolveReadyByEcho(readyById));
};

// ─── Preview ─────────────────────────────────────────────────────────────────

type OkPreview = Extract<CreateSmartTaskPreviewResponse, { ok: true }>;

// "Scheduled 02:00–04:00 · Ready by Tomorrow 07:00" (or "Ready by Tomorrow
// 07:00" with no scheduled hours yet). The clock-hour window is the answer to
// "WHEN does it run" — the preview's whole reason to exist. Both the scheduled
// window and the deadline label are pre-formatted SERVER-SIDE in the Homey
// timezone (see `scheduledWindowLabel`), so this stitches strings only — no
// client-side timezone math that could drift the window into the phone's zone.
const formatWhenLine = (response: OkPreview): string => composeSmartTaskScheduledLine({
  scheduledWindowLabel: response.scheduledWindowLabel,
  deadlineLabel: response.deadlineLabel,
  scheduledLabel: C.scheduledLabel,
  readyByLabel: C.readyByLabel,
});

// Whether the in-isolation projection produced a usable plan. `unavailable`
// status or zero scheduled hours means there is nothing concrete to show.
const isProjectable = (response: OkPreview): boolean => (
  response.estimate.status !== 'unavailable' && response.estimate.scheduledHours.length > 0
);

// Energy is the demoted secondary line — kept (it answers "how much will it
// pull") but muted below the cost headline + when-window.
const formatEnergyLine = (estimate: OkPreview['estimate']): string | null => {
  if (estimate.energyEstimateKWh === null) return null;
  return `${C.energyLabel}: ${formatEnergyEstimateKWh({
    energyPlannedKWh: estimate.energyEstimateKWh,
    energyExpectedKWh: estimate.energyExpectedKWh,
  })}`;
};

// Cost is the headline ("Cost ≈ 4.20 kr"). Null when no price was available for
// the scheduled buckets — the caller then suppresses both the cost line and its
// "cheapest hours" subtext.
const formatCostLine = (estimate: OkPreview['estimate']): string | null => {
  if (estimate.costEstimate === null || !estimate.costUnit) return null;
  return formatDeadlineCostMetaLine({
    plannedTotalCost: estimate.costEstimate,
    deliveredCost: null,
    costUnit: estimate.costUnit,
  });
};

// A real planner verdict that the candidate may miss its deadline, surfaced as a
// prominent warning so the user never commits an unreachable ready-by believing
// it is fine. `cannot_meet` is the hard "won't make it"; `at_risk` is the softer
// "might not". The in-isolation estimate UNDERSTATES this risk (see the preview
// contract), so a verdict here is worth heeding. Null for the healthy verdicts.
const resolveFeasibilityWarning = (status: OkPreview['estimate']['status']): string | null => {
  if (status === 'cannot_meet') return C.cannotMeet;
  if (status === 'at_risk') return C.atRisk;
  return null;
};

// Render a successfully-projected (or zero-hour) preview. Cost leads; the
// when-window pairs with it; energy is the muted secondary line. The
// "cheapest hours before HH:MM" subtext rides under the cost only when there is
// a cost figure to explain. A `cannot_meet` / `at_risk` verdict also raises a
// feasibility warning above the figures.
const renderOkPreview = (targets: RenderTargets, response: OkPreview): void => {
  const projectable = isProjectable(response);
  const feasibilityWarning = resolveFeasibilityWarning(response.estimate.status);
  setLine(targets.previewFeasibilityEl, feasibilityWarning);
  const costLine = projectable ? formatCostLine(response.estimate) : null;
  setLine(targets.previewCostEl, costLine);
  setLine(
    targets.previewCostSubtextEl,
    costLine !== null ? formatCheapestHoursSubtext(response.deadlineLabel) : null,
  );
  // The price curve with the scheduled hours highlighted — shown only when the
  // projection is usable and the backend supplied a price series. Falls back to
  // the text lines (when/energy) when there's nothing chartable.
  const charted = projectable && response.estimate.priceSeries !== undefined
    && renderPreviewChart(targets.previewChartEl, {
      priceSeries: response.estimate.priceSeries,
      scheduledHours: response.estimate.scheduledHours,
    });
  setVisible(targets.previewChartEl, charted);
  setLine(targets.previewWhenEl, formatWhenLine(response));
  // When the chart is shown, drop the muted energy line: the chart + cost are
  // the stars and the tile's vertical budget is better spent keeping the honest
  // estimate caveat un-clipped. Energy stays as the text fallback when there's
  // no chart.
  setLine(targets.previewEnergyEl, projectable && !charted ? formatEnergyLine(response.estimate) : null);
  // The "no prices to project" line is only for a genuine `unavailable` /
  // nothing-to-show projection — NOT for a real `cannot_meet` / `at_risk` verdict
  // (which now carries its own feasibility warning above), so it never mislabels
  // a feasibility miss as a missing-price gap.
  setLine(
    targets.previewUnavailableEl,
    !projectable && feasibilityWarning === null ? C.previewUnavailable : null,
  );
  setLine(targets.previewCaveatEl, projectable ? C.estimateCaveat : null);
};

const hidePreviewLines = (targets: RenderTargets): void => {
  hide(targets.previewFeasibilityEl);
  hide(targets.previewCostEl);
  hide(targets.previewCostSubtextEl);
  hide(targets.previewChartEl);
  hide(targets.previewWhenEl);
  hide(targets.previewEnergyEl);
  hide(targets.previewCaveatEl);
};

const renderPreview = (
  targets: RenderTargets,
  view: Extract<ViewState, { kind: 'preview' }>,
): void => {
  const { response, submitting, error } = view;
  const { createBtn, previewTitle } = targets;
  previewTitle.textContent = C.previewTitle;
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
  // The user can always commit a successfully-projected candidate; an
  // unprojectable one (no price horizon) is still creatable — the deadline and
  // goal are valid — so only a hard preview failure disables create.
  createBtn.disabled = submitting;
  // PENDING shows progress copy, NOT the success label. The success label
  // ("Smart task created") only ever appears once the `created` view renders
  // after a confirmed `{ ok: true }` create — never while the request is still
  // in flight (or after it later fails).
  createBtn.textContent = submitting ? C.creating : C.createButton;
};

// ─── Top-level ─────────────────────────────────────────────────────────────

export const renderWidget = (
  targets: RenderTargets,
  payload: CreateSmartTaskDevicesPayload | null,
  view: ViewState,
): void => {
  const { root, pickerView, composeView, previewView, createdView, createdMsgEl } = targets;
  root.dataset.view = view.kind;
  setVisible(pickerView, view.kind === 'picker');
  setVisible(composeView, view.kind === 'compose');
  setVisible(previewView, view.kind === 'preview');
  setVisible(createdView, view.kind === 'created');

  if (view.kind === 'picker') {
    renderPicker(targets, payload);
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
