import {
  STARVATION_RESCUE_WIDGET_COPY,
  formatStarvationOverflowCue,
  formatStarvationRowChip,
  resolveStarvationRowNote,
  resolveStarvationRowSubtext,
  resolveStarvationRowTone,
  starvationRowIsRescuable,
} from '../../../../packages/shared-domain/src/planStarvation';
import {
  formatEnergyEstimateKWh,
  formatDeadlineCostMetaLine,
  resolveSmartTaskPreviewStatusCopy,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import {
  composeSmartTaskScheduledLine,
} from '../../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import type {
  StarvationRescueDevice,
  StarvationRescueDevicesPayload,
  StarvationRescuePreviewResponse,
} from '../starvationRescueWidgetTypes';

const C = STARVATION_RESCUE_WIDGET_COPY;

// Two interactive states plus a success flash. `list` shows the starved devices;
// `confirm` shows the budget-exempt rescue preview for one budget-caused device
// before commit; `done` is the brief success flash before the controller resets.
export type ViewState =
  | { kind: 'list' }
  | {
    kind: 'confirm';
    device: StarvationRescueDevice;
    response: StarvationRescuePreviewResponse | null;
    submitting: boolean;
    error: string | null;
  }
  // `ranNow` = the projected plan actually runs the device now (vs queued behind
  // the hard cap); branches the success flash so it never over-promises.
  | { kind: 'done'; ranNow: boolean };

export type RenderTargets = {
  root: HTMLElement;
  // List
  listView: HTMLElement;
  listTitleEl: HTMLElement;
  listEl: HTMLElement;
  listMoreEl: HTMLElement;
  listEmptyEl: HTMLElement;
  deviceTemplate: HTMLTemplateElement;
  // Confirm
  confirmView: HTMLElement;
  confirmBackBtn: HTMLButtonElement;
  confirmTitle: HTMLElement;
  confirmConsequenceEl: HTMLElement;
  confirmCostEl: HTMLElement;
  confirmWhenEl: HTMLElement;
  confirmEnergyEl: HTMLElement;
  confirmUnavailableEl: HTMLElement;
  confirmCaveatEl: HTMLElement;
  confirmErrorEl: HTMLElement;
  confirmBtn: HTMLButtonElement;
  // Done flash
  doneView: HTMLElement;
  doneMsgEl: HTMLElement;
};

const clearChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

/* eslint-disable no-param-reassign --
   The DOM-write helpers below take an element as a write sink; mutating its
   text/visibility is the helper's whole job (mirrors create_smart_task/render.ts). */

const setLine = (el: HTMLElement, text: string | null): void => {
  const visible = Boolean(text && text.trim());
  el.textContent = visible ? text : '';
  el.hidden = !visible;
};

// Two display lines are "the same" if they match after lowercasing, trimming,
// and dropping a single trailing period — used to suppress a note that merely
// restates the subtext.
const normalizeLine = (text: string): string => text.trim().replace(/\.$/, '').toLowerCase();
const linesMatch = (a: string, b: string): boolean => normalizeLine(a) === normalizeLine(b);

const hide = (el: HTMLElement): void => { el.hidden = true; };

const setVisible = (el: HTMLElement, visible: boolean): void => { el.hidden = !visible; };

/* eslint-enable no-param-reassign */

// ─── List ────────────────────────────────────────────────────────────────────

