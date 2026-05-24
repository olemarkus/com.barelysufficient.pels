import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import { formatCost, type CostDisplay } from './dailyBudgetCost.ts';
import { formatKWh } from './dailyBudgetFormat.ts';
import type {
  BudgetChartData,
  BudgetConfidenceData,
  BudgetDeltaTone,
  BudgetHeroData,
  BudgetLocalView,
  BudgetStatus,
} from './views/BudgetOverview.tsx';
import type {
  BudgetRedesignChartMode,
  BudgetRedesignDayView,
} from './budgetRedesignChart.ts';
import {
  DAILY_BUDGET_DISABLED_OFF,
  DAILY_BUDGET_DISABLED_WAITING,
  DAILY_BUDGET_HEADLINE_LABEL_BY_VIEW,
  YESTERDAY_FINISHED_OVER_BUDGET,
  YESTERDAY_FINISHED_WITHIN_BUDGET,
  composeBudgetRemainingLineWithEstimate,
  composeBudgetRemainingToday,
  composeBudgetUsedOver,
  resolveChartSubtitle as resolveSharedChartSubtitle,
  resolveTodayLine as resolveSharedTodayLine,
} from '../../../shared-domain/src/dailyBudgetHeroStrings.ts';

export type BudgetDayView = BudgetRedesignDayView;

const sum = (values: number[] | undefined): number => (
  (values ?? []).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
);

export const resolveBudgetPlannedDayKWh = (payload: DailyBudgetDayPayload): number => (
  sum(payload.buckets.plannedKWh)
);

export const resolveViewPayload = (
  payload: DailyBudgetUiPayload | null,
  view: BudgetDayView,
): DailyBudgetDayPayload | null => {
  if (!payload) return null;
  let key = payload.todayKey;
  if (view === 'yesterday') key = payload.yesterdayKey;
  if (view === 'tomorrow') key = payload.tomorrowKey;
  return key ? (payload.days[key] ?? null) : null;
};

export const isPriceReliable = (payload: DailyBudgetDayPayload | null): boolean => {
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

export const resolveStatus = (payload: DailyBudgetDayPayload | null, view: BudgetDayView): BudgetStatus => {
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
  return isPriceReliable(payload) ? 'Using cheaper hours' : 'Using cheaper hours (price data unavailable)';
};

export const resolveBudgetRemainingLine = (
  payload: DailyBudgetDayPayload,
  costDisplay: CostDisplay,
): string => {
  // `remainingKWh = dailyBudgetKWh - usedNowKWh` (see
  // `lib/dailyBudget/dailyBudgetState.ts`). The hero headline shows
  // projected-vs-budget; this subline names *used* as the baseline so the two
  // numbers don't read as if they should add up.
  const remaining = payload.state.remainingKWh;
  const status = Number.isFinite(remaining) && remaining < 0
    ? composeBudgetUsedOver(formatKWh(Math.abs(remaining), 1))
    : composeBudgetRemainingToday(formatKWh(remaining, 1));
  const cost = computeEstimatedCost({ payload, view: 'today' });
  if (cost === null) return status;
  return composeBudgetRemainingLineWithEstimate(status, formatCost(cost, costDisplay));
};

const resolveNoPlanLine = (view: BudgetDayView, budgetEnabled: boolean): string => {
  if (budgetEnabled && view === 'tomorrow') {
    return "Tomorrow's plan is not available yet. Check electricity prices if it does not appear shortly.";
  }
  if (budgetEnabled && view === 'yesterday') return 'Yesterday history is not available yet.';
  if (budgetEnabled) return 'PELS is preparing the daily plan. Check again shortly.';
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
): string | null => resolveSharedTodayLine(status, resolveDominantCause(payload));

export const resolveDecisionLine = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  status: BudgetStatus,
  budgetEnabled = payload?.budget.enabled === true,
): string | null => {
  if (!payload || status === 'noPlan') return resolveNoPlanLine(view, budgetEnabled);
  if (view === 'yesterday') {
    return status === 'over' ? YESTERDAY_FINISHED_OVER_BUDGET : YESTERDAY_FINISHED_WITHIN_BUDGET;
  }
  if (view === 'tomorrow') return resolveTomorrowLine(payload);
  return resolveTodayLine(payload, status);
};

export const resolveHeroData = (
  viewPayload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  costDisplay: CostDisplay,
  status: BudgetStatus,
  budgetEnabled: boolean,
): BudgetHeroData => {
  if (!budgetEnabled || !viewPayload || viewPayload.budget.enabled !== true || status === 'noPlan') {
    return {
      headlineLabel: null,
      comparison: budgetEnabled ? DAILY_BUDGET_DISABLED_WAITING : DAILY_BUDGET_DISABLED_OFF,
      delta: null,
      budgetRemainingLine: null,
      splitLine: null,
      priceTagline: null,
      decision: resolveNoPlanLine(view, budgetEnabled),
      heroTone: 'ok',
    };
  }
  return {
    headlineLabel: DAILY_BUDGET_HEADLINE_LABEL_BY_VIEW[view],
    comparison: formatComparisonLine(viewPayload, view),
    delta: resolveDeltaPill(viewPayload, view, status),
    budgetRemainingLine: view === 'today' ? resolveBudgetRemainingLine(viewPayload, costDisplay) : null,
    splitLine: view === 'today' ? resolveSplitLine(viewPayload) : null,
    priceTagline: resolvePriceTagline(viewPayload, view),
    decision: resolveDecisionLine(viewPayload, view, status, budgetEnabled),
    heroTone: resolveTone(status),
  };
};

