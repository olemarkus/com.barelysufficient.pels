import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  dailyBudgetControlledWeightInput,
  dailyBudgetEnabledInput,
  dailyBudgetKwhInput,
  dailyBudgetPriceFlexShareInput,
  dailyBudgetPriceShapingInput,
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
} from './dom.ts';
import { createToggleGroup } from './components.ts';
import { formatCost, type CostDisplay } from './dailyBudgetCost.ts';
import { formatKWh, formatSignedKWh } from './dailyBudgetFormat.ts';
import {
  clearBudgetRedesignChart,
  renderBudgetRedesignChart,
  type BudgetRedesignChartMode,
  type BudgetRedesignDayView,
} from './budgetRedesignChart.ts';

export type BudgetDayView = BudgetRedesignDayView;

type BudgetStatus = 'noPlan' | 'within' | 'tight' | 'over';
type BudgetLocalView = 'plan' | 'adjust';
type MetricItem = {
  label: string;
  value: string;
  hidden?: boolean;
};
type RenderState = {
  payload: DailyBudgetUiPayload | null;
  view: BudgetDayView;
  costDisplay: CostDisplay;
};

const DEFAULT_COST_DISPLAY: CostDisplay = { unit: 'kr', divisor: 100 };

let currentBudgetLocalView: BudgetLocalView = 'plan';
let currentChartMode: BudgetRedesignChartMode = 'progress';
let latestRenderState: RenderState = {
  payload: null,
  view: 'today',
  costDisplay: DEFAULT_COST_DISPLAY,
};
let setBudgetLocalViewActive: (value: BudgetLocalView | null) => void = () => {};
let setBudgetDayActive: (value: BudgetDayView | null) => void = () => {};
let setBudgetChartModeActive: (value: BudgetRedesignChartMode | null) => void = () => {};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const setText = (id: string, text: string) => {
  const element = byId(id);
  if (element) element.textContent = text;
};

const setHidden = (id: string, hidden: boolean) => {
  const element = byId(id);
  if (element) element.hidden = hidden;
};

const sum = (values: number[] | undefined): number => (
  (values || []).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
);

const resolveViewPayload = (
  payload: DailyBudgetUiPayload | null,
  view: BudgetDayView,
): DailyBudgetDayPayload | null => {
  if (!payload) return null;
  let key = payload.todayKey;
  if (view === 'yesterday') key = payload.yesterdayKey;
  if (view === 'tomorrow') key = payload.tomorrowKey;
  return key ? (payload.days[key] ?? null) : null;
};

const resolvePlanTitle = (view: BudgetDayView): string => {
  if (view === 'yesterday') return "Yesterday's result";
  if (view === 'tomorrow') return "Tomorrow's plan";
  return "Today's plan";
};

const isPriceReliable = (payload: DailyBudgetDayPayload | null): boolean => {
  const prices = payload?.buckets.price;
  const planned = payload?.buckets.plannedKWh || [];
  return Boolean(
    prices
      && prices.length >= planned.length
      && planned.length > 0
      && prices.slice(0, planned.length).every((price) => Number.isFinite(price)),
  );
};

const computeEstimatedCost = (params: {
  payload: DailyBudgetDayPayload;
  view: BudgetDayView;
}): number | null => {
  const { payload, view } = params;
  const plannedKWh = payload.buckets.plannedKWh || [];
  const prices = payload.buckets.price;
  if (!isPriceReliable(payload) || !prices) return null;
  let totalCost = 0;
  const currentBucketIndex = view === 'today' ? payload.currentBucketIndex : plannedKWh.length;
  const actual = view === 'today' || view === 'yesterday' ? payload.buckets.actualKWh || [] : [];
  for (let index = 0; index < plannedKWh.length; index += 1) {
    let kwh = plannedKWh[index] ?? 0;
    if (index < currentBucketIndex && Number.isFinite(actual[index])) {
      kwh = actual[index] as number;
    }
    totalCost += kwh * (prices[index] as number);
  }
  return totalCost;
};

const computeProjectedUse = (payload: DailyBudgetDayPayload): number => {
  const plannedTotal = sum(payload.buckets.plannedKWh);
  const allowedNow = Number.isFinite(payload.state.allowedNowKWh) ? payload.state.allowedNowKWh : 0;
  const usedNow = Number.isFinite(payload.state.usedNowKWh) ? payload.state.usedNowKWh : 0;
  return usedNow + Math.max(0, plannedTotal - allowedNow);
};

