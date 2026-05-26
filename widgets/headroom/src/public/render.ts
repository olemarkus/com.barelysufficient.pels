import { EMPTY_SUBTITLE_DEFAULT } from '../headroomWidgetPayload';
import type {
  HeadroomWidgetPayload,
  HeadroomWidgetPriceLevel,
  HeadroomWidgetReadyPayload,
} from '../headroomWidgetTypes';

const PRICE_LABEL: Record<HeadroomWidgetPriceLevel, string> = {
  cheap: 'cheap',
  normal: 'normal',
  expensive: 'expensive',
  unknown: '—',
};

const SHOW_PRICE_CHIP_FOR: ReadonlySet<HeadroomWidgetPriceLevel> = new Set(['cheap', 'expensive']);

const formatKw = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
};

const resolveBarTone = (
  currentKw: number,
  hourBudgetKw: number,
): 'neutral' | 'warn' | 'danger' => {
  if (hourBudgetKw <= 0) return 'neutral';
  const ratio = currentKw / hourBudgetKw;
  if (ratio >= 1) return 'danger';
  if (ratio >= 0.85) return 'warn';
  return 'neutral';
};

const setChipPriceLevel = (chipEl: HTMLElement, level: HeadroomWidgetPriceLevel): void => {
  const chip = chipEl;
  chip.classList.remove('chip--cheap', 'chip--normal', 'chip--expensive', 'chip--unknown');
  chip.classList.add(`chip--${level}`);
  chip.textContent = PRICE_LABEL[level];
  chip.hidden = !SHOW_PRICE_CHIP_FOR.has(level);
};

export type RenderTargets = {
  root: HTMLElement;
  currentEl: HTMLElement;
  budgetEl: HTMLElement;
  chipEl: HTMLElement;
  barFillEl: HTMLElement;
  metaEl: HTMLElement;
};

const renderReady = (targets: RenderTargets, payload: HeadroomWidgetReadyPayload): void => {
  const { root, currentEl, budgetEl, chipEl, barFillEl, metaEl } = targets;
  root.dataset.state = 'ready';
  root.dataset.stale = payload.stale ? 'true' : 'false';

  currentEl.textContent = formatKw(payload.currentKw);
  budgetEl.textContent = `${formatKw(payload.hourBudgetKw)} kW`;

  setChipPriceLevel(chipEl, payload.priceLevel);

  const ratio = payload.hourBudgetKw > 0
    ? Math.min(1, Math.max(0, payload.currentKw / payload.hourBudgetKw))
    : 0;
  barFillEl.style.width = `${(ratio * 100).toFixed(1)}%`;
  const tone = resolveBarTone(payload.currentKw, payload.hourBudgetKw);
  barFillEl.dataset.tone = tone;
  root.dataset.tone = tone;

  const availableLabel = `${formatKw(Math.max(0, payload.headroomKw))} kW available`;
  const pausedLabel = payload.shedCount === 1 ? '1 paused' : `${payload.shedCount} paused`;
  metaEl.textContent = payload.shedCount > 0 ? `${availableLabel} · ${pausedLabel}` : availableLabel;
  metaEl.dataset.tone = tone === 'danger' ? 'danger' : 'ok';

  const currentLabel = formatKw(payload.currentKw);
  const budgetLabelKw = formatKw(payload.hourBudgetKw);
  const priceLabel = PRICE_LABEL[payload.priceLevel];
  const ariaSummary = `Current draw ${currentLabel} of ${budgetLabelKw} kW. ${availableLabel}. Price ${priceLabel}.`;
  root.setAttribute('aria-label', ariaSummary);
};

const renderEmpty = (targets: RenderTargets, subtitle: string): void => {
  const { root, currentEl, budgetEl, chipEl, barFillEl, metaEl } = targets;
  root.dataset.state = 'empty';
  root.dataset.stale = 'false';
  currentEl.textContent = subtitle;
  budgetEl.textContent = '';
  setChipPriceLevel(chipEl, 'unknown');
  barFillEl.style.width = '0%';
  barFillEl.dataset.tone = 'neutral';
  root.dataset.tone = 'neutral';
  metaEl.textContent = '';
  metaEl.dataset.tone = 'ok';
  root.setAttribute('aria-label', `Available power: ${subtitle}`);
};

export const renderWidget = (targets: RenderTargets, payload: HeadroomWidgetPayload | null): void => {
  if (!payload || payload.state !== 'ready') {
    renderEmpty(targets, payload?.state === 'empty' ? payload.subtitle : EMPTY_SUBTITLE_DEFAULT);
    return;
  }
  renderReady(targets, payload);
};
