import {
  STARVATION_RESCUE_WIDGET_COPY,
  formatStarvationAlsoLimited,
  formatStarvationNotListedReason,
  formatStarvationOverflowCue,
  formatStarvationRowChip,
  resolveStarvationRowNote,
  resolveStarvationRowSubtext,
  resolveStarvationRowTone,
  starvationRowIsRescuable,
} from '../../../../packages/shared-domain/src/planStarvation';
import {
  resolveGrantedRescuePermissionLabels,
  resolveSmartTaskPreviewStatusCopy,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import {
  composeSmartTaskScheduledLine,
} from '../../../../packages/shared-domain/src/smartTaskDeadlineFormat';
// DRY: reuse the create-task widget's self-contained price-curve chart. Sibling
// widget imports are an explicitly allowed dependency edge (.dependency-cruiser
// `no-widget-to-runtime-except-node-entries`), the module is browser-safe and
// payload-agnostic (it takes price series + scheduled hours), and esbuild bundles
// it into this widget's `public/index.js` — so the confirm sheet renders the
// identical chart with no duplicated render logic.
import { renderPreviewChart } from '../../../_shared/smartTaskCreate/previewChart';
import { clearChildren, hide, setLine, setVisible } from '../../../_shared/widgetDom';
import { formatPreviewCostLine, formatPreviewEnergyLine } from '../../../_shared/smartTaskPreviewLines';
import type {
  StarvationNotListedDevice,
  StarvationRescueDevice,
  StarvationRescueListState,
  StarvationRescuePreviewResponse,
} from '../starvationRescueWidgetTypes';

const C = STARVATION_RESCUE_WIDGET_COPY;

// Two interactive states plus a success flash. `list` shows the starved devices;
// `confirm` shows the bounded rescue preview for one held-back device
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
  listAlsoEl: HTMLElement;
  listEmptyEl: HTMLElement;
  listScopeEl: HTMLElement;
  notListedEl: HTMLElement;
  notListedTitleEl: HTMLElement;
  notListedListEl: HTMLElement;
  notListedMoreEl: HTMLElement;
  deviceTemplate: HTMLTemplateElement;
  // Confirm
  confirmView: HTMLElement;
  confirmBackBtn: HTMLButtonElement;
  confirmTitle: HTMLElement;
  confirmConsequenceEl: HTMLElement;
  confirmCostEl: HTMLElement;
  confirmAtCapEl: HTMLElement;
  confirmChartEl: HTMLElement;
  confirmWhenEl: HTMLElement;
  confirmEnergyEl: HTMLElement;
  confirmUnavailableEl: HTMLElement;
  confirmCaveatEl: HTMLElement;
  confirmPermsEl: HTMLElement;
  confirmPermsTitleEl: HTMLElement;
  confirmPermsListEl: HTMLElement;
  confirmErrorEl: HTMLElement;
  confirmBtn: HTMLButtonElement;
  // Done flash
  doneView: HTMLElement;
  doneMsgEl: HTMLElement;
};

/* eslint-disable no-param-reassign --
   `button` is a write sink: setting its visibility, device id and label is the
   helper's whole job. */
const configureRescueButton = (
  button: HTMLButtonElement,
  device: StarvationRescueDevice,
  offersRescue: boolean,
): void => {
  button.hidden = !offersRescue;
  if (!offersRescue) return;
  button.dataset.deviceId = device.deviceId;
  button.textContent = C.rescueButton;
  button.setAttribute('aria-label', `${C.rescueButton}: ${device.deviceName}`);
};
/* eslint-enable no-param-reassign */

const resolveDeviceRowNote = (
  device: StarvationRescueDevice,
): string | null => {
  if (device.smartTaskHomeScope === 'unavailable') return C.temporaryUnavailableNote;
  return resolveStarvationRowNote(device.hasSmartTask, device.intendedTarget);
};

// ─── List ────────────────────────────────────────────────────────────────────