const resolveStatus = (payload: DailyBudgetDayPayload | null, view: BudgetDayView): BudgetStatus => {
  if (!payload || payload.budget.enabled !== true || sum(payload.buckets.plannedKWh) <= 0) return 'noPlan';
  const budget = payload.budget.dailyBudgetKWh;
  if (!Number.isFinite(budget) || budget <= 0) return 'noPlan';
  const tolerance = Math.max(0.1, budget * 0.01);
  let comparable = computeProjectedUse(payload);
  if (view === 'yesterday') comparable = sum(payload.buckets.actualKWh);
  if (view === 'tomorrow') {
    comparable = sum(payload.buckets.plannedKWh);
    return comparable > budget + tolerance ? 'over' : 'within';
  }
  if (comparable > budget + tolerance) return 'over';
  if (comparable >= budget - tolerance) return 'tight';
  return 'within';
};

const setStatusChip = (status: BudgetStatus) => {
  const chip = byId('budget-redesign-status-chip');
  if (!chip) return;
  chip.classList.remove('is-warning', 'is-critical', 'is-muted');
  if (status === 'within') {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  if (status === 'noPlan') {
    chip.textContent = 'No plan';
    chip.classList.add('is-muted');
    return;
  }
  if (status === 'tight') {
    chip.textContent = 'Tight';
    chip.classList.add('is-warning');
    return;
  }
  chip.textContent = 'Over budget';
  chip.classList.add('is-critical');
};

const setMetrics = (items: MetricItem[]) => {
  const slots = Array.from(document.querySelectorAll<HTMLElement>('[data-budget-metric-slot]'));
  slots.forEach((slot, index) => {
    const item = items[index];
    const metricSlot = slot;
    metricSlot.hidden = !item || item.hidden === true;
    const label = slot.querySelector<HTMLElement>('[data-budget-metric-label]');
    const value = slot.querySelector<HTMLElement>('[data-budget-metric-value]');
    if (label && item) label.textContent = item.label;
    if (value && item) value.textContent = item.value;
  });
};

const buildTodayMetrics = (
  payload: DailyBudgetDayPayload,
  costDisplay: CostDisplay,
): MetricItem[] => {
  const cost = computeEstimatedCost({ payload, view: 'today' });
  return [
    { label: 'Remaining', value: formatKWh(payload.state.remainingKWh) },
    { label: 'Projected use', value: formatKWh(computeProjectedUse(payload)) },
    { label: 'Daily budget', value: formatKWh(payload.budget.dailyBudgetKWh) },
    {
      label: 'Price estimate',
      value: formatCost(cost, costDisplay),
      hidden: cost === null,
    },
  ];
};

const buildYesterdayMetrics = (payload: DailyBudgetDayPayload): MetricItem[] => {
  const used = sum(payload.buckets.actualKWh);
  const budget = payload.budget.dailyBudgetKWh;
  const difference = budget - used;
  return [
    { label: 'Used', value: formatKWh(used) },
    { label: 'Budget', value: formatKWh(budget) },
    { label: 'Difference', value: formatSignedKWh(difference) },
    { label: 'Result', value: difference >= -Math.max(0.1, budget * 0.01) ? 'Within budget' : 'Over budget' },
  ];
};

const buildTomorrowMetrics = (payload: DailyBudgetDayPayload): MetricItem[] => {
  const priceEffect = isPriceReliable(payload) && payload.budget.priceShapingEnabled
    ? 'Price-shaped plan'
    : null;
  return [
    { label: 'Planned budget', value: formatKWh(payload.budget.dailyBudgetKWh) },
    { label: 'Price effect', value: priceEffect ?? '--', hidden: priceEffect === null },
  ];
};

const renderMetrics = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  costDisplay: CostDisplay,
) => {
  if (!payload || payload.budget.enabled !== true) {
    setMetrics([{ label: 'Daily budget', value: 'No plan' }]);
    return;
  }
  if (view === 'yesterday') {
    setMetrics(buildYesterdayMetrics(payload));
    return;
  }
  if (view === 'tomorrow') {
    setMetrics(buildTomorrowMetrics(payload));
    return;
  }
  setMetrics(buildTodayMetrics(payload, costDisplay));
};

