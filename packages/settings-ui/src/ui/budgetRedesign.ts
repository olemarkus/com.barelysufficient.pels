import './materialWeb.ts';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
} from './dom.ts';
import { formatCost, type CostDisplay } from './dailyBudgetCost.ts';
import { formatKWh } from './dailyBudgetFormat.ts';
import {
  renderBudgetOverview,
  type BudgetAdjustData,
  type BudgetChartData,
  type BudgetDeltaTone,
  type BudgetHeroData,
  type BudgetLocalView,
  type BudgetOverviewProps,
  type BudgetStatus,
} from './views/BudgetOverview.tsx';
import {
  type BudgetRedesignChartMode,
  type BudgetRedesignDayView,
} from './budgetRedesignChart.ts';
import {
  applyBudgetAdjust,
  discardBudgetAdjust,
  getBudgetAdjustActivePayload,
  getBudgetAdjustCandidatePayload,
  getBudgetAdjustView,
  previewBudgetAdjust,
  setBudgetAdjustRenderer,
  updateBudgetAdjustField,
} from './budgetAdjustController.ts';

export type BudgetDayView = BudgetRedesignDayView;

type RenderState = {
  payload: DailyBudgetUiPayload | null;
  view: BudgetDayView;
  costDisplay: CostDisplay;
};

let currentBudgetLocalView: BudgetLocalView = 'plan';
let currentChartMode: BudgetRedesignChartMode = 'progress';
let latestRenderState: RenderState = {
  payload: null,
  view: 'today',
  costDisplay: { unit: 'kr', divisor: 100 },
};
let budgetSurface: HTMLElement | null = null;

const getBudgetSurface = (): HTMLElement | null => (
  budgetSurface ??= document.getElementById('budget-redesign-surface')
);

const sum = (values: number[] | undefined): number => (
  (values ?? []).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
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

const isPriceReliable = (payload: DailyBudgetDayPayload | null): boolean => {
  const prices = payload?.buckets.price;
  const planned = payload?.buckets.plannedKWh ?? [];
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
  const plannedKWh = payload.buckets.plannedKWh ?? [];
  const prices = payload.buckets.price;
  if (!isPriceReliable(payload) || !prices) return null;
  let totalCost = 0;
  const currentBucketIndex = view === 'today' ? payload.currentBucketIndex : plannedKWh.length;
  const actual = view === 'today' || view === 'yesterday' ? payload.buckets.actualKWh ?? [] : [];
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

const formatComparisonKWh = (value: number): string => (
  Number.isFinite(value) ? value.toFixed(1) : '--'
);

const resolveComparisonValue = (
  payload: DailyBudgetDayPayload,
  view: BudgetDayView,
): number => {
  if (view === 'yesterday') return sum(payload.buckets.actualKWh);
  if (view === 'tomorrow') return sum(payload.buckets.plannedKWh);
  return computeProjectedUse(payload);
};

const formatComparisonLine = (
  payload: DailyBudgetDayPayload,
  view: BudgetDayView,
): string => {
  const value = resolveComparisonValue(payload, view);
  const budget = payload.budget.dailyBudgetKWh;
  return `${formatComparisonKWh(value)} / ${formatComparisonKWh(budget)} kWh`;
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

const resolveTone = (status: BudgetStatus): BudgetHeroData['heroTone'] => {
  if (status === 'over') return 'alert';
  if (status === 'tight') return 'warn';
  return 'ok';
};

export const resolveDeltaPill = (
  payload: DailyBudgetDayPayload,
  view: BudgetDayView,
  status: BudgetStatus,
): { label: string; tone: BudgetDeltaTone } | null => {
  const budget = payload.budget.dailyBudgetKWh;
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const tolerance = Math.max(0.1, budget * 0.01);
  const value = resolveComparisonValue(payload, view);
  const diff = value - budget;
  if (status === 'over') return { label: `Over by ${formatComparisonKWh(diff)} kWh`, tone: 'alert' };
  if (status === 'tight') return { label: 'Close to budget', tone: 'warn' };
  if (status === 'within') {
    if (view === 'yesterday') return { label: `${formatComparisonKWh(Math.abs(diff))} kWh under`, tone: 'ok' };
    if (Math.abs(diff) <= tolerance) return { label: 'On budget', tone: 'ok' };
    return { label: `${formatComparisonKWh(Math.abs(diff))} kWh to spare`, tone: 'ok' };
  }
  return null;
};

const SPLIT_COVERAGE_THRESHOLD = 0.5;
const BACKGROUND_SHARE_GAP = 0.1;

const sumElapsed = (values: number[], buckets: number): number => {
  let total = 0;
  for (let index = 0; index < buckets && index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) total += value;
  }
  return total;
};

const sumElapsedNullable = (values: Array<number | null>, buckets: number): number => {
  let total = 0;
  for (let index = 0; index < buckets && index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) total += value as number;
  }
  return total;
};

type SplitTotals = { managed: number; background: number };

const resolveTodaySplit = (payload: DailyBudgetDayPayload): SplitTotals => {
  const elapsed = Math.max(0, payload.currentBucketIndex + 1);
  const actualTotal = sumElapsed(payload.buckets.actualKWh, elapsed);
  const managed = sumElapsedNullable(payload.buckets.actualControlledKWh, elapsed);
  const background = sumElapsedNullable(payload.buckets.actualUncontrolledKWh, elapsed);
  if (actualTotal > 0 && managed + background < actualTotal * SPLIT_COVERAGE_THRESHOLD) {
    return { managed: 0, background: actualTotal };
  }
  return { managed, background };
};

export const resolveSplitLine = (payload: DailyBudgetDayPayload): string => {
  const { managed, background } = resolveTodaySplit(payload);
  return `Managed ${formatKWh(managed, 1)} · Background ${formatKWh(background, 1)}`;
};

export type DominantCause = 'managed' | 'background';

export const resolveDominantCause = (payload: DailyBudgetDayPayload): DominantCause => {
  const elapsed = Math.max(0, payload.currentBucketIndex + 1);
  const actualTotal = sumElapsed(payload.buckets.actualKWh, elapsed);
  if (actualTotal <= 0) return 'background';
  const actualBackground = sumElapsedNullable(payload.buckets.actualUncontrolledKWh, elapsed);
  const actualManaged = sumElapsedNullable(payload.buckets.actualControlledKWh, elapsed);
  const splitTotal = actualBackground + actualManaged;
  if (splitTotal < actualTotal * SPLIT_COVERAGE_THRESHOLD) return 'background';
  const plannedTotal = sumElapsed(payload.buckets.plannedKWh, elapsed);
  const plannedBackground = sumElapsed(payload.buckets.plannedUncontrolledKWh, elapsed);
  const actualBgShare = actualBackground / splitTotal;
  const plannedBgShare = plannedTotal > 0 ? plannedBackground / plannedTotal : 0;
  return actualBgShare - plannedBgShare > BACKGROUND_SHARE_GAP ? 'background' : 'managed';
};

const resolvePriceTagline = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
): string | null => {
  if (!payload || view === 'yesterday') return null;
  if (payload.budget.enabled !== true || payload.budget.priceShapingEnabled !== true) return null;
  return isPriceReliable(payload) ? 'Price-shaped plan' : 'Price-shaped plan (price data unavailable)';
};

