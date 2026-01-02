import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../lib/dailyBudget/dailyBudgetTypes';
import {
  dailyBudgetForm,
  dailyBudgetEnabledInput,
  dailyBudgetKwhInput,
  dailyBudgetPriceShapingInput,
  dailyBudgetStatusPill,
  dailyBudgetTitle,
  dailyBudgetDay,
  dailyBudgetRemaining,
  dailyBudgetDeviation,
  dailyBudgetCostLabel,
  dailyBudgetCost,
  dailyBudgetChart,
  dailyBudgetBars,
  dailyBudgetLabels,
  dailyBudgetLegend,
  dailyBudgetLegendActual,
  dailyBudgetEmpty,
  dailyBudgetConfidence,
  dailyBudgetToggleToday,
  dailyBudgetToggleTomorrow,
} from './dom';
import { callApi, getSetting, setSetting } from './homey';
import { showToast, showToastError } from './toast';
import { logSettingsError } from './logging';
import { setTooltip } from './tooltips';
import {
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
} from '../../../lib/utils/settingsKeys';
import { MAX_DAILY_BUDGET_KWH, MIN_DAILY_BUDGET_KWH } from '../../../lib/dailyBudget/dailyBudgetConstants';

const formatKWh = (value: number, digits = 2) => (
  Number.isFinite(value) ? `${value.toFixed(digits)} kWh` : '-- kWh'
);
const formatSignedKWh = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return '-- kWh';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)} kWh`;
};
const formatPercent = (value: number) => (
  Number.isFinite(value) ? `${Math.round(value * 100)}%` : '--%'
);
const DEFAULT_COST_UNIT = 'kr';
const DEFAULT_COST_DIVISOR = 100;

type CostDisplay = {
  unit: string;
  divisor: number;
};

const formatCost = (value: number | null | undefined, display: CostDisplay) => {
  const unit = display.unit.trim();
  const suffix = unit ? ` ${unit}` : '';
  if (!Number.isFinite(value)) return `--${suffix}`;
  const adjusted = (value as number) / Math.max(1, display.divisor);
  return `${adjusted.toFixed(2)}${suffix}`;
};

type DailyBudgetView = 'today' | 'tomorrow';
let currentDailyBudgetView: DailyBudgetView = 'today';
let latestDailyBudgetPayload: DailyBudgetUiPayload | null = null;
let costDisplay: CostDisplay = { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };

const applyDailyBudgetBounds = () => {
  if (!dailyBudgetKwhInput) return;
  dailyBudgetKwhInput.min = MIN_DAILY_BUDGET_KWH.toString();
  dailyBudgetKwhInput.max = MAX_DAILY_BUDGET_KWH.toString();
};

const setPillState = (enabled: boolean, exceeded: boolean) => {
  if (!dailyBudgetStatusPill) return;
  dailyBudgetStatusPill.classList.remove('ok', 'warn');
  if (!enabled) {
    dailyBudgetStatusPill.textContent = 'Disabled';
    return;
  }
  if (exceeded) {
    dailyBudgetStatusPill.textContent = 'Exceeded';
    dailyBudgetStatusPill.classList.add('warn');
    return;
  }
  dailyBudgetStatusPill.textContent = 'On track';
  dailyBudgetStatusPill.classList.add('ok');
};

const setChipState = (element: HTMLElement, label: string, active?: boolean, alert?: boolean) => {
  const el = element;
  el.textContent = label;
  el.classList.remove('chip--ok', 'chip--alert');
  if (active) el.classList.add('chip--ok');
  if (alert) el.classList.add('chip--alert');
};

const setText = (element: HTMLElement | null, text: string) => {
  const target = element;
  if (target) target.textContent = text;
};

const setHidden = (element: HTMLElement | null, hidden: boolean) => {
  const target = element;
  if (target) target.hidden = hidden;
};

const setChipStateIfPresent = (element: HTMLElement | null, label: string, active?: boolean, alert?: boolean) => {
  if (!element) return;
  setChipState(element, label, active, alert);
};

const setDeviationVisibility = (visible: boolean) => {
  const card = dailyBudgetDeviation?.closest('.summary-card') as HTMLElement | null;
  setHidden(card, !visible);
};

const resolveViewPayload = (
  payload: DailyBudgetUiPayload,
  view: DailyBudgetView,
): DailyBudgetDayPayload | null => {
  const key = view === 'tomorrow' ? payload.tomorrowKey : payload.todayKey;
  if (!key) return null;
  return payload.days[key] ?? null;
};

const applyDailyBudgetViewState = () => {
  const isToday = currentDailyBudgetView === 'today';
  if (dailyBudgetToggleToday) {
    dailyBudgetToggleToday.classList.toggle('is-active', isToday);
    dailyBudgetToggleToday.setAttribute('aria-pressed', String(isToday));
  }
  if (dailyBudgetToggleTomorrow) {
    dailyBudgetToggleTomorrow.classList.toggle('is-active', !isToday);
    dailyBudgetToggleTomorrow.setAttribute('aria-pressed', String(!isToday));
  }
};

const resolveCostDisplay = (combinedPrices: unknown | null): CostDisplay => {
  if (!combinedPrices || typeof combinedPrices !== 'object') {
    return { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };
  }
  const { priceScheme, priceUnit } = combinedPrices as { priceScheme?: unknown; priceUnit?: unknown };
  if (priceScheme === 'flow' || priceScheme === 'homey') {
    const unit = typeof priceUnit === 'string' && priceUnit !== 'price units' ? priceUnit : '';
    return { unit, divisor: 1 };
  }
  return { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };
};

const computeEstimatedCost = (params: {
  plannedKWh: number[];
  actualKWh?: number[];
  currentBucketIndex?: number;
  prices?: Array<number | null>;
}): number | null => {
  const {
    plannedKWh,
    actualKWh,
    currentBucketIndex,
    prices,
  } = params;
  if (!prices || prices.length === 0) return null;
  if (prices.length < plannedKWh.length) return null;
  let totalCost = 0;
  for (let index = 0; index < plannedKWh.length; index += 1) {
    const price = prices[index];
    if (!Number.isFinite(price)) return null;
    let kwh = plannedKWh[index] ?? 0;
    if (typeof currentBucketIndex === 'number' && index < currentBucketIndex) {
      const actualValue = actualKWh?.[index];
      if (Number.isFinite(actualValue)) {
        kwh = actualValue as number;
      }
    }
    totalCost += kwh * (price as number);
  }
  return totalCost;
};

const resolveLabelEvery = (count: number) => {
  if (count >= 24) return 4;
  if (count >= 16) return 3;
  if (count >= 12) return 2;
  return 1;
};

const formatHourLabel = (label: string) => {
  if (!label) return '';
  const trimmed = label.trim();
  if (!trimmed) return '';
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex > 0) return trimmed.slice(0, separatorIndex);
  return trimmed;
};

const getChartMaxValue = (planned: number[], actual: number[]) => {
  const maxPlanned = planned.reduce((max, value) => Math.max(max, value), 0);
  const maxActual = actual.reduce((max, value) => (
    Number.isFinite(value) ? Math.max(max, value) : max
  ), 0);
  return Math.max(maxPlanned, maxActual);
};

const buildDailyBudgetBarTitle = (params: {
  label: string;
  plannedKWh: number;
  actualKWh: number | undefined;
  isCurrent: boolean;
}) => {
  const { label, plannedKWh, actualKWh, isCurrent } = params;
  const titleParts = [];
  if (label) titleParts.push(label);
  titleParts.push(`Planned ${formatKWh(plannedKWh)}`);
  if (Number.isFinite(actualKWh)) {
    const actualLabel = isCurrent ? 'Actual so far' : 'Actual';
    titleParts.push(`${actualLabel} ${formatKWh(actualKWh)}`);
  }
  return titleParts.join(' · ');
};

const buildDailyBudgetBar = (params: {
  value: number;
  actualValue: number | undefined;
  index: number;
  currentBucketIndex: number;
  maxValue: number;
  label: string;
}) => {
  const {
    value,
    actualValue,
    index,
    currentBucketIndex,
    maxValue,
    label,
  } = params;
  const bar = document.createElement('div');
  bar.className = 'daily-budget-bar';
  if (currentBucketIndex >= 0 && index < currentBucketIndex) bar.classList.add('is-past');
  if (currentBucketIndex >= 0 && index === currentBucketIndex) bar.classList.add('is-current');

  const fill = document.createElement('div');
  fill.className = 'daily-budget-bar__fill';
  const heightPct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  fill.style.height = value > 0 ? `${Math.max(2, heightPct)}%` : '0%';
  bar.appendChild(fill);

  const showActual = Number.isFinite(actualValue) && currentBucketIndex >= 0 && index <= currentBucketIndex;
  if (showActual) {
    const dot = document.createElement('div');
    dot.className = 'daily-budget-dot';
    if ((actualValue as number) > value + 0.001) dot.classList.add('is-over');
    const actualPct = maxValue > 0 ? ((actualValue as number) / maxValue) * 100 : 0;
    dot.style.bottom = `${Math.max(0, Math.min(100, actualPct))}%`;
    bar.appendChild(dot);
  }

  setTooltip(bar, buildDailyBudgetBarTitle({
    label,
    plannedKWh: value,
    actualKWh: actualValue,
    isCurrent: index === currentBucketIndex,
  }));

  return bar;
};

const buildDailyBudgetAxisLabel = (params: {
  label: string;
  index: number;
  count: number;
  labelEvery: number;
}) => {
  const { label, index, count, labelEvery } = params;
  const axisLabel = document.createElement('div');
  axisLabel.className = 'daily-budget-label';
  const shortLabel = formatHourLabel(label);
  axisLabel.textContent = (index % labelEvery === 0 || index === count - 1) ? shortLabel : '';
  if (shortLabel && label && shortLabel !== label) {
    setTooltip(axisLabel, label);
  }
  return axisLabel;
};

const renderDailyBudgetChart = (payload: DailyBudgetDayPayload, showActual: boolean) => {
  if (!dailyBudgetBars || !dailyBudgetLabels) return;
  const planned = payload.buckets.plannedKWh || [];
  const actual = showActual ? payload.buckets.actualKWh || [] : [];
  const labels = payload.buckets.startLocalLabels || [];
  const count = planned.length;
  dailyBudgetBars.innerHTML = '';
  dailyBudgetLabels.innerHTML = '';

  const maxValue = getChartMaxValue(planned, actual);
  const labelEvery = resolveLabelEvery(count);
  const currentBucketIndex = showActual ? payload.currentBucketIndex : -1;

  planned.forEach((value, index) => {
    const label = labels[index] ?? '';
    const actualValue = showActual ? actual[index] : undefined;
    const bar = buildDailyBudgetBar({
      value,
      actualValue,
      index,
      currentBucketIndex,
      maxValue,
      label,
    });
    dailyBudgetBars.appendChild(bar);
    dailyBudgetLabels.appendChild(buildDailyBudgetAxisLabel({
      label,
      index,
      count,
      labelEvery,
    }));
  });

  if (count === 0) return;
};

const renderDailyBudgetEmptyState = (message = 'Daily budget data not available yet.') => {
  if (!dailyBudgetChart || !dailyBudgetEmpty) return;
  dailyBudgetEmpty.hidden = false;
  dailyBudgetEmpty.textContent = message;
  dailyBudgetChart.hidden = true;
  setHidden(dailyBudgetLegend, true);
  setHidden(dailyBudgetLegendActual, true);
  setPillState(false, false);
  const isTomorrow = currentDailyBudgetView === 'tomorrow';
  setDeviationVisibility(!isTomorrow);
  setText(dailyBudgetTitle, isTomorrow ? 'Tomorrow plan' : 'Today plan');
  setText(dailyBudgetDay, '--');
  setText(dailyBudgetRemaining, '-- kWh');
  setText(dailyBudgetDeviation, '-- kWh');
  setText(dailyBudgetCostLabel, isTomorrow ? 'Estimated cost tomorrow' : 'Estimated cost today');
  setText(dailyBudgetCost, formatCost(null, costDisplay));
  setTooltip(dailyBudgetDeviation, null);
  setChipStateIfPresent(dailyBudgetConfidence, 'Confidence --');
};

const renderDailyBudgetHeader = (payload: DailyBudgetDayPayload, view: DailyBudgetView) => {
  if (dailyBudgetTitle) {
    dailyBudgetTitle.textContent = view === 'tomorrow' ? 'Tomorrow plan' : 'Today plan';
  }
  if (dailyBudgetDay) {
    dailyBudgetDay.textContent = `${payload.dateKey} · ${payload.timeZone}`;
  }
  setPillState(payload.budget.enabled, view === 'today' ? payload.state.exceeded : false);
};

const renderDailyBudgetStats = (payload: DailyBudgetDayPayload, view: DailyBudgetView) => {
  const isTomorrow = view === 'tomorrow';
  if (dailyBudgetRemaining) dailyBudgetRemaining.textContent = formatKWh(payload.state.remainingKWh);
  setDeviationVisibility(!isTomorrow);
  if (dailyBudgetDeviation && !isTomorrow) {
    dailyBudgetDeviation.textContent = formatSignedKWh(payload.state.deviationKWh);
    setTooltip(dailyBudgetDeviation, 'Deviation = used minus allowed so far (time-weighted within the hour). Positive means over plan.');
  } else {
    setTooltip(dailyBudgetDeviation, null);
  }
  if (dailyBudgetCostLabel) {
    dailyBudgetCostLabel.textContent = view === 'tomorrow' ? 'Estimated cost tomorrow' : 'Estimated cost today';
  }
  const estimatedCost = computeEstimatedCost({
    plannedKWh: payload.buckets.plannedKWh || [],
    actualKWh: view === 'today' ? payload.buckets.actualKWh : undefined,
    currentBucketIndex: view === 'today' ? payload.currentBucketIndex : undefined,
    prices: payload.buckets.price,
  });
  if (dailyBudgetCost) dailyBudgetCost.textContent = formatCost(estimatedCost, costDisplay);
};

const renderDailyBudgetChips = (payload: DailyBudgetDayPayload) => {
  if (dailyBudgetConfidence) {
    const confidenceLabel = `Confidence ${formatPercent(payload.state.confidence)}`;
    setChipState(dailyBudgetConfidence, confidenceLabel, payload.state.confidence >= 0.5);
  }
};

const renderDailyBudget = (payload: DailyBudgetUiPayload | null) => {
  if (!dailyBudgetChart || !dailyBudgetEmpty) return;
  latestDailyBudgetPayload = payload;
  applyDailyBudgetViewState();
  if (!payload) {
    renderDailyBudgetEmptyState();
    return;
  }

  const viewPayload = resolveViewPayload(payload, currentDailyBudgetView);
  if (!viewPayload) {
    renderDailyBudgetEmptyState('Tomorrow plan not available yet.');
    return;
  }
  const showActual = currentDailyBudgetView === 'today';

  dailyBudgetEmpty.hidden = true;
  dailyBudgetChart.hidden = false;
  if (dailyBudgetLegend) dailyBudgetLegend.hidden = false;
  if (dailyBudgetLegendActual) dailyBudgetLegendActual.hidden = !showActual;
  dailyBudgetChart.classList.toggle('is-disabled', !viewPayload.budget.enabled);

  renderDailyBudgetHeader(viewPayload, currentDailyBudgetView);
  renderDailyBudgetStats(viewPayload, currentDailyBudgetView);
  renderDailyBudgetChips(viewPayload);
  renderDailyBudgetChart(viewPayload, showActual);
};

export const loadDailyBudgetSettings = async () => {
  const [enabled, dailyBudgetKWh, priceShapingEnabled] = await Promise.all([
    getSetting(DAILY_BUDGET_ENABLED),
    getSetting(DAILY_BUDGET_KWH),
    getSetting(DAILY_BUDGET_PRICE_SHAPING_ENABLED),
  ]);

  applyDailyBudgetBounds();

  if (dailyBudgetEnabledInput) {
    dailyBudgetEnabledInput.checked = enabled === true;
  }
  if (dailyBudgetKwhInput) {
    const raw = typeof dailyBudgetKWh === 'number' ? dailyBudgetKWh : MIN_DAILY_BUDGET_KWH;
    const bounded = Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, raw));
    dailyBudgetKwhInput.value = bounded.toString();
  }
  if (dailyBudgetPriceShapingInput) {
    dailyBudgetPriceShapingInput.checked = priceShapingEnabled !== false;
  }
};

export const saveDailyBudgetSettings = async () => {
  const enabled = dailyBudgetEnabledInput?.checked ?? false;
  const kwhValue = parseFloat(dailyBudgetKwhInput?.value || '0');
  if (!Number.isFinite(kwhValue) || kwhValue < 0) {
    throw new Error('Daily budget must be a non-negative number.');
  }
  if (enabled && (kwhValue < MIN_DAILY_BUDGET_KWH || kwhValue > MAX_DAILY_BUDGET_KWH)) {
    throw new Error(`Daily budget must be between ${MIN_DAILY_BUDGET_KWH} and ${MAX_DAILY_BUDGET_KWH} kWh.`);
  }
  const boundedKwh = Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, kwhValue));
  const priceShapingEnabled = dailyBudgetPriceShapingInput?.checked ?? true;

  await setSetting(DAILY_BUDGET_ENABLED, enabled);
  await setSetting(DAILY_BUDGET_KWH, boundedKwh);
  await setSetting(DAILY_BUDGET_PRICE_SHAPING_ENABLED, priceShapingEnabled);
  await showToast('Daily budget settings saved.', 'ok');
};

export const refreshDailyBudgetPlan = async () => {
  try {
    const [payload, combinedPrices] = await Promise.all([
      callApi<DailyBudgetUiPayload | null>('GET', '/daily_budget'),
      getSetting(COMBINED_PRICES).catch(() => null),
    ]);
    costDisplay = resolveCostDisplay(combinedPrices);
    renderDailyBudget(payload);
  } catch (error) {
    await logSettingsError('Failed to load daily budget plan', error, 'refreshDailyBudgetPlan');
    renderDailyBudget(null);
  }
};

const setDailyBudgetView = (view: DailyBudgetView) => {
  if (currentDailyBudgetView === view) return;
  currentDailyBudgetView = view;
  renderDailyBudget(latestDailyBudgetPayload);
};

export const initDailyBudgetHandlers = () => {
  const autoSave = async () => {
    try {
      await saveDailyBudgetSettings();
    } catch (error) {
      await logSettingsError('Failed to save daily budget settings', error, 'autoSaveDailyBudget');
      await showToastError(error, 'Failed to save daily budget settings.');
    }
  };

  dailyBudgetEnabledInput?.addEventListener('change', autoSave);
  dailyBudgetKwhInput?.addEventListener('change', autoSave);
  dailyBudgetPriceShapingInput?.addEventListener('change', autoSave);
  dailyBudgetForm?.addEventListener('submit', (event) => event.preventDefault());
  dailyBudgetToggleToday?.addEventListener('click', () => setDailyBudgetView('today'));
  dailyBudgetToggleTomorrow?.addEventListener('click', () => setDailyBudgetView('tomorrow'));
};