const resolveNextAction = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  status: BudgetStatus,
): string => {
  if (!payload || status === 'noPlan') {
    if (view === 'tomorrow') return 'Enable daily budget to plan tomorrow.';
    return 'Enable daily budget to build a daily plan.';
  }
  if (view === 'yesterday') {
    return status === 'over' ? 'Yesterday finished over budget.' : 'Yesterday finished within budget.';
  }
  if (view === 'tomorrow') {
    return isPriceReliable(payload) && payload.budget.priceShapingEnabled
      ? 'Tomorrow uses a price-shaped plan.'
      : "Tomorrow's budget plan is ready.";
  }
  if (status === 'over') return "Today's budget is over the plan.";
  if (status === 'tight') return "Today's budget is tight. Review the daily budget or reduce flexible usage.";
  return "PELS expects to stay within today's budget.";
};

const renderLegend = (params: {
  view: BudgetDayView;
  showProjection: boolean;
  showPrice: boolean;
}) => {
  const legend = byId('budget-redesign-chart-legend');
  if (!legend) return;
  const items = [
    params.view === 'tomorrow' ? null : { label: 'Actual', className: 'budget-chart-legend__swatch--actual' },
    { label: 'Plan', className: '' },
    params.showProjection ? { label: 'Projection', className: 'budget-chart-legend__swatch--forecast' } : null,
    params.showPrice ? { label: 'Price', className: 'budget-chart-legend__swatch--price' } : null,
  ].filter((item): item is { label: string; className: string } => item !== null);
  legend.replaceChildren(...items.map((item) => {
    const row = document.createElement('span');
    row.className = 'budget-chart-legend__item';
    const swatch = document.createElement('span');
    swatch.className = ['budget-chart-legend__swatch', item.className].filter(Boolean).join(' ');
    const label = document.createElement('span');
    label.textContent = item.label;
    row.append(swatch, label);
    return row;
  }));
};

const renderChart = (payload: DailyBudgetDayPayload | null, view: BudgetDayView) => {
  const chartEl = byId('budget-redesign-chart');
  if (!chartEl || !payload || payload.budget.enabled !== true) {
    clearBudgetRedesignChart();
    if (chartEl) chartEl.replaceChildren();
    setHidden('budget-redesign-chart-caveat', true);
    return;
  }
  const priceReliable = isPriceReliable(payload);
  const showPrice = currentChartMode === 'hourlyPlan' && priceReliable;
  const showProjection = currentChartMode === 'progress' && view === 'today';
  renderLegend({ view, showProjection, showPrice });
  renderBudgetRedesignChart({
    container: chartEl,
    payload,
    mode: currentChartMode,
    view,
    priceReliable,
  });
  setText(
    'budget-redesign-chart-title',
    currentChartMode === 'progress' ? 'Progress' : 'Hourly plan',
  );
  setText(
    'budget-redesign-chart-subtitle',
    currentChartMode === 'progress'
      ? 'Cumulative use against the plan.'
      : 'Hourly budget shape and price alignment.',
  );
  const caveat = byId('budget-redesign-chart-caveat');
  if (!caveat) return;
  const showCaveat = currentChartMode === 'hourlyPlan'
    && payload.budget.priceShapingEnabled
    && !priceReliable;
  caveat.hidden = !showCaveat;
  caveat.textContent = showCaveat
    ? 'Price alignment unavailable. Add or refresh prices to show cheaper-hour context.'
    : '';
};

const resolveReserveLabel = (): string => (
  Number.parseFloat(dailyBudgetControlledWeightInput?.value ?? '0') >= 0.5 ? 'Conservative reserve' : 'Balanced reserve'
);

const resolveFlexibilityLabel = (): string => {
  const value = Number.parseFloat(dailyBudgetPriceFlexShareInput?.value ?? '0');
  if (value <= 0.3) return 'Low flexibility';
  if (value >= 0.85) return 'High flexibility';
  return 'Medium flexibility';
};