const renderDeviceRow = (
  template: HTMLTemplateElement,
  device: StarvationRescueDevice,
): HTMLElement => {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const li = fragment.querySelector('.row');
  if (!(li instanceof HTMLElement)) throw new Error('device template missing .row');

  // Offer the rescue ONLY when the row is actually rescuable: a known target to
  // aim at, AND the device has no smart task of its own (a task-having device is
  // shown but not rescuable — its task brings it back).
  // Mirrors the API guardrail (`resolveRescuableDevice`), so the button is never
  // shown for a request the API would then reject.
  const offersRescue = starvationRowIsRescuable(
    device.intendedTarget,
    device.hasSmartTask,
    device.smartTaskHomeScope,
  );
  // Tone escalates with duration (warn → danger); both render as a coloured
  // chip. Stamped on the row so CSS can tint the chip/border.
  li.dataset.tone = resolveStarvationRowTone(device.accumulatedMs);

  const nameEl = li.querySelector('[data-device-name]');
  const chipEl = li.querySelector('[data-device-chip]');
  const subtextEl = li.querySelector('[data-device-subtext]');
  const noteEl = li.querySelector('[data-device-note]');
  const rescueBtn = li.querySelector('[data-rescue-button]');

  const subtext = resolveStarvationRowSubtext(device.intendedTarget);

  if (nameEl instanceof HTMLElement) nameEl.textContent = device.deviceName;
  if (chipEl instanceof HTMLElement) chipEl.textContent = formatStarvationRowChip(device.accumulatedMs);
  if (subtextEl instanceof HTMLElement) {
    subtextEl.textContent = subtext;
  }

  // Rescuable rows: a rescue button (the only interactive affordance). The rest:
  // a muted informational note, no button.
  if (rescueBtn instanceof HTMLButtonElement) {
    configureRescueButton(rescueBtn, device, offersRescue);
  }
  if (noteEl instanceof HTMLElement) {
    // Every row carries a second line: the smart-task explanation for the one
    // row without a button, and otherwise the canonical "why" — this widget is a
    // standalone dashboard surface with no hero to state it once. The resolver
    // suppresses it when the subtext already says the same thing.
    setLine(noteEl, resolveDeviceRowNote(device));
  }
  return li;
};

const renderNotListedRow = (doc: Document, device: StarvationNotListedDevice): HTMLElement => {
  const li = doc.createElement('li');
  li.className = 'not-listed__row';
  const name = doc.createElement('span');
  name.className = 'not-listed__name';
  name.textContent = device.deviceName;
  const reason = doc.createElement('span');
  reason.className = 'not-listed__reason';
  reason.textContent = formatStarvationNotListedReason(device.reason);
  li.append(name, reason);
  return li;
};

// The calm empty state: the header, the lead, and either the limited devices the
// list leaves out (each with why) or, when PELS limits nothing, which devices
// the list covers.
const renderNotListed = (targets: RenderTargets, notListed: readonly StarvationNotListedDevice[]): void => {
  const { notListedEl, notListedTitleEl, notListedListEl, notListedMoreEl, listScopeEl } = targets;
  clearChildren(notListedListEl);
  if (notListed.length === 0) {
    setLine(listScopeEl, C.emptyScopeNote);
    return;
  }
  notListedEl.hidden = false;
  notListedTitleEl.textContent = C.notListedTitle;
  for (const device of notListed) {
    notListedListEl.appendChild(renderNotListedRow(notListedListEl.ownerDocument, device));
  }
  setLine(notListedMoreEl, formatStarvationOverflowCue(notListed.length));
};

const hideListParts = (targets: RenderTargets): void => {
  hide(targets.listEl);
  hide(targets.listEmptyEl);
  hide(targets.listMoreEl);
  hide(targets.listAlsoEl);
  hide(targets.listScopeEl);
  hide(targets.notListedEl);
};

