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
  dailyBudgetEmpty,
  dailyBudgetConfidence,
  dailyBudgetToggleToday,
  dailyBudgetToggleTomorrow,
  dailyBudgetToggleYesterday,
  dailyBudgetBreakdownInput,
} from './dom';
import { callApi, getSetting } from './homey';
import { showToast, showToastError } from './toast';
import { pushSettingWriteIfChanged } from './settingWrites';
import { logSettingsError } from './logging';
import { formatKWh, formatPercent, formatSignedKWh } from './dailyBudgetFormat';
import { renderDailyBudgetChart } from './dailyBudgetChart';
import {
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
} from '../../../lib/utils/settingsKeys';
import { MAX_DAILY_BUDGET_KWH, MIN_DAILY_BUDGET_KWH } from '../../../lib/dailyBudget/dailyBudgetConstants';
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

type DailyBudgetView = 'today' | 'tomorrow' | 'yesterday';
let currentDailyBudgetView: DailyBudgetView = 'today';
let latestDailyBudgetPayload: DailyBudgetUiPayload | null = null;
let costDisplay: CostDisplay = { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };

const viewLabels: Record<DailyBudgetView, { title: string; costLabel: string }> = {
  today: { title: 'Today plan', costLabel: 'Estimated cost today' },
  tomorrow: { title: 'Tomorrow plan', costLabel: 'Estimated cost tomorrow' },
  yesterday: { title: 'Yesterday plan', costLabel: 'Cost yesterday' },
};

const resolveDailyBudgetTitle = (view: DailyBudgetView) => viewLabels[view].title;
const resolveDailyBudgetCostLabel = (view: DailyBudgetView) => viewLabels[view].costLabel;

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

const setText = (element: HTMLElement | null, text: string) => {
  const target = element;
  if (target) target.textContent = text;
};

const setHidden = (element: HTMLElement | null, hidden: boolean) => {
  const target = element;
  if (target) target.hidden = hidden;
};

const setChipState = (element: HTMLElement, label: string, active?: boolean, alert?: boolean) => {
  const el = element;
  el.textContent = label;
  el.classList.remove('chip--ok', 'chip--alert');
  if (active) el.classList.add('chip--ok');
  if (alert) el.classList.add('chip--alert');
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
  if (view === 'yesterday') {
    const key = payload.yesterdayKey;
    if (!key) return null;
    return payload.days[key] ?? null;
  }
  const key = view === 'tomorrow' ? payload.tomorrowKey : payload.todayKey;
  if (!key) return null;
  return payload.days[key] ?? null;
};

