import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import { formatCost, type CostDisplay } from './dailyBudgetCost.ts';
import { formatKWh } from './dailyBudgetFormat.ts';
import type {
  BudgetChartData,
  BudgetConfidenceData,
  BudgetDeltaTone,
  BudgetHeroData,
  BudgetHeroSplitData,
  BudgetLocalView,
  BudgetStatus,
} from './views/BudgetOverview.tsx';
import type {
  BudgetRedesignChartMode,
  BudgetRedesignDayView,
} from './budgetRedesignChart.ts';
import {
  resolveBudgetCostViewAvailable,
  type BudgetChartUnit,
} from './budgetRedesignChartData.ts';
import {
  BUDGET_CHART_TITLE_HOURLY_PLAN,
  BUDGET_CHART_TITLE_PROGRESS,
  BUDGET_COMPARISON_SHOWING_TODAY,
  BUDGET_COMPARISON_SHOWING_TOMORROW,
  BUDGET_CONFIDENCE_LABEL_HIGH,
  BUDGET_CONFIDENCE_LABEL_LOW,
  BUDGET_CONFIDENCE_LABEL_MEDIUM,
  BUDGET_HERO_CLOSE_TO_BUDGET,
  BUDGET_HERO_ON_BUDGET,
  BUDGET_HERO_USING_CHEAPER_HOURS,
  BUDGET_HERO_USING_CHEAPER_HOURS_NO_PRICES,
  type BudgetConfidenceLabel,
  DAILY_BUDGET_DISABLED_OFF,
  DAILY_BUDGET_DISABLED_WAITING,
  DAILY_BUDGET_HEADLINE_LABEL_BY_VIEW,
  YESTERDAY_FINISHED_OVER_BUDGET,
  YESTERDAY_FINISHED_WITHIN_BUDGET,
  composeBudgetHeroOverBy,
  composeBudgetRemainingLineWithEstimate,
  composeBudgetRemainingToday,
  composeBudgetUsedOver,
  resolveChartSubtitle as resolveSharedChartSubtitle,
  resolveNoPlanLine as resolveSharedNoPlanLine,
  resolveTodayLine as resolveSharedTodayLine,
  resolveTomorrowLine as resolveSharedTomorrowLine,
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
  // Today reads the producer-resolved end-of-day projection so the comparison
  // line matches the chart curve and the widget exactly (one source of truth).
  // Only trust a finite producer value — NaN/Infinity fall back to the local
  // recompute rather than leaking into the comparison/delta text.
  const projected = payload.state.projection?.endOfDayKWh;
  return Number.isFinite(projected) ? (projected as number) : computeProjectedUse(payload);
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
  if (view === 'tomorrow') {
    const comparable = sum(payload.buckets.plannedKWh);
    return comparable > budget + tolerance ? 'over' : 'within';
  }
  // Today reads the producer-resolved status so the verdict matches the chart's
  // projection exactly (one source of truth, shared with the widget). Yesterday
  // and the no-producer fallback keep the local threshold computation.
  const producerStatus = payload.state.projection?.status;
  if (view !== 'yesterday' && producerStatus) return producerStatus;
  const comparable = view === 'yesterday'
    ? sum(payload.buckets.actualKWh)
    : computeProjectedUse(payload);
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
  if (status === 'over') return { label: composeBudgetHeroOverBy(diff), tone: 'alert' };
  if (status === 'tight') return { label: BUDGET_HERO_CLOSE_TO_BUDGET, tone: 'warn' };
  if (status === 'within') {
    if (view === 'yesterday') return { label: `${formatComparisonKWh(Math.abs(diff))} kWh under`, tone: 'ok' };
    if (Math.abs(diff) <= tolerance) return { label: BUDGET_HERO_ON_BUDGET, tone: 'ok' };
    return { label: `${formatComparisonKWh(Math.abs(diff))} kWh to spare`, tone: 'ok' };
  }
  return null;
};

const SPLIT_COVERAGE_THRESHOLD = 0.5;
const BACKGROUND_SHARE_GAP = 0.1;
// Day-level slack before the hero labels a gross-vs-net gap "Before solar:"
// (distinct from the per-hour `SPLIT_KWH_EPSILON` in `chartTooltipFormat.ts`
// — a whole day accumulates more benign drift than a single bucket).
const HERO_BEFORE_SOLAR_EPSILON_KWH = 0.05;

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

