import { EMPTY_SUBTITLE_DEFAULT } from '../smartTasksWidgetPayload';
import type {
  SmartTasksWidgetEmptyPayload,
  SmartTasksWidgetPayload,
  SmartTasksWidgetReadyPayload,
  SmartTasksWidgetRow,
} from '../smartTasksWidgetTypes';

type ViewState =
  | { kind: 'list' }
  | { kind: 'detail'; deviceId: string };

export type RenderTargets = {
  root: HTMLElement;
  listView: HTMLElement;
  detailView: HTMLElement;
  rowsList: HTMLElement;
  emptyEl: HTMLElement;
  emptyHintEl: HTMLElement;
  overflowEl: HTMLElement;
  rowTemplate: HTMLTemplateElement;
  detailBackBtn: HTMLButtonElement;
  detailHeaderEl: HTMLElement;
  detailChipEl: HTMLElement;
  detailDeadlineEl: HTMLElement;
  detailTargetEl: HTMLElement;
  detailWhyEl: HTMLElement;
  detailRecourseEl: HTMLElement;
  detailMetaEl: HTMLElement;
  detailConfidenceEl: HTMLElement;
};

const formatValue = (value: number, unitSymbol: '°C' | '%'): string => {
  const rounded = Math.round(value * 10) / 10;
  const text = rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
  return `${text} ${unitSymbol}`;
};

// Words (`targetNoun`, `etaVerb`, `targetActionVerb`) are producer-resolved in
// the payload from shared-domain; the renderer only formats numbers and joins.
const formatValuesLine = (row: SmartTasksWidgetRow): string => {
  const target = formatValue(row.targetValue, row.unitSymbol);
  // Show "Target X" when there's no current reading — a "— → 55 °C" row reads
  // as broken rather than intentional.
  if (row.currentValue === null || !Number.isFinite(row.currentValue)) {
    return `${row.targetNoun} ${target}`;
  }
  return `${formatValue(row.currentValue, row.unitSymbol)} → ${target}`;
};

const formatRowEta = (row: SmartTasksWidgetRow): string => {
  if (row.finishLabel === null) return '';
  return `${row.etaVerb} ${row.finishLabel}`;
};

const targetSentence = (row: SmartTasksWidgetRow): string => (
  `${row.targetActionVerb} ${formatValue(row.targetValue, row.unitSymbol)}`
);

const renderRow = (template: HTMLTemplateElement, row: SmartTasksWidgetRow): HTMLElement => {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const li = fragment.querySelector('.row');
  if (!(li instanceof HTMLElement)) throw new Error('row template missing .row');
  li.dataset.tone = row.tone;
  const button = li.querySelector('[data-row-button]');
  if (button instanceof HTMLElement) {
    button.dataset.deviceId = row.deviceId;
    button.setAttribute(
      'aria-label',
      `${row.deviceName}, ${row.statusLabel}${row.finishLabel ? `, ${formatRowEta(row)}` : ''}`,
    );
  }
  const nameEl = li.querySelector('[data-row-name]');
  const valuesEl = li.querySelector('[data-row-values]');
  const etaEl = li.querySelector('[data-row-eta]');
  const chipEl = li.querySelector('[data-row-chip]');
  if (nameEl instanceof HTMLElement) nameEl.textContent = row.deviceName;
  if (valuesEl instanceof HTMLElement) {
    valuesEl.textContent = formatValuesLine(row);
  }
  if (etaEl instanceof HTMLElement) {
    etaEl.textContent = formatRowEta(row);
  }
  if (chipEl instanceof HTMLElement) {
    chipEl.textContent = row.statusLabel;
    chipEl.dataset.tone = row.tone;
  }
  return li;
};

const clearChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

const renderListReady = (
  targets: RenderTargets,
  payload: SmartTasksWidgetReadyPayload,
): void => {
  const { rowsList, emptyEl, emptyHintEl, overflowEl, rowTemplate } = targets;
  clearChildren(rowsList);
  if (payload.rows.length === 0) {
    rowsList.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = EMPTY_SUBTITLE_DEFAULT;
    emptyHintEl.hidden = true;
    overflowEl.hidden = true;
    return;
  }
  rowsList.hidden = false;
  emptyEl.hidden = true;
  emptyHintEl.hidden = true;
  for (const row of payload.rows) {
    rowsList.appendChild(renderRow(rowTemplate, row));
  }
  if (payload.overflowCount > 0) {
    overflowEl.hidden = false;
    overflowEl.textContent = `+${payload.overflowCount} in Smart tasks`;
  } else {
    overflowEl.hidden = true;
  }
};