const renderDeviceRow = (
  template: HTMLTemplateElement,
  device: StarvationRescueDevice,
): HTMLElement => {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const li = fragment.querySelector('.row');
  if (!(li instanceof HTMLElement)) throw new Error('device template missing .row');

  // Offer the rescue ONLY when the row is actually rescuable: budget-caused, a
  // known target to aim at, AND the device has no smart task of its own (a
  // task-having device is shown but not rescuable — its task brings it back).
  // Mirrors the API guardrail (`resolveRescuableDevice`), so the button is never
  // shown for a request the API would then reject.
  const offersRescue = starvationRowIsRescuable(
    device.cause, device.intendedNormalTargetC, device.hasSmartTask,
  );
  // Tone escalates with duration (warn → danger); both render as a coloured
  // chip. Stamped on the row so CSS can tint the chip/border.
  li.dataset.tone = resolveStarvationRowTone(device.accumulatedMs);

  const nameEl = li.querySelector('[data-device-name]');
  const chipEl = li.querySelector('[data-device-chip]');
  const subtextEl = li.querySelector('[data-device-subtext]');
  const noteEl = li.querySelector('[data-device-note]');
  const rescueBtn = li.querySelector('[data-rescue-button]');

  const subtext = resolveStarvationRowSubtext(device.cause, device.intendedNormalTargetC);

  if (nameEl instanceof HTMLElement) nameEl.textContent = device.deviceName;
  if (chipEl instanceof HTMLElement) chipEl.textContent = formatStarvationRowChip(device.cause, device.accumulatedMs);
  if (subtextEl instanceof HTMLElement) {
    subtextEl.textContent = subtext;
  }

  // Budget rows: a rescue button (the only interactive affordance). Other
  // causes: a muted informational note, no button (the guardrail — capacity is
  // physical, manual/external are outside PELS's control).
  if (rescueBtn instanceof HTMLButtonElement) {
    if (offersRescue) {
      rescueBtn.hidden = false;
      rescueBtn.dataset.deviceId = device.deviceId;
      rescueBtn.textContent = C.rescueButton;
      rescueBtn.setAttribute('aria-label', `${C.rescueButton}: ${device.deviceName}`);
    } else {
      rescueBtn.hidden = true;
    }
  }
  if (noteEl instanceof HTMLElement) {
    // The note is suppressed for rescuable (budget) rows, and otherwise only
    // shown when it adds information beyond the subtext. For capacity/manual/
    // external rows the note and subtext are near-identical (e.g. "Waiting for
    // available power" vs "Waiting for available power.") — printing both reads
    // as a doubled line, so drop the note when it duplicates the subtext
    // (compared case-insensitively, ignoring a trailing period).
    const note = offersRescue ? null : resolveStarvationRowNote(device.cause, device.hasSmartTask);
    setLine(noteEl, note !== null && !linesMatch(note, subtext) ? note : null);
  }
  return li;
};

const renderList = (targets: RenderTargets, payload: StarvationRescueDevicesPayload | null): void => {
  const { listTitleEl, listEl, listEmptyEl, listMoreEl, deviceTemplate } = targets;
  clearChildren(listEl);
  if (!payload || payload.state === 'empty') {
    // The header names what the widget shows; with nothing held back the calm
    // empty subtitle stands alone, so the header is hidden in that state.
    listTitleEl.hidden = true;
    listEl.hidden = true;
    listMoreEl.hidden = true;
    listEmptyEl.hidden = false;
    // The calm steady state subtitle, or the transient connecting/load copy the
    // controller supplied as the empty subtitle.
    listEmptyEl.textContent = payload?.state === 'empty' ? payload.subtitle : C.loadError;
    return;
  }
  listTitleEl.textContent = C.headerTitle;
  listTitleEl.hidden = false;
  listEl.hidden = false;
  listEmptyEl.hidden = true;
  for (const device of payload.devices) {
    listEl.appendChild(renderDeviceRow(deviceTemplate, device));
  }
  // "+N more" cue when rows sit below the fixed-height fold, so a just-notified
  // device that scrolled out of view still has a visible count affordance.
  setLine(listMoreEl, formatStarvationOverflowCue(payload.devices.length));
};

// ─── Confirm ─────────────────────────────────────────────────────────────────

type OkPreview = Extract<StarvationRescuePreviewResponse, { ok: true }>;

export const isProjectable = (response: OkPreview): boolean => (
  response.estimate.status !== 'unavailable' && response.estimate.scheduledHours.length > 0
);

const canConfirmPreview = (response: StarvationRescuePreviewResponse | null): boolean => (
  response?.ok === true
  && response.estimate.status !== 'unavailable'
  && response.estimate.status !== 'cannot_meet'
);

const formatWhenLine = (response: OkPreview): string => composeSmartTaskScheduledLine({
  scheduledWindowLabel: response.scheduledWindowLabel,
  deadlineLabel: response.deadlineLabel,
  scheduledLabel: C.scheduledLabel,
  readyByLabel: C.byLabel,
});