const resolveTodayManagedKWh = (payload: DailyBudgetDayPayload): number => {
  const elapsed = Math.max(0, payload.currentBucketIndex + 1);
  const actualTotal = sumElapsed(payload.buckets.actualKWh, elapsed);
  const managed = sumElapsedNullable(payload.buckets.actualControlledKWh, elapsed);
  const background = sumElapsedNullable(payload.buckets.actualUncontrolledKWh, elapsed);
  // Below the coverage threshold the split is untrustworthy — attribute
  // everything to background (managed reads 0.0).
  if (actualTotal > 0 && managed + background < actualTotal * SPLIT_COVERAGE_THRESHOLD) return 0;
  return managed;
};

// One-decimal rounding matching the split labels' display precision
// (`composeManagedSplitLabel` / `composeBackgroundSplitLabel`), so the
// residual subtraction below operates on the exact figures the user sees.
const roundDisplayKWh = (value: number): number => Math.round(value * 10) / 10;

// Structured managed/background split for the hero's stacked split bar. The
// kWh figures are the DISPLAY values (one-decimal, residual-rounded) so the
// bar segments and their labels describe identical numbers; `budgetKWh` and
// `usedKWh` let the view scale the segments against the DAY'S BUDGET — the
// empty track remainder is then literally the "left in today's budget" kWh
// the subline above it names.
export const resolveSplitData = (payload: DailyBudgetDayPayload): BudgetHeroSplitData => {
  // Residual rounding: the Budget chart readout displays the cumulative
  // actual total at the same one-decimal precision ("Actual 0.4 kWh").
  // Rounding Managed and Background independently can visibly contradict it
  // (0.14 → 0.1 plus 0.22 → 0.2 while the 0.36 total displays as 0.4), so
  // Background is the residual of the rounded total minus rounded Managed —
  // the split always sums to the total the user sees. Managed is itself
  // clamped to the rounded total first: when rounding pushes Managed above
  // the displayed total (0.35 → 0.4 vs total 0.34 → 0.3), an unclamped
  // Managed would overstate the split even with Background floored at 0.0.
  const elapsed = Math.max(0, payload.currentBucketIndex + 1);
  const actualTotal = sumElapsed(payload.buckets.actualKWh, elapsed);
  const actualManaged = resolveTodayManagedKWh(payload);
  const actualBackground = sumElapsedNullable(payload.buckets.actualUncontrolledKWh, elapsed);
  const splitTotal = actualManaged + actualBackground;
  const budgetKWh = Number.isFinite(payload.budget.dailyBudgetKWh) && payload.budget.dailyBudgetKWh > 0
    ? payload.budget.dailyBudgetKWh
    : null;
  const usedKWh = Math.max(0, roundDisplayKWh(actualTotal));
  if (
    splitTotal > HERO_BEFORE_SOLAR_EPSILON_KWH
    && splitTotal >= actualTotal * SPLIT_COVERAGE_THRESHOLD
    && splitTotal > actualTotal + HERO_BEFORE_SOLAR_EPSILON_KWH
  ) {
    return {
      managedKWh: roundDisplayKWh(actualManaged),
      backgroundKWh: roundDisplayKWh(actualBackground),
      beforeSolar: true,
      budgetKWh,
      usedKWh,
    };
  }
  const managed = Math.min(roundDisplayKWh(actualManaged), usedKWh);
  const background = Math.max(0, roundDisplayKWh(usedKWh - managed));
  return {
    managedKWh: managed,
    backgroundKWh: background,
    beforeSolar: false,
    budgetKWh,
    usedKWh,
  };
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
  return isPriceReliable(payload)
    ? BUDGET_HERO_USING_CHEAPER_HOURS
    : BUDGET_HERO_USING_CHEAPER_HOURS_NO_PRICES;
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
  // Source the cost from the SAME producer projection the headline kWh uses
  // (resolveComparisonValue) so projected energy and projected cost describe one
  // end-of-day scenario — otherwise an over-pace day shows producer-projected
  // kWh while understating cost with the plan-based estimate. Same minor units
  // (øre); fall back to the local estimate only when the producer value is absent.
  const projectedCostMinor = payload.state.projection?.endOfDayCostMinor;
  const cost = Number.isFinite(projectedCostMinor)
    ? (projectedCostMinor as number)
    : computeEstimatedCost({ payload, view: 'today' });
  if (cost === null) return status;
  return composeBudgetRemainingLineWithEstimate(status, formatCost(cost, costDisplay));
};

