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

const resolvePlanTitle = (view: BudgetDayView): string => {
  if (view === 'yesterday') return "Yesterday's result";
  if (view === 'tomorrow') return "Tomorrow's plan";
  return "Today's plan";
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
  const { projected, budget, remaining, tolerance } = params;
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

const resolveTone = (status: BudgetStatus): BudgetHeroData['heroTone'] => {
  if (status === 'over') return 'alert';
  if (status === 'tight') return 'warn';
  return 'ok';
};

const resolvePrimaryTone = (status: BudgetStatus): BudgetHeroData['primaryTone'] => {
  if (status === 'over') return 'critical';
  if (status === 'tight') return 'warning';
  return null;
};

const resolvePriceChip = (payload: DailyBudgetDayPayload | null): BudgetHeroData['priceChip'] => {
  if (!payload || payload.budget.enabled !== true || payload.budget.priceShapingEnabled !== true) return null;
  return isPriceReliable(payload) ? 'price-shaped' : 'price-unavailable';
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

type HeroSummary = {
  primary: string;
  secondary: string | null;
  meta: string | null;
  cost: string | null;
};

const resolveHeroSummaryToday = (
  payload: DailyBudgetDayPayload,
  costDisplay: CostDisplay,
): HeroSummary => {
  const cost = computeEstimatedCost({ payload, view: 'today' });
  const projected = computeProjectedUse(payload);
  const budget = payload.budget.dailyBudgetKWh;
  const tolerance = Math.max(0.1, budget * 0.01);
  return {
    primary: resolveProjectedBudgetPrimary({ projected, budget, remaining: payload.state.remainingKWh, tolerance }),
    secondary: `Projected ${formatKWhComparison(projected, budget)}`,
    meta: `${formatKWh(payload.state.remainingKWh)} left in today's budget`,
    cost: cost === null ? null : `Estimated cost ${formatCost(cost, costDisplay)}`,
  };
};

const resolveHeroSummaryYesterday = (payload: DailyBudgetDayPayload): HeroSummary => {
  const used = sum(payload.buckets.actualKWh);
  const budget = payload.budget.dailyBudgetKWh;
  const difference = budget - used;
  const direction = difference >= -Math.max(0.1, budget * 0.01) ? 'under budget' : 'over budget';
  return {
    primary: `${formatKWh(Math.abs(difference))} ${direction}`,
    secondary: `${formatKWhComparison(used, budget)} used`,
    meta: null,
    cost: null,
  };
};

const resolveHeroSummaryTomorrow = (payload: DailyBudgetDayPayload): HeroSummary => ({
  primary: `${formatKWh(resolveBudgetPlannedDayKWh(payload))} planned`,
  secondary: null,
  meta: null,
  cost: null,
});

const resolveHeroSummary = (
  payload: DailyBudgetUiPayload | null,
  viewPayload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  costDisplay: CostDisplay,
  status: BudgetStatus,
): HeroSummary => {
  if (!payload || viewPayload?.budget.enabled !== true) {
    return { primary: 'No daily plan', secondary: 'Enable daily budget to build a plan.', meta: null, cost: null };
  }
  if (status === 'noPlan' || !viewPayload) {
    return {
      primary: 'Waiting for daily budget data',
      secondary: 'PELS will show the plan when usage data is available.',
      meta: null,
      cost: null,
    };
  }
  if (view === 'yesterday') return resolveHeroSummaryYesterday(viewPayload);
  if (view === 'tomorrow') return resolveHeroSummaryTomorrow(viewPayload);
  return resolveHeroSummaryToday(viewPayload, costDisplay);
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
  const heroSummary = resolveHeroSummary(payload, viewPayload, view, costDisplay, status);
  return {
    localView: currentBudgetLocalView,
    view,
    hero: {
      planTitle: resolvePlanTitle(view),
      planDay: viewPayload ? `${viewPayload.dateKey} · ${resolveShortTimeZoneLabel(viewPayload)}` : '--',
      status,
      priceChip: view === 'yesterday' ? null : resolvePriceChip(viewPayload),
      ...heroSummary,
      primaryTone: resolvePrimaryTone(status),
      heroTone: resolveTone(status),
      nextAction: resolveBudgetNextAction(viewPayload, view, status),
    },
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