export const resolveHeadroomLine = (
  payload: DailyBudgetDayPayload,
  costDisplay: CostDisplay,
): string => {
  const remaining = payload.state.remainingKWh;
  const status = Number.isFinite(remaining) && remaining < 0
    ? `${formatKWh(Math.abs(remaining), 1)} over budget now`
    : `${formatKWh(remaining, 1)} headroom now`;
  const cost = computeEstimatedCost({ payload, view: 'today' });
  if (cost === null) return status;
  return `${status} · est. ${formatCost(cost, costDisplay)} today`;
};

const resolveNoPlanLine = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
): string => {
  if (payload?.budget.enabled === true) return 'Waiting for daily budget data.';
  if (view === 'tomorrow') return 'Enable daily budget to plan tomorrow.';
  return 'Enable daily budget to build a daily plan.';
};

const resolveTomorrowLine = (payload: DailyBudgetDayPayload): string => (
  isPriceReliable(payload) && payload.budget.priceShapingEnabled
    ? 'Most planned use is shifted toward cheaper hours.'
    : "Tomorrow's budget plan is ready."
);

const resolveTodayLine = (
  payload: DailyBudgetDayPayload,
  status: BudgetStatus,
): string | null => {
  if (status === 'within') return null;
  const cause = resolveDominantCause(payload);
  if (status === 'tight') {
    return cause === 'background'
      ? 'Close to budget — driven by background usage.'
      : 'PELS is shaping flexible use to stay within budget.';
  }
  return cause === 'background'
    ? 'Background usage is above plan today.'
    : 'Managed devices ran above plan — check device priorities.';
};

export const resolveDecisionLine = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  status: BudgetStatus,
): string | null => {
  if (!payload || status === 'noPlan') return resolveNoPlanLine(payload, view);
  if (view === 'yesterday') {
    return status === 'over' ? 'Yesterday finished over budget.' : 'Yesterday finished within budget.';
  }
  if (view === 'tomorrow') return resolveTomorrowLine(payload);
  return resolveTodayLine(payload, status);
};

const resolveHeroData = (
  viewPayload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  costDisplay: CostDisplay,
  status: BudgetStatus,
): BudgetHeroData => {
  if (!viewPayload || viewPayload.budget.enabled !== true || status === 'noPlan') {
    return {
      comparison: viewPayload?.budget.enabled === true ? 'Waiting for daily budget data' : 'Daily budget off',
      delta: null,
      headroomLine: null,
      splitLine: null,
      priceTagline: null,
      decision: resolveDecisionLine(viewPayload, view, status),
      heroTone: 'ok',
    };
  }
  return {
    comparison: formatComparisonLine(viewPayload, view),
    delta: resolveDeltaPill(viewPayload, view, status),
    headroomLine: view === 'today' ? resolveHeadroomLine(viewPayload, costDisplay) : null,
    splitLine: view === 'today' ? resolveSplitLine(viewPayload) : null,
    priceTagline: resolvePriceTagline(viewPayload, view),
    decision: resolveDecisionLine(viewPayload, view, status),
    heroTone: resolveTone(status),
  };
};

