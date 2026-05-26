import { EMPTY_SUBTITLE_DEFAULT } from '../smartTasksWidgetPayload';
import type { SmartTasksWidgetPayload, SmartTasksWidgetRow } from '../smartTasksWidgetTypes';

const formatValue = (value: number | null, unitSymbol: '°C' | '%'): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  const text = rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
  return `${text} ${unitSymbol}`;
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
  const currentEl = li.querySelector('[data-row-current]');
  const targetEl = li.querySelector('[data-row-target]');
  const etaEl = li.querySelector('[data-row-eta]');
  const chipEl = li.querySelector('[data-row-chip]');
  if (nameEl instanceof HTMLElement) nameEl.textContent = row.deviceName;
  if (currentEl instanceof HTMLElement) currentEl.textContent = formatValue(row.currentValue, row.unitSymbol);
  if (targetEl instanceof HTMLElement) targetEl.textContent = formatValue(row.targetValue, row.unitSymbol);
  if (etaEl instanceof HTMLElement) etaEl.textContent = row.finishLabel ?? '—';
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
    overflowEl.textContent = `+${payload.overflowCount} more`;
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
