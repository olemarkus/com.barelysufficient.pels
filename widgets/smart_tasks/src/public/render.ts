import { EMPTY_SUBTITLE_DEFAULT } from '../smartTasksWidgetPayload';
import type { SmartTasksWidgetPayload, SmartTasksWidgetRow } from '../smartTasksWidgetTypes';

const formatValue = (value: number, unitSymbol: '°C' | '%'): string => {
  const rounded = Math.round(value * 10) / 10;
  const text = rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
  return `${text} ${unitSymbol}`;
};

const formatValuesLine = (
  currentValue: number | null,
  targetValue: number,
  unitSymbol: '°C' | '%',
): string => {
  const target = formatValue(targetValue, unitSymbol);
  // When the device snapshot doesn't carry a current reading, render only the
  // target. Showing "— → 55 °C" reads as a broken row; "Target 55 °C" reads
  // as an intentional state, and the status chip carries the "why".
  if (currentValue === null || !Number.isFinite(currentValue)) {
    return `Target ${target}`;
  }
  return `${formatValue(currentValue, unitSymbol)} → ${target}`;
};

export type RenderTargets = {
  root: HTMLElement;
  rowsList: HTMLElement;
  emptyEl: HTMLElement;
  overflowEl: HTMLElement;
  rowTemplate: HTMLTemplateElement;
};

const renderRow = (template: HTMLTemplateElement, row: SmartTasksWidgetRow): HTMLElement => {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const li = fragment.querySelector('.row');
  if (!(li instanceof HTMLElement)) throw new Error('row template missing .row');
  li.dataset.tone = row.tone;
  const nameEl = li.querySelector('[data-row-name]');
  const valuesEl = li.querySelector('[data-row-values]');
  const etaEl = li.querySelector('[data-row-eta]');
  const chipEl = li.querySelector('[data-row-chip]');
  if (nameEl instanceof HTMLElement) nameEl.textContent = row.deviceName;
  if (valuesEl instanceof HTMLElement) {
    valuesEl.textContent = formatValuesLine(row.currentValue, row.targetValue, row.unitSymbol);
  }
  if (etaEl instanceof HTMLElement) {
    etaEl.textContent = row.finishLabel !== null ? `Ready by ${row.finishLabel}` : '';
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

const renderReady = (targets: RenderTargets, payload: { rows: SmartTasksWidgetRow[]; overflowCount: number }): void => {
  const { rowsList, emptyEl, overflowEl, rowTemplate } = targets;
  clearChildren(rowsList);
  if (payload.rows.length === 0) {
    rowsList.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = EMPTY_SUBTITLE_DEFAULT;
    overflowEl.hidden = true;
    return;
  }
  rowsList.hidden = false;
  emptyEl.hidden = true;
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

const renderEmpty = (targets: RenderTargets, subtitle: string): void => {
  const { rowsList, emptyEl, overflowEl } = targets;
  clearChildren(rowsList);
  rowsList.hidden = true;
  emptyEl.hidden = false;
  emptyEl.textContent = subtitle;
  overflowEl.hidden = true;
};

export const renderWidget = (targets: RenderTargets, payload: SmartTasksWidgetPayload | null): void => {
  const { root } = targets;
  if (!payload || payload.state !== 'ready') {
    const subtitle = payload?.state === 'empty' ? payload.subtitle : EMPTY_SUBTITLE_DEFAULT;
    root.dataset.state = 'empty';
    renderEmpty(targets, subtitle);
    return;
  }
  root.dataset.state = payload.rows.length === 0 ? 'empty' : 'ready';
  renderReady(targets, payload);
};