const resolveChartSubtitle = (params: {
  payload: DailyBudgetDayPayload;
  view: BudgetDayView;
  mode: BudgetRedesignChartMode;
  status: BudgetStatus;
  priceReliable: boolean;
}): string => resolveSharedChartSubtitle({
  view: params.view,
  mode: params.mode,
  status: params.status,
  priceReliable: params.priceReliable,
  priceShapingEnabled: Boolean(params.payload.budget.priceShapingEnabled),
});

// Mirrors the `hasSplit` gate in `buildHourlyOption`: when the planner
// separated controllable vs. background buckets, the chart renders two
// stacked series — the legend must follow so its labels match the fills.
const hasPlannedSplitBuckets = (payload: DailyBudgetDayPayload): boolean => {
  const bucketCount = (payload.buckets.startLocalLabels || []).length;
  if (bucketCount <= 0) return false;
  return (payload.buckets.plannedUncontrolledKWh || []).length === bucketCount
    && (payload.buckets.plannedControlledKWh || []).length === bucketCount;
};

export const resolveChartData = (
  viewPayload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  mode: BudgetRedesignChartMode,
  status: BudgetStatus,
  costDisplay: CostDisplay,
): BudgetChartData => {
  if (!viewPayload || viewPayload.budget.enabled !== true || status === 'noPlan') return null;
  const priceReliable = isPriceReliable(viewPayload);
  const priceShaping = Boolean(viewPayload.budget.priceShapingEnabled);
  const isHourly = mode === 'hourlyPlan';
  return {
    payload: viewPayload,
    view,
    mode,
    showPrice: isHourly && priceReliable && priceShaping,
    showProjection: mode === 'progress' && view === 'today',
    showSplit: isHourly && hasPlannedSplitBuckets(viewPayload),
    costDisplay,
    chartTitle: isHourly ? 'Hourly plan' : 'Progress',
    chartSubtitle: resolveChartSubtitle({ payload: viewPayload, view, mode, status, priceReliable }),
    caveat: isHourly && priceShaping && !priceReliable
      ? 'Price alignment unavailable. Add or refresh prices to show cheaper-hour context.'
      : null,
  };
};

type ConfidenceBand = NonNullable<BudgetConfidenceData>['label'];

const CONFIDENCE_HIGH_THRESHOLD = 0.75;
const CONFIDENCE_MEDIUM_THRESHOLD = 0.45;

const confidenceBand = (value: number): ConfidenceBand => {
  if (value >= CONFIDENCE_HIGH_THRESHOLD) return 'High';
  if (value >= CONFIDENCE_MEDIUM_THRESHOLD) return 'Medium';
  return 'Low';
};

const formatConfidencePercent = (value: number): string => `${Math.floor(value * 100)}%`;

const resolveConfidenceDebugRows = (
  confidenceDebug: DailyBudgetDayPayload['state']['confidenceDebug'],
): Array<{ label: string; value: string }> => {
  if (!confidenceDebug) return [];
  return [
    {
      label: 'Usage days',
      value: String(Math.max(0, Math.round(confidenceDebug.confidenceValidActualDays))),
    },
    {
      label: 'Planned days',
      value: String(Math.max(0, Math.round(confidenceDebug.confidenceValidPlannedDays))),
    },
    {
      label: 'Usage regularity',
      value: confidenceBand(confidenceDebug.confidenceRegularity),
    },
    {
      label: 'Managed-device fit',
      value: confidenceBand(confidenceDebug.confidenceAdaptability),
    },
  ];
};

export const resolveConfidenceData = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  status: BudgetStatus,
): BudgetConfidenceData => {
  if (!payload || view !== 'today') return null;
  if (payload.budget.enabled !== true || status === 'noPlan') return null;
  const confidence = payload.state.confidence;
  if (!Number.isFinite(confidence)) return null;
  const boundedConfidence = Math.max(0, Math.min(1, confidence));
  return {
    label: confidenceBand(boundedConfidence),
    percent: formatConfidencePercent(boundedConfidence),
    details: resolveConfidenceDebugRows(payload.state.confidenceDebug),
  };
};

export const resolveComparisonChartMax = (day: DailyBudgetDayPayload | null): number => {
  if (!day) return 0;
  const planned = day.buckets.plannedKWh ?? [];
  const actual = (day.buckets.actualKWh ?? []).filter((value): value is number => Number.isFinite(value));
  return Math.max(0, ...planned, ...actual);
};

export type ComparisonDay = {
  dayView: BudgetDayView;
  activeDay: DailyBudgetDayPayload | null;
  candidateDay: DailyBudgetDayPayload | null;
  label: string;
};

export const resolveEffectiveLocalView = (
  activeEnabled: boolean,
  requestedView: BudgetLocalView,
): BudgetLocalView => (activeEnabled ? requestedView : 'adjust');

export const resolvePlanPayload = (p: DailyBudgetDayPayload | null, enabled: boolean) => (enabled ? p : null);

export const resolveComparisonDay = (
  activePayload: DailyBudgetUiPayload | null,
  candidatePayload: DailyBudgetUiPayload | null,
): ComparisonDay => {
  const activeTomorrow = resolveViewPayload(activePayload, 'tomorrow');
  const candidateTomorrow = resolveViewPayload(candidatePayload, 'tomorrow');
  const tomorrowReady = Boolean(activeTomorrow && candidateTomorrow)
    && isPriceReliable(activeTomorrow) && isPriceReliable(candidateTomorrow);
  if (tomorrowReady) {
    return {
      dayView: 'tomorrow',
      activeDay: activeTomorrow,
      candidateDay: candidateTomorrow,
      label: 'Showing tomorrow’s plan — tomorrow’s prices are in.',
    };
  }
  return {
    dayView: 'today',
    activeDay: resolveViewPayload(activePayload, 'today'),
    candidateDay: resolveViewPayload(candidatePayload, 'today'),
    label: 'Showing today’s plan — tomorrow’s prices not yet available.',
  };
};