const applyDailyBudgetViewState = () => {
  const views = [
    { view: 'today', element: dailyBudgetToggleToday },
    { view: 'tomorrow', element: dailyBudgetToggleTomorrow },
    { view: 'yesterday', element: dailyBudgetToggleYesterday },
  ] as const;

  views.forEach(({ view, element }) => {
    if (!element) return;
    const isActive = currentDailyBudgetView === view;
    element.classList.toggle('is-active', isActive);
    element.setAttribute('aria-pressed', String(isActive));
  });
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

const renderDailyBudgetEmptyState = (message = 'Daily budget data not available yet.') => {
  if (!dailyBudgetChart || !dailyBudgetEmpty) return;
  dailyBudgetEmpty.hidden = false;
  dailyBudgetEmpty.textContent = message;
  dailyBudgetChart.hidden = true;
  setPillState(false, false);
  const isTomorrow = currentDailyBudgetView === 'tomorrow';
  setDeviationVisibility(!isTomorrow);

  setText(dailyBudgetTitle, resolveDailyBudgetTitle(currentDailyBudgetView));
  setText(dailyBudgetDay, '--');
  setText(dailyBudgetRemaining, '-- kWh');
  setText(dailyBudgetDeviation, '-- kWh');

  setText(dailyBudgetCostLabel, resolveDailyBudgetCostLabel(currentDailyBudgetView));
  setText(dailyBudgetCost, formatCost(null, costDisplay));
  setChipStateIfPresent(dailyBudgetConfidence, 'Confidence --');
};

const renderDailyBudgetHeader = (payload: DailyBudgetDayPayload, view: DailyBudgetView) => {
  if (dailyBudgetTitle) {
    dailyBudgetTitle.textContent = resolveDailyBudgetTitle(view);
  }
  if (dailyBudgetDay) {
    dailyBudgetDay.textContent = `${payload.dateKey} · ${payload.timeZone}`;
  }
  setPillState(payload.budget.enabled, (view === 'today' || view === 'yesterday') ? payload.state.exceeded : false);
};

const renderDailyBudgetStats = (payload: DailyBudgetDayPayload, view: DailyBudgetView) => {
  const isTomorrow = view === 'tomorrow';
  if (dailyBudgetRemaining) dailyBudgetRemaining.textContent = formatKWh(payload.state.remainingKWh);
  setDeviationVisibility(!isTomorrow);
  if (dailyBudgetDeviation && !isTomorrow) {
    dailyBudgetDeviation.textContent = formatSignedKWh(payload.state.deviationKWh);
  }
  if (dailyBudgetCostLabel) dailyBudgetCostLabel.textContent = resolveDailyBudgetCostLabel(view);
  const plannedKWh = payload.buckets.plannedKWh || [];
  let costIndex: number | undefined;
  if (view === 'yesterday') {
    costIndex = plannedKWh.length;
  } else if (view === 'today') {
    costIndex = payload.currentBucketIndex;
  }
  const estimatedCost = computeEstimatedCost({
    plannedKWh,
    actualKWh: (view === 'today' || view === 'yesterday') ? payload.buckets.actualKWh : undefined,
    currentBucketIndex: costIndex,
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

const hasPlanBreakdownData = (payload: DailyBudgetDayPayload) => (
  Array.isArray(payload.buckets.plannedUncontrolledKWh)
  && Array.isArray(payload.buckets.plannedControlledKWh)
  && payload.buckets.plannedUncontrolledKWh.length === payload.buckets.plannedKWh.length
  && payload.buckets.plannedControlledKWh.length === payload.buckets.plannedKWh.length
);

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
    let msg = 'Tomorrow plan not available yet.';
    if (currentDailyBudgetView === 'yesterday') msg = 'Yesterday history not available.';
    renderDailyBudgetEmptyState(msg);
    return;
  }
  const showActual = currentDailyBudgetView === 'today' || currentDailyBudgetView === 'yesterday';
  const breakdownEnabled = Boolean(dailyBudgetBreakdownInput?.checked);
  const showBreakdown = breakdownEnabled && hasPlanBreakdownData(viewPayload);

  dailyBudgetEmpty.hidden = true;
  dailyBudgetChart.hidden = false;
  dailyBudgetChart.classList.toggle('is-disabled', !viewPayload.budget.enabled);

  renderDailyBudgetHeader(viewPayload, currentDailyBudgetView);
  renderDailyBudgetStats(viewPayload, currentDailyBudgetView);
  renderDailyBudgetChips(viewPayload);
  if (dailyBudgetBars && dailyBudgetLabels) {
    renderDailyBudgetChart({
      payload: viewPayload,
      showActual,
      showBreakdown,
      barsEl: dailyBudgetBars,
      labelsEl: dailyBudgetLabels,
    });
  }
};

export const rerenderDailyBudget = () => {
  renderDailyBudget(latestDailyBudgetPayload);
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

  const [currentEnabled, currentKwh, currentPriceShaping] = await Promise.all([
    getSetting(DAILY_BUDGET_ENABLED),
    getSetting(DAILY_BUDGET_KWH),
    getSetting(DAILY_BUDGET_PRICE_SHAPING_ENABLED),
  ]);
  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(writes, DAILY_BUDGET_ENABLED, currentEnabled, enabled);
  pushSettingWriteIfChanged(writes, DAILY_BUDGET_KWH, currentKwh, boundedKwh);
  pushSettingWriteIfChanged(
    writes,
    DAILY_BUDGET_PRICE_SHAPING_ENABLED,
    currentPriceShaping,
    priceShapingEnabled,
  );
  if (writes.length > 0) {
    await Promise.all(writes);
  }
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
  dailyBudgetToggleYesterday?.addEventListener('click', () => setDailyBudgetView('yesterday'));
};
