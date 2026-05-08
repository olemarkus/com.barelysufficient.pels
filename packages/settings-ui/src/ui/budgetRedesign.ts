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
import { formatKWh } from './dailyBudgetFormat.ts';
import { type BudgetRedesignChartMode, type BudgetRedesignDayView } from './budgetRedesignChart.ts';
import { renderBudgetPlanChart } from './budgetRedesignPlanChart.ts';
import './materialWeb.ts';

export type BudgetDayView = BudgetRedesignDayView;

type BudgetStatus = 'noPlan' | 'within' | 'tight' | 'over';
type BudgetLocalView = 'plan' | 'adjust';
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

const setOptionalText = (id: string, text: string | null) => {
  const element = byId(id);
  if (!element) return;
  element.hidden = !text;
  element.textContent = text ?? '';
};

const sum = (values: number[] | undefined): number => (
  (values || []).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
);

export const resolveBudgetPlannedDayKWh = (payload: DailyBudgetDayPayload): number => (
  sum(payload.buckets.plannedKWh)
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

const formatKWhNumber = (value: number): string => (
  Number.isFinite(value) ? value.toFixed(2) : '--'
);

const formatKWhComparison = (used: number, budget: number): string => (
  `${formatKWhNumber(used)} of ${formatKWhNumber(budget)} kWh`
);

const resolveProjectedBudgetPrimary = (params: {
  projected: number;
  budget: number;
  remaining: number;
  tolerance: number;
}): string => {
  const {
    projected,
    budget,
    remaining,
    tolerance,
  } = params;
  if (!Number.isFinite(projected) || !Number.isFinite(budget) || budget <= 0) {
    return `${formatKWh(remaining)} remaining`;
  }
  const projectionDiff = budget - projected;
  if (Math.abs(projectionDiff) <= tolerance) return 'Projected close to budget';
  const direction = projectionDiff > 0 ? 'under' : 'over';
  return `${formatKWh(Math.abs(projectionDiff))} projected ${direction} budget`;
};

const resolveShortTimeZoneLabel = (payload: DailyBudgetDayPayload): string => {
  const timeZone = payload.timeZone.trim();
  if (!timeZone.includes('/')) return timeZone;
  const referenceDate = new Date(payload.dayStartUtc || payload.nowUtc);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(referenceDate);
    return parts.find((part) => part.type === 'timeZoneName')?.value || timeZone;
  } catch {
    return timeZone;
  }
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

const resolveTone = (status: BudgetStatus): string => {
  if (status === 'over') return 'alert';
  if (status === 'tight') return 'warn';
  return 'ok';
};

const resolveHeadlineTone = (status: BudgetStatus): string | null => {
  if (status === 'over') return 'critical';
  if (status === 'tight') return 'warning';
  return null;
};

const setStatusChip = (status: BudgetStatus) => {
  const chip = byId('budget-redesign-status-chip');
  if (!chip) return;
  chip.className = 'plan-chip plan-chip--muted';
  if (status === 'within') {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  if (status === 'noPlan') {
    chip.textContent = 'No plan';
    return;
  }
  if (status === 'tight') {
    chip.textContent = 'Tight';
    chip.className = 'plan-chip plan-chip--warn';
    return;
  }
  chip.textContent = 'Over budget';
  chip.className = 'plan-chip plan-chip--alert';
};

const setPlanTone = (status: BudgetStatus) => {
  const hero = byId('budget-plan-hero');
  if (hero) hero.dataset.tone = resolveTone(status);
  const headline = byId('budget-plan-primary');
  const headlineTone = resolveHeadlineTone(status);
  if (!headline) return;
  if (headlineTone) headline.dataset.tone = headlineTone;
  else delete headline.dataset.tone;
};

const setPriceChip = (payload: DailyBudgetDayPayload | null) => {
  const chip = byId('budget-redesign-price-chip');
  if (!chip) return;
  chip.className = 'plan-chip plan-chip--info';
  if (!payload || payload.budget.enabled !== true || payload.budget.priceShapingEnabled !== true) {
    chip.hidden = true;
    chip.textContent = '';
    return;
  }
  chip.hidden = false;
  if (isPriceReliable(payload)) {
    chip.textContent = 'Price-shaped';
    return;
  }
  chip.textContent = 'Price unavailable';
  chip.className = 'plan-chip plan-chip--warn';
};

const renderTodaySummary = (
  payload: DailyBudgetDayPayload,
  costDisplay: CostDisplay,
) => {
  const cost = computeEstimatedCost({ payload, view: 'today' });
  const projected = computeProjectedUse(payload);
  const budget = payload.budget.dailyBudgetKWh;
  const tolerance = Math.max(0.1, budget * 0.01);
  const primary = resolveProjectedBudgetPrimary({
    projected,
    budget,
    remaining: payload.state.remainingKWh,
    tolerance,
  });
  setText('budget-plan-primary', primary);
  setText(
    'budget-plan-secondary',
    `Projected ${formatKWhComparison(projected, budget)}`,
  );
  setOptionalText('budget-plan-meta', `${formatKWh(payload.state.remainingKWh)} left in today's budget`);
  setOptionalText('budget-plan-cost', cost === null ? null : `Estimated cost ${formatCost(cost, costDisplay)}`);
  setPriceChip(payload);
};

const renderYesterdaySummary = (payload: DailyBudgetDayPayload) => {
  const used = sum(payload.buckets.actualKWh);
  const budget = payload.budget.dailyBudgetKWh;
  const difference = budget - used;
  const direction = difference >= -Math.max(0.1, budget * 0.01) ? 'under budget' : 'over budget';
  setText('budget-plan-primary', `${formatKWh(Math.abs(difference))} ${direction}`);
  setText('budget-plan-secondary', `${formatKWhComparison(used, budget)} used`);
  setOptionalText('budget-plan-meta', null);
  setOptionalText('budget-plan-cost', null);
  setPriceChip(null);
};

const renderTomorrowSummary = (payload: DailyBudgetDayPayload) => {
  setText('budget-plan-primary', `${formatKWh(resolveBudgetPlannedDayKWh(payload))} planned`);
  setOptionalText('budget-plan-secondary', null);
  setOptionalText('budget-plan-meta', null);
  setOptionalText('budget-plan-cost', null);
  setPriceChip(payload);
};

const renderPlanSummary = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  costDisplay: CostDisplay,
  status: BudgetStatus,
) => {
  setPlanTone(status);
  if (!payload || payload.budget.enabled !== true) {
    setText('budget-plan-primary', 'No daily plan');
    setText('budget-plan-secondary', 'Enable daily budget to build a plan.');
    setOptionalText('budget-plan-meta', null);
    setOptionalText('budget-plan-cost', null);
    setPriceChip(null);
    return;
  }
  if (status === 'noPlan') {
    setText('budget-plan-primary', 'Waiting for daily budget data');
    setText('budget-plan-secondary', 'PELS will show the plan when usage data is available.');
    setOptionalText('budget-plan-meta', null);
    setOptionalText('budget-plan-cost', null);
    setPriceChip(payload);
    return;
  }
  if (view === 'yesterday') {
    renderYesterdaySummary(payload);
    return;
  }
  if (view === 'tomorrow') {
    renderTomorrowSummary(payload);
    return;
  }
  renderTodaySummary(payload, costDisplay);
};

export const resolveBudgetNextAction = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  status: BudgetStatus,
): string => {
  if (!payload || status === 'noPlan') {
    if (payload?.budget.enabled === true) return 'Waiting for daily budget data.';
    if (view === 'tomorrow') return 'Enable daily budget to plan tomorrow.';
    return 'Enable daily budget to build a daily plan.';
  }
  if (view === 'yesterday') {
    return status === 'over' ? 'Yesterday finished over budget.' : 'Yesterday finished within budget.';
  }
  if (view === 'tomorrow') {
    return isPriceReliable(payload) && payload.budget.priceShapingEnabled
      ? 'Most planned use is shifted toward cheaper hours.'
      : "Tomorrow's budget plan is ready.";
  }
  if (status === 'over') return "Today's budget is over the plan.";
  if (status === 'tight') return "Today's budget is tight. Review the daily budget or reduce flexible usage.";
  return "PELS expects to stay within today's budget.";
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
    viewPayload ? `${viewPayload.dateKey} · ${resolveShortTimeZoneLabel(viewPayload)}` : '--',
  );
  renderPlanSummary(viewPayload, state.view, state.costDisplay, status);
  renderBudgetPlanChart({
    payload: viewPayload,
    view: state.view,
    mode: currentChartMode,
    status,
    priceReliable: isPriceReliable(viewPayload),
    costDisplay: state.costDisplay,
  });
  setText('budget-redesign-next-action', resolveBudgetNextAction(viewPayload, state.view, status));
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
        setBudgetChartModeActive(value);
        renderPlan(latestRenderState);
      },
    );
    chartMount.replaceWith(element);
    setBudgetChartModeActive = setActive;
  }

  renderVisibleBudgetView();
};
