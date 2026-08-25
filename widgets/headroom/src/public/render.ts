import {
  HEADROOM_WIDGET_COPY,
  headroomAvailableLabel,
  headroomHeldBackLabel,
  headroomLimitStateLabel,
  headroomPriceAriaLabel,
  headroomPriceChipLabel,
  type HeadroomWidgetLimitState,
} from '../../../../packages/shared-domain/src/headroomWidgetCopy';
import { EMPTY_SUBTITLE_DEFAULT } from '../headroomWidgetConstants';
import type {
  HeadroomWidgetPayload,
  HeadroomWidgetPriceLevel,
  HeadroomWidgetReadyPayload,
} from '../headroomWidgetTypes';

const SHOW_PRICE_CHIP_FOR: ReadonlySet<HeadroomWidgetPriceLevel> = new Set(['cheap', 'expensive']);

type BarTone = 'neutral' | 'warn' | 'at-pace' | 'danger';

const formatKw = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
};

// `over_cap` — the hour on pace to exceed the hard cap (producer-resolved
// trajectory flag, never instantaneous kW vs the cap) — is the only red state.
// Pacing at the dynamic safe pace is correct operation → `at-pace` renders
// green (PELS is in control), distinct from the amber `near`/warn drift state
// and the red trajectory alarm.
const TONE_BY_LIMIT_STATE: Record<HeadroomWidgetLimitState, BarTone> = {
  under: 'neutral',
  near: 'warn',
  at_pace: 'at-pace',
  over_cap: 'danger',
};

const setChipPriceLevel = (chipEl: HTMLElement, level: HeadroomWidgetPriceLevel): void => {
  const chip = chipEl;
  chip.classList.remove('chip--cheap', 'chip--normal', 'chip--expensive', 'chip--unknown');
  chip.classList.add(`chip--${level}`);
  chip.textContent = headroomPriceChipLabel(level);
  chip.hidden = !SHOW_PRICE_CHIP_FOR.has(level);
};

const setStateLabel = (stateLabelEl: HTMLElement, state: HeadroomWidgetLimitState): void => {
  const el = stateLabelEl;
  const text = headroomLimitStateLabel(state);
  el.textContent = text;
  el.hidden = text === '';
};

export type RenderTargets = {
  root: HTMLElement;
  currentEl: HTMLElement;
  budgetEl: HTMLElement;
  captionCurrentEl: HTMLElement;
  captionBudgetEl: HTMLElement;
  chipEl: HTMLElement;
  barFillEl: HTMLElement;
  stateLabelEl: HTMLElement;
  metaEl: HTMLElement;
};

const renderReady = (targets: RenderTargets, payload: HeadroomWidgetReadyPayload): void => {
  const {
    root, currentEl, budgetEl, captionCurrentEl, captionBudgetEl,
    chipEl, barFillEl, stateLabelEl, metaEl,
  } = targets;
  root.dataset.state = 'ready';
  root.dataset.stale = payload.stale ? 'true' : 'false';

  const currentLabel = formatKw(payload.currentKw);
  const budgetLabelKw = formatKw(payload.hourBudgetKw);
  currentEl.textContent = currentLabel;
  budgetEl.textContent = `${budgetLabelKw} kW`;
  captionCurrentEl.textContent = HEADROOM_WIDGET_COPY.powerNowLabel;
  captionBudgetEl.textContent = HEADROOM_WIDGET_COPY.safePaceLabel;

  setChipPriceLevel(chipEl, payload.priceLevel);

  const ratio = payload.hourBudgetKw > 0
    ? Math.min(1, Math.max(0, payload.currentKw / payload.hourBudgetKw))
    : 0;
  barFillEl.style.width = `${(ratio * 100).toFixed(1)}%`;
  // A stale payload withdraws every CURRENT-state claim, not only the meta
  // line: the tones and the state label ("Above hard cap", "At safe pace")
  // assert a state of the house nothing vouches for any more — a gated boot
  // would otherwise paint a fully saturated red alarm from the previous run's
  // blob under a line saying the data is not current. Only the dimmed numbers
  // remain, as the last known reading.
  const tone = payload.stale ? 'neutral' : TONE_BY_LIMIT_STATE[payload.limitState];
  barFillEl.dataset.tone = tone;
  root.dataset.tone = tone;

  setStateLabel(stateLabelEl, payload.stale ? 'under' : payload.limitState);

  const availableLabel = headroomAvailableLabel(formatKw(Math.max(0, payload.headroomKw)));
  const heldBackLabel = headroomHeldBackLabel(payload.shedCount);
  // One meta pattern across all states: available power, plus the held-back
  // count when devices are paused. In `over_cap` the state label above already
  // carries the severity ("Above hard cap", red tone), and the clamped
  // "0 kW available" is factually right — on pace over the cap implies draw
  // above the safe pace, so there is no available power.
  //
  // A stale payload replaces the whole meta line: the numbers above are from
  // before (dimmed via `data-stale`), so asserting current available power or
  // a held-back count would present a previous reading — possibly a previous
  // RUN's — as live. The line says the data is not current instead.
  const liveMetaText = payload.shedCount > 0 ? `${availableLabel} · ${heldBackLabel}` : availableLabel;
  const metaText = payload.stale ? HEADROOM_WIDGET_COPY.notCurrentNote : liveMetaText;
  metaEl.textContent = metaText;
  metaEl.dataset.tone = tone === 'danger' ? 'danger' : 'ok';

  const stateSummary = payload.stale ? '' : headroomLimitStateLabel(payload.limitState);
  const priceAria = headroomPriceAriaLabel(payload.priceLevel);
  const ariaParts = [
    `${HEADROOM_WIDGET_COPY.powerNowLabel} ${currentLabel} kW`,
    `${HEADROOM_WIDGET_COPY.safePaceLabel} ${budgetLabelKw} kW`,
    ...(stateSummary ? [stateSummary] : []),
    ...(metaText ? [metaText] : []),
    ...(priceAria ? [priceAria] : []),
  ];
  root.setAttribute('aria-label', `${ariaParts.join('. ')}.`);
};

const renderEmpty = (targets: RenderTargets, subtitle: string): void => {
  const {
    root, currentEl, budgetEl, captionCurrentEl, captionBudgetEl,
    chipEl, barFillEl, stateLabelEl, metaEl,
  } = targets;
  root.dataset.state = 'empty';
  root.dataset.stale = 'false';
  currentEl.textContent = subtitle;
  budgetEl.textContent = '';
  captionCurrentEl.textContent = '';
  captionBudgetEl.textContent = '';
  setChipPriceLevel(chipEl, 'unknown');
  barFillEl.style.width = '0%';
  barFillEl.dataset.tone = 'neutral';
  root.dataset.tone = 'neutral';
  setStateLabel(stateLabelEl, 'under');
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