const renderList = (targets: RenderTargets, listState: StarvationRescueListState | null): void => {
  const { listTitleEl, listEl, listEmptyEl, listMoreEl, listAlsoEl, deviceTemplate } = targets;
  clearChildren(listEl);
  hideListParts(targets);
  listTitleEl.textContent = C.headerTitle;
  if (!listState || listState.state === 'unavailable') {
    // Connecting or a failed load: the transient message stands alone, centred.
    listTitleEl.hidden = true;
    listEmptyEl.dataset.calm = 'false';
    setLine(listEmptyEl, listState?.message ?? C.loadError);
    return;
  }
  // The header names what the widget shows, so the card always says which
  // widget it is — in the calm state too.
  listTitleEl.hidden = false;
  if (listState.state === 'empty') {
    listEmptyEl.dataset.calm = 'true';
    setLine(listEmptyEl, listState.subtitle);
    renderNotListed(targets, listState.notListed);
    return;
  }
  listEl.hidden = false;
  for (const device of listState.devices) {
    listEl.appendChild(renderDeviceRow(deviceTemplate, device));
  }
  // "+N more" cue when rows sit below the fixed-height fold, so a just-notified
  // device that scrolled out of view still has a visible count affordance.
  setLine(listMoreEl, formatStarvationOverflowCue(listState.devices.length));
  setLine(listAlsoEl, formatStarvationAlsoLimited(listState.notListed));
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

// Read-only "Extra permissions" summary: the standing permissions the rescue
// grants, shown so the user sees exactly what confirming will allow. The rescue
// requests all three, but the backend GATES `limitLowerPriorityDevices`
// (`AppSmartTaskApi.gateCandidateExtraPermissions`): it is dropped when it would be
// inert — a binary device (no higher step to promote to), or no budget exemption
// to pair with. So the summary is derived from the already-gated
// `estimate.grantedRescuePermissions` (only the SURVIVING permissions), never a
// fixed all-listed assumption, or it would claim a grant the rescue won't make.
// The label list is single-homed in shared-domain so this sheet and the
// settings-UI overview card can't drift.

const renderExtraPermissionsSummary = (targets: RenderTargets, labels: string[]): void => {
  setLine(targets.confirmPermsTitleEl, C.extraPermissionsTitle);
  clearChildren(targets.confirmPermsListEl);
  const doc = targets.confirmPermsListEl.ownerDocument;
  for (const label of labels) {
    const item = doc.createElement('li');
    item.className = 'extra-perms-summary__item';
    item.textContent = label;
    targets.confirmPermsListEl.appendChild(item);
  }
  setVisible(targets.confirmPermsEl, true);
};

const renderOkPreview = (targets: RenderTargets, response: OkPreview): void => {
  const projectable = isProjectable(response);
  const estimated = response.estimate.status !== 'unavailable';
  setLine(targets.confirmCostEl, projectable ? formatPreviewCostLine(response.estimate) : null);
  // Factual at-limit honesty signal: the coordinated preview can show the device
  // running now, but the backend names the enabled limit (`atPowerLimitNow`) when
  // the measured whole-home draw is already pressed against it, so power may have
  // to wait for room. Names the measured fact and that limit, never a prompt to
  // raise the (physical) limit.
  const { atPowerLimitNow } = response.estimate;
  setLine(
    targets.confirmAtCapEl,
    projectable && atPowerLimitNow !== undefined ? C.atPowerLimitNote[atPowerLimitNow] : null,
  );
  // The price curve with the scheduled hours highlighted — the SAME chart the
  // create widget renders. Shown only when projectable and a price series is
  // present; falls back to the text lines otherwise.
  const charted = projectable && response.estimate.priceSeries !== undefined
    && renderPreviewChart(targets.confirmChartEl, {
      priceSeries: response.estimate.priceSeries,
      scheduledHours: response.estimate.scheduledHours,
    });
  setVisible(targets.confirmChartEl, charted);
  setLine(targets.confirmWhenEl, formatWhenLine(response));
  setLine(targets.confirmEnergyEl, estimated ? formatPreviewEnergyLine(response.estimate, C.energyLabel) : null);
  setLine(
    targets.confirmUnavailableEl,
    resolveSmartTaskPreviewStatusCopy(
      response.estimate.status,
      response.estimate.unavailableReason,
      response.estimate.budgetRole,
    ),
  );
  setLine(targets.confirmCaveatEl, estimated && response.estimate.status !== 'satisfied' ? C.estimateCaveat : null);
  // Show the summary only when projectable (confirm is a live option) AND the
  // backend reported surviving granted permissions; derive the listed labels
  // from the gated set so it never claims a permission the rescue won't grant.
  const granted = response.estimate.grantedRescuePermissions;
  const permissionLabels = projectable ? resolveGrantedRescuePermissionLabels(granted) : [];
  if (permissionLabels.length > 0) renderExtraPermissionsSummary(targets, permissionLabels);
  else hide(targets.confirmPermsEl);
};

const hideConfirmLines = (targets: RenderTargets): void => {
  hide(targets.confirmCostEl);
  hide(targets.confirmAtCapEl);
  hide(targets.confirmChartEl);
  hide(targets.confirmWhenEl);
  hide(targets.confirmEnergyEl);
  hide(targets.confirmCaveatEl);
  hide(targets.confirmPermsEl);
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
  listState: StarvationRescueListState | null,
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
    renderList(targets, listState);
    return;
  }
  if (view.kind === 'confirm') {
    renderConfirm(targets, view);
    return;
  }
  doneMsgEl.textContent = view.ranNow ? C.rescueDone : C.rescueDoneQueued;
};