const formatEnergyLine = (estimate: OkPreview['estimate']): string | null => {
  if (estimate.energyEstimateKWh === null) return null;
  return `${C.energyLabel}: ${formatEnergyEstimateKWh({
    energyPlannedKWh: estimate.energyEstimateKWh,
    energyExpectedKWh: estimate.energyExpectedKWh,
  })}`;
};

const formatCostLine = (estimate: OkPreview['estimate']): string | null => {
  if (estimate.costEstimate === null || !estimate.costUnit) return null;
  return formatDeadlineCostMetaLine({
    plannedTotalCost: estimate.costEstimate,
    deliveredCost: null,
    costUnit: estimate.costUnit,
  });
};

const renderOkPreview = (targets: RenderTargets, response: OkPreview): void => {
  const projectable = isProjectable(response);
  const estimated = response.estimate.status !== 'unavailable';
  setLine(targets.confirmCostEl, projectable ? formatCostLine(response.estimate) : null);
  setLine(targets.confirmWhenEl, formatWhenLine(response));
  setLine(targets.confirmEnergyEl, estimated ? formatEnergyLine(response.estimate) : null);
  setLine(
    targets.confirmUnavailableEl,
    resolveSmartTaskPreviewStatusCopy(response.estimate.status, response.estimate.unavailableReason),
  );
  setLine(targets.confirmCaveatEl, estimated && response.estimate.status !== 'satisfied' ? C.estimateCaveat : null);
};

const hideConfirmLines = (targets: RenderTargets): void => {
  hide(targets.confirmCostEl);
  hide(targets.confirmWhenEl);
  hide(targets.confirmEnergyEl);
  hide(targets.confirmCaveatEl);
};

const renderConfirm = (
  targets: RenderTargets,
  view: Extract<ViewState, { kind: 'confirm' }>,
): void => {
  const { device, response, submitting, error } = view;
  const { confirmBtn, confirmTitle, confirmConsequenceEl } = targets;
  confirmTitle.textContent = device.deviceName;
  // The honest consequence sits above the figures (money-action guardrail): the
  // rescue lets the device exceed today's budget to reach its normal target.
  confirmConsequenceEl.textContent = C.rescueConsequence;

  if (response === null) {
    // Preview still loading — show the consequence + a pending button only.
    hideConfirmLines(targets);
    hide(targets.confirmUnavailableEl);
    setLine(targets.confirmErrorEl, error);
    confirmBtn.disabled = true;
    confirmBtn.textContent = C.rescuePending;
    return;
  }
  if (!response.ok) {
    hideConfirmLines(targets);
    setLine(targets.confirmUnavailableEl, C.previewUnavailable);
    setLine(targets.confirmErrorEl, error);
    confirmBtn.disabled = true;
    confirmBtn.textContent = C.rescueConfirmButton;
    return;
  }
  renderOkPreview(targets, response);
  setLine(targets.confirmErrorEl, error);
  confirmBtn.disabled = submitting || !canConfirmPreview(response);
  confirmBtn.textContent = submitting ? C.rescuePending : C.rescueConfirmButton;
};

// ─── Top-level ─────────────────────────────────────────────────────────────

export const renderWidget = (
  targets: RenderTargets,
  payload: StarvationRescueDevicesPayload | null,
  view: ViewState,
): void => {
  const { root, listView, confirmView, doneView, doneMsgEl, confirmBackBtn } = targets;
  root.dataset.view = view.kind;
  setVisible(listView, view.kind === 'list');
  setVisible(confirmView, view.kind === 'confirm');
  setVisible(doneView, view.kind === 'done');
  // The back button shows a chevron + the device name visibly (Material back
  // pattern); its accessible label comes from copy. textContent would wipe the
  // chevron/name children, so set the aria-label instead.
  confirmBackBtn.setAttribute('aria-label', C.backButton);

  if (view.kind === 'list') {
    renderList(targets, payload);
    return;
  }
  if (view.kind === 'confirm') {
    renderConfirm(targets, view);
    return;
  }
  doneMsgEl.textContent = view.ranNow ? C.rescueDone : C.rescueDoneQueued;
};