const renderAdjustSummary = () => {
  const dailyBudget = Number.parseFloat(dailyBudgetKwhInput?.value ?? '');
  const hardCap = Number.parseFloat(settingsCapacityLimitInput?.value ?? '');
  const safetyMargin = Number.parseFloat(settingsCapacityMarginInput?.value ?? '');
  setText('budget-adjust-enabled', dailyBudgetEnabledInput?.checked ? 'On' : 'Off');
  setText('budget-adjust-daily-budget', formatKWh(dailyBudget));
  setText('budget-adjust-cheaper-hours', dailyBudgetPriceShapingInput?.checked ? 'On' : 'Off');
  const reserve = resolveReserveLabel();
  const flexibility = resolveFlexibilityLabel();
  setText('budget-adjust-planning-summary', `${reserve} · ${flexibility}`);
  setText('budget-adjust-background-reserve', reserve.replace(' reserve', ''));
  setText('budget-adjust-managed-flexibility', flexibility.replace(' flexibility', ''));
  setText('budget-adjust-hard-cap', Number.isFinite(hardCap) ? `${hardCap.toFixed(1)} kW` : '-- kW');
  setText('budget-adjust-safety-margin', Number.isFinite(safetyMargin) ? `${safetyMargin.toFixed(1)} kW` : '-- kW');
  if (Number.isFinite(hardCap) && Number.isFinite(safetyMargin)) {
    setText('budget-adjust-reaction', `PELS reacts at ${Math.max(0, hardCap - safetyMargin).toFixed(1)} kW.`);
  } else {
    setText('budget-adjust-reaction', 'PELS reacts before reaching the hard cap.');
  }
};

const renderPlan = (state: RenderState) => {
  const viewPayload = resolveViewPayload(state.payload, state.view);
  const status = resolveStatus(viewPayload, state.view);
  setBudgetDayActive(state.view);
  setStatusChip(status);
  setText('budget-redesign-plan-title', resolvePlanTitle(state.view));
  setText(
    'budget-redesign-plan-day',
    viewPayload ? `${viewPayload.dateKey} · ${viewPayload.timeZone}` : '--',
  );
  renderMetrics(viewPayload, state.view, state.costDisplay);
  renderChart(viewPayload, state.view);
  setText('budget-redesign-next-action', resolveNextAction(viewPayload, state.view, status));
};

const renderVisibleBudgetView = () => {
  setBudgetLocalViewActive(currentBudgetLocalView);
  setBudgetChartModeActive(currentChartMode);
  setHidden('budget-redesign-plan-view', currentBudgetLocalView !== 'plan');
  setHidden('budget-redesign-adjust-view', currentBudgetLocalView !== 'adjust');
  renderAdjustSummary();
  if (currentBudgetLocalView === 'plan') renderPlan(latestRenderState);
};

export const renderBudgetRedesign = (
  payload: DailyBudgetUiPayload | null,
  view: BudgetDayView,
  costDisplay: CostDisplay,
) => {
  latestRenderState = { payload, view, costDisplay };
  renderVisibleBudgetView();
};

export const initBudgetRedesignHandlers = (onDaySelect: (view: BudgetDayView) => void) => {
  const viewMount = byId('budget-redesign-view-toggle-mount');
  if (viewMount) {
    const { element, setActive } = createToggleGroup(
      [
        { value: 'plan' as const, label: 'Plan' },
        { value: 'adjust' as const, label: 'Adjust' },
      ],
      'Budget view',
      (value) => {
        currentBudgetLocalView = value;
        renderVisibleBudgetView();
      },
    );
    viewMount.replaceWith(element);
    setBudgetLocalViewActive = setActive;
  }

  const dayMount = byId('budget-redesign-day-toggle-mount');
  if (dayMount) {
    const { element, setActive } = createToggleGroup(
      [
        { value: 'yesterday' as const, label: 'Yesterday' },
        { value: 'today' as const, label: 'Today' },
        { value: 'tomorrow' as const, label: 'Tomorrow' },
      ],
      'Budget day',
      onDaySelect,
    );
    dayMount.replaceWith(element);
    setBudgetDayActive = setActive;
  }

  const chartMount = byId('budget-redesign-chart-toggle-mount');
  if (chartMount) {
    const { element, setActive } = createToggleGroup(
      [
        { value: 'progress' as const, label: 'Progress' },
        { value: 'hourlyPlan' as const, label: 'Hourly plan' },
      ],
      'Budget chart view',
      (value) => {
        currentChartMode = value;
        renderPlan(latestRenderState);
      },
    );
    chartMount.replaceWith(element);
    setBudgetChartModeActive = setActive;
  }

  renderVisibleBudgetView();
};