const resolveTomorrowLine = (payload: DailyBudgetDayPayload): string => (
  resolveSharedTomorrowLine(isPriceReliable(payload) && payload.budget.priceShapingEnabled)
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
  if (!payload || status === 'noPlan') return resolveSharedNoPlanLine(view, budgetEnabled);
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
      split: null,
      priceTagline: null,
      decision: resolveSharedNoPlanLine(view, budgetEnabled),
      heroTone: 'ok',
    };
  }
  return {
    headlineLabel: DAILY_BUDGET_HEADLINE_LABEL_BY_VIEW[view],
    comparison: formatComparisonLine(viewPayload, view),
    delta: resolveDeltaPill(viewPayload, view, status),
    budgetRemainingLine: view === 'today' ? resolveBudgetRemainingLine(viewPayload, costDisplay) : null,
    split: view === 'today' ? resolveSplitData(viewPayload) : null,
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

// The money toggle is a progress-mode affordance; the cost view is only
// available when the producer priced every budget-pace bucket. Resolved to a
// flat effective unit here — the requested 'money' falls back to 'energy'
// whenever it isn't available, so consumers never branch on availability.
const resolveChartUnit = (
  viewPayload: DailyBudgetDayPayload,
  mode: BudgetRedesignChartMode,
  requestedUnit: BudgetChartUnit,
  costDisplay: CostDisplay,
): { unit: BudgetChartUnit; costViewAvailable: boolean } => {
  // Money needs BOTH a fully-priced day AND a real display unit. Flow/Homey power
  // sources can report priced buckets with a blank unit (`{unit:'', divisor:1}`,
  // see priceUnit.ts) — offering a "kr"-labelled toggle there would render
  // unit-less, un-scaled numbers. Stay on kWh when there's no currency to show.
  const costViewAvailable = mode === 'progress'
    && costDisplay.unit.trim() !== ''
    && resolveBudgetCostViewAvailable(viewPayload);
  const unit: BudgetChartUnit = requestedUnit === 'money' && costViewAvailable ? 'money' : 'energy';
  return { unit, costViewAvailable };
};

export const resolveChartData = (params: {
  viewPayload: DailyBudgetDayPayload | null;
  view: BudgetDayView;
  mode: BudgetRedesignChartMode;
  status: BudgetStatus;
  costDisplay: CostDisplay;
  // Requested progress-chart unit (kWh⇄kr toggle); defaults to energy.
  requestedUnit?: BudgetChartUnit;
}): BudgetChartData => {
  const { viewPayload, view, mode, status, costDisplay, requestedUnit = 'energy' } = params;
  if (!viewPayload || viewPayload.budget.enabled !== true || status === 'noPlan') return null;
  const priceReliable = isPriceReliable(viewPayload);
  const priceShaping = Boolean(viewPayload.budget.priceShapingEnabled);
  const isHourly = mode === 'hourlyPlan';
  const { unit, costViewAvailable } = resolveChartUnit(viewPayload, mode, requestedUnit, costDisplay);
  return {
    payload: viewPayload,
    view,
    mode,
    unit,
    costViewAvailable,
    showPrice: isHourly && priceReliable && priceShaping,
    showProjection: mode === 'progress' && view === 'today',
    showSplit: isHourly && hasPlannedSplitBuckets(viewPayload),
    costDisplay,
    chartTitle: isHourly ? BUDGET_CHART_TITLE_HOURLY_PLAN : BUDGET_CHART_TITLE_PROGRESS,
    chartSubtitle: resolveChartSubtitle({ payload: viewPayload, view, mode, status, priceReliable }),
    caveat: isHourly && priceShaping && !priceReliable
      ? 'Price alignment unavailable. Add or refresh prices to show cheaper-hour context.'
      : null,
  };
};

const CONFIDENCE_HIGH_THRESHOLD = 0.75;
const CONFIDENCE_MEDIUM_THRESHOLD = 0.45;

const confidenceBand = (value: number): BudgetConfidenceLabel => {
  if (value >= CONFIDENCE_HIGH_THRESHOLD) return BUDGET_CONFIDENCE_LABEL_HIGH;
  if (value >= CONFIDENCE_MEDIUM_THRESHOLD) return BUDGET_CONFIDENCE_LABEL_MEDIUM;
  return BUDGET_CONFIDENCE_LABEL_LOW;
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
      label: 'Forecasted days',
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
  // Weather detail needs a loaded readout; flag-off (or data not yet fetched)
  // snaps the requested 'weather' view back to the plan view.
  weatherDetailAvailable: boolean,
): BudgetLocalView => {
  if (!activeEnabled) return 'adjust';
  if (requestedView === 'weather' && !weatherDetailAvailable) return 'plan';
  return requestedView;
};

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
      label: BUDGET_COMPARISON_SHOWING_TOMORROW,
    };
  }
  return {
    dayView: 'today',
    activeDay: resolveViewPayload(activePayload, 'today'),
    candidateDay: resolveViewPayload(candidatePayload, 'today'),
    label: BUDGET_COMPARISON_SHOWING_TODAY,
  };
};
