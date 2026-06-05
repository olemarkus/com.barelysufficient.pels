import {
  formatSmartTaskWidgetOverflow,
  SMART_TASK_WIDGET_ENDED_HEADING,
  SMART_TASK_WIDGET_LOADING,
  SMART_TASK_WIDGET_TARGET_NOUN,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import { EMPTY_SUBTITLE_DEFAULT } from '../smartTasksWidgetConstants';
import type {
  SmartTasksWidgetEmptyPayload,
  SmartTasksWidgetEndedRow,
  SmartTasksWidgetPayload,
  SmartTasksWidgetReadyPayload,
  SmartTasksWidgetRow,
} from '../smartTasksWidgetTypes';
import { renderTrajectoryChart } from './trajectoryChart';

// `section` disambiguates the two lists; `key` is the row identity WITHIN its
// section — `deviceId` for an active task (one active plan per device), the
// unique history-entry `id` for an ended task (a device can have several ended
// runs in the window, so deviceId is not unique there).
type ViewState =
  | { kind: 'list' }
  | { kind: 'detail'; section: 'active' | 'ended'; key: string };

export type RenderTargets = {
  root: HTMLElement;
  listView: HTMLElement;
  detailView: HTMLElement;
  rowsList: HTMLElement;
  emptyEl: HTMLElement;
  emptyHintEl: HTMLElement;
  overflowEl: HTMLElement;
  endedSectionEl: HTMLElement;
  endedHeadingEl: HTMLElement;
  endedRowsList: HTMLElement;
  rowTemplate: HTMLTemplateElement;
  endedRowTemplate: HTMLTemplateElement;
  detailBackBtn: HTMLButtonElement;
  detailHeaderEl: HTMLElement;
  detailChipEl: HTMLElement;
  detailDeadlineEl: HTMLElement;
  detailChartEl: HTMLElement;
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

const targetSentence = (verb: string, targetValue: number, unitSymbol: '°C' | '%'): string => (
  `${verb} ${formatValue(targetValue, unitSymbol)}`
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

const renderEndedRow = (
  template: HTMLTemplateElement,
  row: SmartTasksWidgetEndedRow,
): HTMLElement => {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const li = fragment.querySelector('.row');
  if (!(li instanceof HTMLElement)) throw new Error('ended-row template missing .row');
  li.dataset.tone = row.outcomeTone;
  const button = li.querySelector('[data-ended-button]');
  if (button instanceof HTMLElement) {
    // Key on the unique history-entry id, not deviceId — a device can have
    // multiple ended runs in the window.
    button.dataset.historyId = row.id;
    button.setAttribute('aria-label', `${row.deviceName}, ${row.outcomeLabel}, ${row.finishedLabel}`);
  }
  const nameEl = li.querySelector('[data-ended-name]');
  const valuesEl = li.querySelector('[data-ended-values]');
  const finishedEl = li.querySelector('[data-ended-finished]');
  const chipEl = li.querySelector('[data-ended-chip]');
  if (nameEl instanceof HTMLElement) nameEl.textContent = row.deviceName;
  if (valuesEl instanceof HTMLElement) {
    // "Target X" noun form (not "Heat to X") so the ended rows match the active
    // rows' target phrasing on the same screen; the journey/why lives in detail.
    valuesEl.textContent = `${SMART_TASK_WIDGET_TARGET_NOUN} ${formatValue(row.targetValue, row.unitSymbol)}`;
  }
  if (finishedEl instanceof HTMLElement) finishedEl.textContent = row.finishedLabel;
  if (chipEl instanceof HTMLElement) {
    chipEl.textContent = row.outcomeLabel;
    chipEl.dataset.tone = row.outcomeTone;
  }
  return li;
};

const clearChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

const renderEndedSection = (
  targets: RenderTargets,
  endedRows: SmartTasksWidgetEndedRow[],
): void => {
  const { endedSectionEl, endedHeadingEl, endedRowsList, endedRowTemplate } = targets;
  clearChildren(endedRowsList);
  if (endedRows.length === 0) {
    endedSectionEl.hidden = true;
    return;
  }
  endedSectionEl.hidden = false;
  endedHeadingEl.textContent = SMART_TASK_WIDGET_ENDED_HEADING;
  for (const row of endedRows) {
    endedRowsList.appendChild(renderEndedRow(endedRowTemplate, row));
  }
};

const renderListReady = (
  targets: RenderTargets,
  payload: SmartTasksWidgetReadyPayload,
): void => {
  const { rowsList, emptyEl, emptyHintEl, overflowEl, rowTemplate } = targets;
  clearChildren(rowsList);
  renderEndedSection(targets, payload.endedRows);
  if (payload.rows.length === 0) {
    rowsList.hidden = true;
    // No active rows but ended rows exist: keep the empty line off so the
    // "Recently ended" section carries the surface on its own.
    emptyEl.hidden = payload.endedRows.length > 0;
    if (!emptyEl.hidden) emptyEl.textContent = EMPTY_SUBTITLE_DEFAULT;
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
    overflowEl.textContent = formatSmartTaskWidgetOverflow(payload.overflowCount);
  } else {
    overflowEl.hidden = true;
  }
};

const renderListEmpty = (
  targets: RenderTargets,
  payload: SmartTasksWidgetEmptyPayload,
): void => {
  const { rowsList, emptyEl, emptyHintEl, overflowEl, endedSectionEl } = targets;
  clearChildren(rowsList);
  rowsList.hidden = true;
  endedSectionEl.hidden = true;
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

// Draws the trajectory chart, or hides the container when there's nothing
// chartable so the text lines carry the panel.
const renderChart = (el: HTMLElement, chart: SmartTasksWidgetRow['chart']): void => {
  const drawn = chart !== null && renderTrajectoryChart(el, chart);
  // eslint-disable-next-line no-param-reassign -- `el` is a DOM write sink.
  el.hidden = !drawn;
};

const renderActiveDetail = (targets: RenderTargets, row: SmartTasksWidgetRow): void => {
  const {
    detailHeaderEl, detailChipEl, detailDeadlineEl, detailChartEl, detailTargetEl,
    detailWhyEl, detailRecourseEl, detailMetaEl, detailConfidenceEl,
  } = targets;
  detailHeaderEl.textContent = row.deviceName;
  detailChipEl.textContent = row.statusLabel;
  detailChipEl.dataset.tone = row.tone;
  const deadlineLabel = row.deadlineLongLabel ?? row.finishLabel;
  setOptionalLine(detailDeadlineEl, deadlineLabel ? `${row.etaVerb} ${deadlineLabel}` : null);
  // Detail target line repeats the action verb so it stands on its own.
  detailTargetEl.textContent = targetSentence(row.targetActionVerb, row.targetValue, row.unitSymbol);
  detailTargetEl.hidden = false;
  renderChart(detailChartEl, row.chart);
  setOptionalLine(detailWhyEl, row.whyLabel);
  setOptionalLine(detailRecourseEl, row.recourseHint);
  setOptionalLine(detailMetaEl, row.planMetaLabel);
  setOptionalLine(detailConfidenceEl, row.confidenceLabel);
};

const renderEndedDetail = (targets: RenderTargets, row: SmartTasksWidgetEndedRow): void => {
  const {
    detailHeaderEl, detailChipEl, detailDeadlineEl, detailChartEl, detailTargetEl,
    detailWhyEl, detailRecourseEl, detailMetaEl, detailConfidenceEl,
  } = targets;
  detailHeaderEl.textContent = row.deviceName;
  detailChipEl.textContent = row.outcomeLabel;
  detailChipEl.dataset.tone = row.outcomeTone;
  setOptionalLine(detailDeadlineEl, row.finishedLabel);
  // Headline = the progress recap ("38 → 55 · target 55 °C") — the postmortem
  // story — falling back to the plain goal when start/final couldn't be resolved.
  detailTargetEl.textContent = row.progressLabel
    ?? targetSentence(row.targetActionVerb, row.targetValue, row.unitSymbol);
  detailTargetEl.hidden = false;
  renderChart(detailChartEl, row.chart);
  // Succeeded → "reached at HH:MM"; Missed → the blameless why sentence + the
  // budget/device recourse hint. Abandoned carries neither.
  setOptionalLine(detailWhyEl, row.reachedAtLabel ?? row.whyLabel);
  setOptionalLine(detailRecourseEl, row.recourseHint);
  setOptionalLine(detailMetaEl, null);
  setOptionalLine(detailConfidenceEl, null);
};

// Falls the detail view back to the list (used when the selected row dropped
// out of the latest payload). Kept here so the renderer guards itself even if
// the controller's rehydrate missed.
const fallBackToList = (targets: RenderTargets, payload: SmartTasksWidgetReadyPayload): void => {
  const { root, listView, detailView } = targets;
  renderListReady(targets, payload);
  root.dataset.view = 'list';
  listView.hidden = false;
  detailView.hidden = true;
};

const renderDetail = (
  targets: RenderTargets,
  payload: SmartTasksWidgetReadyPayload,
  view: Extract<ViewState, { kind: 'detail' }>,
): void => {
  if (view.section === 'ended') {
    const endedRow = payload.endedRows.find((candidate) => candidate.id === view.key);
    if (!endedRow) {
      fallBackToList(targets, payload);
      return;
    }
    renderEndedDetail(targets, endedRow);
    return;
  }
  const row = payload.rows.find((candidate) => candidate.deviceId === view.key);
  if (!row) {
    fallBackToList(targets, payload);
    return;
  }
  renderActiveDetail(targets, row);
};

// First-paint loading state, shown until the first API response lands so a slow
// app start reads as "loading" rather than the blank "no tasks" empty state.
export const renderLoading = (targets: RenderTargets): void => {
  const {
    root, listView, detailView, rowsList, emptyEl, emptyHintEl, overflowEl, endedSectionEl,
  } = targets;
  root.dataset.state = 'empty';
  root.dataset.view = 'list';
  listView.hidden = false;
  detailView.hidden = true;
  clearChildren(rowsList);
  rowsList.hidden = true;
  endedSectionEl.hidden = true;
  emptyHintEl.hidden = true;
  overflowEl.hidden = true;
  emptyEl.hidden = false;
  emptyEl.textContent = SMART_TASK_WIDGET_LOADING;
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
    renderDetail(targets, payload, view);
    return;
  }
  const hasContent = payload.rows.length > 0 || payload.endedRows.length > 0;
  root.dataset.state = hasContent ? 'ready' : 'empty';
  root.dataset.view = 'list';
  listView.hidden = false;
  detailView.hidden = true;
  renderListReady(targets, payload);
};
