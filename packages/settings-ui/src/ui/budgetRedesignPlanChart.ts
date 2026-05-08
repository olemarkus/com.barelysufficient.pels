import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import {
  clearBudgetRedesignChart,
  renderBudgetRedesignChart,
  type BudgetRedesignChartMode,
  type BudgetRedesignDayView,
} from './budgetRedesignChart.ts';

type BudgetStatus = 'noPlan' | 'within' | 'tight' | 'over';

type ChartLegendItem = {
  label: string;
  className: string;
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const setText = (id: string, text: string) => {
  const element = byId(id);
  if (element) element.textContent = text;
};

const setHidden = (id: string, hidden: boolean) => {
  const element = byId(id);
  if (element) element.hidden = hidden;
};

const renderLegend = (params: {
  view: BudgetRedesignDayView;
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
  ].filter((item): item is ChartLegendItem => item !== null);
  if (items.length <= 1) {
    legend.replaceChildren();
    return;
  }
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

const clearLegend = () => {
  const legend = byId('budget-redesign-chart-legend');
  if (legend) legend.replaceChildren();
};

const resolveReadyChartState = (params: {
  chartEl: HTMLElement | null;
  payload: DailyBudgetDayPayload | null;
  status: BudgetStatus;
}): { chartEl: HTMLElement; payload: DailyBudgetDayPayload } | null => {
  const { chartEl, payload, status } = params;
  if (!chartEl || !payload || payload.budget.enabled !== true || status === 'noPlan') return null;
  return { chartEl, payload };
};

const resolveChartSubtitle = (params: {
  payload: DailyBudgetDayPayload;
  view: BudgetRedesignDayView;
  mode: BudgetRedesignChartMode;
  status: BudgetStatus;
  priceReliable: boolean;
}): string => {
  const {
    payload,
    view,
    mode,
    status,
    priceReliable,
  } = params;
  if (mode === 'hourlyPlan') {
    if (priceReliable && payload.budget.priceShapingEnabled) return 'Budget follows cheaper hours.';
    if (payload.budget.priceShapingEnabled) return 'Cheaper-hour context needs price data.';
    return 'Shows how the budget is distributed through the day.';
  }
  if (view === 'yesterday') return status === 'over' ? 'Finished over the daily budget.' : 'Finished within budget.';
  if (view === 'tomorrow') return 'Shows the planned cumulative budget.';
  if (status === 'over') return 'Projected to finish over budget.';
  if (status === 'tight') return 'Close to the daily budget.';
  return 'On track to finish within budget.';
};

export const renderBudgetPlanChart = (params: {
  payload: DailyBudgetDayPayload | null;
  view: BudgetRedesignDayView;
  mode: BudgetRedesignChartMode;
  status: BudgetStatus;
  priceReliable: boolean;
  costDisplay: CostDisplay;
}) => {
  const {
    payload,
    view,
    mode,
    status,
    priceReliable,
    costDisplay,
  } = params;
  const chartEl = byId('budget-redesign-chart');
  const chartCard = byId('budget-redesign-chart-card');
  const ready = resolveReadyChartState({ chartEl, payload, status });
  if (!ready) {
    clearBudgetRedesignChart();
    if (chartEl) chartEl.replaceChildren();
    if (chartCard) chartCard.hidden = true;
    clearLegend();
    setText('budget-redesign-chart-title', '');
    setText('budget-redesign-chart-subtitle', '');
    setHidden('budget-redesign-chart-caveat', true);
    setText('budget-redesign-chart-caveat', '');
    return;
  }
  if (chartCard) chartCard.hidden = false;
  const showPrice = mode === 'hourlyPlan' && priceReliable && ready.payload.budget.priceShapingEnabled;
  const showProjection = mode === 'progress' && view === 'today';
  renderLegend({ view, showProjection, showPrice });
  renderBudgetRedesignChart({
    container: ready.chartEl,
    payload: ready.payload,
    mode,
    view,
    priceReliable: showPrice,
    costDisplay,
  });
  setText('budget-redesign-chart-title', mode === 'progress' ? 'Progress' : 'Hourly plan');
  setText('budget-redesign-chart-subtitle', resolveChartSubtitle({
    payload: ready.payload,
    view,
    mode,
    status,
    priceReliable,
  }));
  const caveat = byId('budget-redesign-chart-caveat');
  if (!caveat) return;
  const showCaveat = mode === 'hourlyPlan' && ready.payload.budget.priceShapingEnabled && !priceReliable;
  caveat.hidden = !showCaveat;
  caveat.textContent = showCaveat
    ? 'Price alignment unavailable. Add or refresh prices to show cheaper-hour context.'
    : '';
};