const renderListEmpty = (
  targets: RenderTargets,
  payload: SmartTasksWidgetEmptyPayload,
): void => {
  const { rowsList, emptyEl, emptyHintEl, overflowEl } = targets;
  clearChildren(rowsList);
  rowsList.hidden = true;
  emptyEl.hidden = false;
  emptyEl.textContent = payload.subtitle;
  if (payload.hint) {
    emptyHintEl.hidden = false;
    emptyHintEl.textContent = payload.hint;
  } else {
    emptyHintEl.hidden = true;
  }
  overflowEl.hidden = true;
};

// DOM setter for the optional detail lines: writes text + visibility, or
// blanks + hides when the producer left the field null. The element is a
// write sink, so the property mutation on the parameter is intentional.
const setOptionalLine = (el: HTMLElement, text: string | null): void => {
  const visible = Boolean(text && text.trim());
  /* eslint-disable no-param-reassign --
     `el` is a DOM write sink; mutating its text/visibility is the helper's job. */
  el.textContent = visible ? text : '';
  el.hidden = !visible;
  /* eslint-enable no-param-reassign */
};

const renderDetail = (
  targets: RenderTargets,
  payload: SmartTasksWidgetReadyPayload,
  deviceId: string,
): void => {
  const row = payload.rows.find((candidate) => candidate.deviceId === deviceId);
  if (!row) {
    // Controller should have rehydrated to list, but guard the renderer too.
    const { root, listView, detailView } = targets;
    renderListReady(targets, payload);
    root.dataset.view = 'list';
    listView.hidden = false;
    detailView.hidden = true;
    return;
  }
  const {
    detailHeaderEl,
    detailChipEl,
    detailDeadlineEl,
    detailTargetEl,
    detailWhyEl,
    detailRecourseEl,
    detailMetaEl,
    detailConfidenceEl,
  } = targets;
  detailHeaderEl.textContent = row.deviceName;
  detailChipEl.textContent = row.statusLabel;
  detailChipEl.dataset.tone = row.tone;
  const deadlineLabel = row.deadlineLongLabel ?? row.finishLabel;
  setOptionalLine(detailDeadlineEl, deadlineLabel ? `${row.etaVerb} ${deadlineLabel}` : null);
  // Detail target line repeats the action verb so it stands on its own.
  detailTargetEl.textContent = targetSentence(row);
  detailTargetEl.hidden = false;
  setOptionalLine(detailWhyEl, row.whyLabel);
  setOptionalLine(detailRecourseEl, row.recourseHint);
  setOptionalLine(detailMetaEl, row.planMetaLabel);
  setOptionalLine(detailConfidenceEl, row.confidenceLabel);
};

export const renderWidget = (
  targets: RenderTargets,
  payload: SmartTasksWidgetPayload | null,
  view: ViewState,
): void => {
  const { root, listView, detailView } = targets;
  if (!payload || payload.state !== 'ready') {
    const emptyPayload: SmartTasksWidgetEmptyPayload = payload?.state === 'empty'
      ? payload
      : { state: 'empty', subtitle: EMPTY_SUBTITLE_DEFAULT, hint: null };
    root.dataset.state = 'empty';
    root.dataset.view = 'list';
    listView.hidden = false;
    detailView.hidden = true;
    renderListEmpty(targets, emptyPayload);
    return;
  }
  if (view.kind === 'detail') {
    root.dataset.state = 'ready';
    root.dataset.view = 'detail';
    listView.hidden = true;
    detailView.hidden = false;
    renderDetail(targets, payload, view.deviceId);
    return;
  }
  root.dataset.state = payload.rows.length === 0 ? 'empty' : 'ready';
  root.dataset.view = 'list';
  listView.hidden = false;
  detailView.hidden = true;
  renderListReady(targets, payload);
};