const resolveChartSubtitle = (params: {
  payload: DailyBudgetDayPayload;
  view: BudgetDayView;
  mode: BudgetRedesignChartMode;
  status: BudgetStatus;
  priceReliable: boolean;
}): string => {
  const { payload, view, mode, status, priceReliable } = params;
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

const resolveChartData = (
  viewPayload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  mode: BudgetRedesignChartMode,
  status: BudgetStatus,
  costDisplay: CostDisplay,
): BudgetChartData => {
  if (!viewPayload || viewPayload.budget.enabled !== true || status === 'noPlan') return null;
  const priceReliable = isPriceReliable(viewPayload);
  const showPrice = mode === 'hourlyPlan' && priceReliable && Boolean(viewPayload.budget.priceShapingEnabled);
  const showProjection = mode === 'progress' && view === 'today';
  const caveatNeeded = mode === 'hourlyPlan' && Boolean(viewPayload.budget.priceShapingEnabled) && !priceReliable;
  return {
    payload: viewPayload,
    view,
    mode,
    showPrice,
    showProjection,
    costDisplay,
    chartTitle: mode === 'progress' ? 'Progress' : 'Hourly plan',
    chartSubtitle: resolveChartSubtitle({ payload: viewPayload, view, mode, status, priceReliable }),
    caveat: caveatNeeded
      ? 'Price alignment unavailable. Add or refresh prices to show cheaper-hour context.'
      : null,
  };
};

const resolveComparisonChartMax = (day: DailyBudgetDayPayload | null): number => {
  if (!day) return 0;
  const planSum = sum(day.buckets.plannedKWh);
  const actualSum = sum(day.buckets.actualKWh);
  return Math.max(planSum, actualSum, day.budget.dailyBudgetKWh ?? 0);
};

const resolveAdjustData = (): BudgetAdjustData => {
  const view = getBudgetAdjustView();
  const { costDisplay } = latestRenderState;
  const dayView: BudgetDayView = 'today';
  const showComparison = view.status === 'pending';
  const activePayload = showComparison ? getBudgetAdjustActivePayload() : null;
  const candidatePayload = showComparison ? getBudgetAdjustCandidatePayload() : null;
  const activeDay = activePayload ? resolveViewPayload(activePayload, dayView) : null;
  const candidateDay = candidatePayload ? resolveViewPayload(candidatePayload, dayView) : null;
  const sharedMax = Math.max(resolveComparisonChartMax(activeDay), resolveComparisonChartMax(candidateDay));
  return {
    draft: view.draft,
    active: view.active,
    candidate: view.candidate,
    activeChart: activeDay
      ? { payload: activeDay, view: dayView, costDisplay, dataMaxOverride: sharedMax }
      : null,
    candidateChart: candidateDay
      ? { payload: candidateDay, view: dayView, costDisplay, dataMaxOverride: sharedMax }
      : null,
    status: view.status,
    busy: view.busy,
    hardCapKw: Number.parseFloat(settingsCapacityLimitInput?.value ?? ''),
    safetyMarginKw: Number.parseFloat(settingsCapacityMarginInput?.value ?? ''),
  };
};

let externalOnDayChange: (v: BudgetDayView) => void = () => {};

const buildProps = (): BudgetOverviewProps => {
  const { payload, view, costDisplay } = latestRenderState;
  const viewPayload = resolveViewPayload(payload, view);
  const status = resolveStatus(viewPayload, view);
  return {
    localView: currentBudgetLocalView,
    view,
    hero: resolveHeroData(viewPayload, view, costDisplay, status),
    chart: resolveChartData(viewPayload, view, currentChartMode, status, costDisplay),
    adjust: resolveAdjustData(),
    onLocalViewChange: (v) => {
      if (currentBudgetLocalView === 'adjust' && v !== 'adjust') discardBudgetAdjust();
      currentBudgetLocalView = v;
      doRender();
    },
    onDayChange: externalOnDayChange,
    onChartModeChange: (v) => { currentChartMode = v; doRender(); },
    onAdjustFieldChange: (patch) => updateBudgetAdjustField(patch),
    onPreview: () => { void previewBudgetAdjust(); },
    onApply: () => { void applyBudgetAdjust(); },
    onDiscard: () => { discardBudgetAdjust(); },
  };
};

export const doRender = () => {
  const surface = getBudgetSurface();
  if (!surface) return;
  renderBudgetOverview(surface, buildProps());
};

setBudgetAdjustRenderer(() => doRender());

export const renderBudgetRedesign = (
  payload: DailyBudgetUiPayload | null,
  view: BudgetDayView,
  costDisplay: CostDisplay,
) => {
  latestRenderState = { payload, view, costDisplay };
  doRender();
};

export const initBudgetRedesignHandlers = (onDaySelect: (view: BudgetDayView) => void) => {
  externalOnDayChange = onDaySelect;
  doRender();
};
