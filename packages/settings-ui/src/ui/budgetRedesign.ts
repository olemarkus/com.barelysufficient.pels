import './materialWeb.ts';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
} from './dom.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import { formatKWh } from './dailyBudgetFormat.ts';
import {
  renderBudgetOverview,
  type BudgetAdjustData,
  type BudgetChartData,
  type BudgetConfidenceData,
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
import { resolveAllocationWarning } from './dailyBudgetAllocationWarning.ts';
import { resolvePriceLevelChip } from '../../../shared-domain/src/priceLevelChips.ts';

export type BudgetDayView = BudgetRedesignDayView;

type RenderState = {
  payload: DailyBudgetUiPayload | null;
  view: BudgetDayView;
  costDisplay: CostDisplay;
  priceLevel: string | null;
};

let currentBudgetLocalView: BudgetLocalView = 'plan';
let currentChartMode: BudgetRedesignChartMode = 'progress';
let latestRenderState: RenderState = {
  payload: null,
  view: 'today',
  costDisplay: { unit: 'kr', divisor: 100 },
  priceLevel: null,
};

let budgetSurface: HTMLElement | null = null;

// Side-channel for power-derived signals not carried on the daily budget
// payload itself. Realtime power ticks push the current cheap/normal/expensive
// price tag through here so the Budget hero chip stays live without forcing a
// full budget-plan refresh on every tick. Intended single consumer is
// `dailyBudget.updateBudgetPower`; callers outside that thin adapter should
// not invoke this directly.
export const updateBudgetPriceLevel = (priceLevel: string | null): void => {
  if (latestRenderState.priceLevel === priceLevel) return;
  latestRenderState = { ...latestRenderState, priceLevel };
  doRender();
};

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

// Shared "is the projection close enough to the budget to call it on target?"
// gate. Used by both `resolveStatus` (decides tone) and `resolveSplitComparison`
// (decides whether the subline says "on" vs "under" / "over"); keeping the two
// in lockstep avoids the chip/prose disagreement TODO 490 cured for usage hero.
const BUDGET_TOLERANCE_RATIO = 0.01;
const budgetTolerance = (budget: number): number => Math.max(0.1, budget * BUDGET_TOLERANCE_RATIO);

const resolveComparisonValue = (
  payload: DailyBudgetDayPayload,
  view: BudgetDayView,
): number => {
  if (view === 'yesterday') return sum(payload.buckets.actualKWh);
  if (view === 'tomorrow') return sum(payload.buckets.plannedKWh);
  return computeProjectedUse(payload);
};

// Headline names the landing kWh in prose; the `value / budget` divisor moves
// to `splitComparison` so the headline reads as story rather than a stat row.
const formatComparisonLine = (payload: DailyBudgetDayPayload, view: BudgetDayView): string => {
  const value = formatComparisonKWh(resolveComparisonValue(payload, view));
  if (view === 'yesterday') return `Yesterday hit ${value} kWh`;
  if (view === 'tomorrow') return `Tomorrow plans ~${value} kWh`;
  return `Landing at ~${value} kWh`;
};

export const resolveSplitComparison = (
  payload: DailyBudgetDayPayload,
  view: BudgetDayView,
  status: BudgetStatus,
): string | null => {
  const budget = payload.budget.dailyBudgetKWh;
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const budgetText = formatComparisonKWh(budget);
  const value = resolveComparisonValue(payload, view);
  const diff = value - budget;
  const absDelta = formatComparisonKWh(Math.abs(diff));
  // `tight` (projection inside the tolerance band) gets a direction qualifier
  // so a barely-over day reads differently from a barely-under one — the old
  // chip carried that signal via colour and `Over by` / `kWh to spare`; the
  // subline restores it in prose.
  if (status === 'tight') {
    // Exact-budget days land in `tight` via the tolerance band; treat a zero
    // delta as on-budget so the subline never reads "0.0 over … — close."
    if (diff === 0) return `On your ${budgetText} budget — close.`;
    return `${absDelta} ${diff > 0 ? 'over' : 'under'} your ${budgetText} budget — close.`;
  }
  if (status === 'over') return `${absDelta} over your ${budgetText} budget.`;
  if (Math.abs(diff) <= budgetTolerance(budget)) return `On your ${budgetText} budget.`;
  return `${absDelta} under your ${budgetText} budget.`;
};

const resolveStatus = (payload: DailyBudgetDayPayload | null, view: BudgetDayView): BudgetStatus => {
  if (!payload || payload.budget.enabled !== true || sum(payload.buckets.plannedKWh) <= 0) return 'noPlan';
  const budget = payload.budget.dailyBudgetKWh;
  if (!Number.isFinite(budget) || budget <= 0) return 'noPlan';
  const tolerance = budgetTolerance(budget);
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

const SPLIT_COVERAGE_THRESHOLD = 0.5;
const BACKGROUND_SHARE_GAP = 0.1;

const HEADLINE_LABEL_BY_VIEW: Record<BudgetDayView, string> = {
  yesterday: "Yesterday's total", today: 'Projected today', tomorrow: 'Planned for tomorrow',
};

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

// Whole-unit cost projection — only when price data is reliable, so we never
// quote a number we can't back up. Øre precision reads as audit, not story.
//
// `nb-NO` formatter applies a thin space as the thousands separator so larger
// numbers (`1 234 kr`) read naturally; non-breaking spaces wrap the value to
// the unit so it cannot orphan onto its own line at 320 px viewports.
const COST_FORMATTER = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 });
const NBSP = ' ';
export const resolvePriceTagline = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  costDisplay: CostDisplay,
): string | null => {
  if (!payload || view === 'yesterday') return null;
  if (payload.budget.enabled !== true) return null;
  if (!isPriceReliable(payload)) return null;
  // Flow / Homey schemes with an unknown unit (`{unit: '', divisor: 1}`)
  // cannot be confidently labeled — suppress the tagline rather than print a
  // bare number the user has to interpret.
  const unit = costDisplay.unit.trim();
  if (!unit) return null;
  const cost = computeEstimatedCost({ payload, view });
  if (cost === null || !Number.isFinite(cost)) return null;
  const value = Math.round(cost / Math.max(1, costDisplay.divisor));
  if (value <= 0) return null;
  const amount = COST_FORMATTER.format(value);
  const tense = view === 'tomorrow' ? "tomorrow's prices" : "today's prices";
  return `≈${NBSP}${amount}${NBSP}${unit} at ${tense}.`;
};

export const resolveHeadroomLine = (payload: DailyBudgetDayPayload): string => {
  // `remainingKWh = dailyBudgetKWh - usedNowKWh`. NOK lives on `priceTagline`;
  // this subline stays kWh-only to avoid duplicating it.
  const remaining = payload.state.remainingKWh;
  if (Number.isFinite(remaining) && remaining < 0) {
    return `${formatKWh(Math.abs(remaining), 1)} over budget already used`;
  }
  return `${formatKWh(remaining, 1)} left in today's budget`;
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
): string | null => {
  if (status === 'within') return null;
  const cause = resolveDominantCause(payload);
  if (status === 'tight') {
    return cause === 'background'
      ? 'Close to budget — driven by background usage.'
      : 'PELS is shaping flexible use to stay within budget.';
  }
  return cause === 'background'
    ? 'Background usage is higher than expected today.'
    : 'Managed devices used more than expected — check device priorities.';
};

export const resolveDecisionLine = (
  payload: DailyBudgetDayPayload | null,
  view: BudgetDayView,
  status: BudgetStatus,
  budgetEnabled = payload?.budget.enabled === true,
): string | null => {
  if (!payload || status === 'noPlan') return resolveNoPlanLine(view, budgetEnabled);
  if (view === 'yesterday') {
    return status === 'over' ? 'Yesterday finished over budget.' : 'Yesterday finished within budget.';
  }
  if (view === 'tomorrow') return resolveTomorrowLine(payload);
  return resolveTodayLine(payload, status);
};

export type ResolveHeroDataParams = {
  viewPayload: DailyBudgetDayPayload | null;
  view: BudgetDayView;
  costDisplay: CostDisplay;
  status: BudgetStatus;
  budgetEnabled: boolean;
  priceLevel?: string | null;
};

export const resolveHeroData = (params: ResolveHeroDataParams): BudgetHeroData => {
  const {
    viewPayload, view, costDisplay, status, budgetEnabled, priceLevel = null,
  } = params;
  // Chip only on `today` — yesterday is historical, tomorrow's chip would refer
  // to tonight's prices rather than the displayed day, which would be misleading.
  const priceLevelChip = view === 'today' ? resolvePriceLevelChip(priceLevel) : null;
  if (!budgetEnabled || !viewPayload || viewPayload.budget.enabled !== true || status === 'noPlan') {
    return {
      headlineLabel: null,
      comparison: budgetEnabled ? 'Waiting for daily budget data' : 'Daily budget off',
      splitComparison: null,
      headroomLine: null,
      splitLine: null,
      priceTagline: null,
      // Chip is paired with the landing-today story — when there is no plan to
      // land or the budget is off, the rest of the hero is silent and a lone
      // `Price low` chip would read as an inconsistent voice in the surface.
      priceLevelChip: null,
      decision: resolveNoPlanLine(view, budgetEnabled),
      heroTone: 'ok',
    };
  }
  return {
    headlineLabel: HEADLINE_LABEL_BY_VIEW[view],
    comparison: formatComparisonLine(viewPayload, view),
    splitComparison: resolveSplitComparison(viewPayload, view, status),
    headroomLine: view === 'today' ? resolveHeadroomLine(viewPayload) : null,
    splitLine: view === 'today' ? resolveSplitLine(viewPayload) : null,
    priceTagline: resolvePriceTagline(viewPayload, view, costDisplay),
    priceLevelChip,
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

// Mirrors the `hasSplit` gate in `buildHourlyOption`: when the planner
// separated controllable vs. background buckets, the chart renders two
// stacked series — the legend must follow so its labels match the fills.
const hasPlannedSplitBuckets = (payload: DailyBudgetDayPayload): boolean => {
  const bucketCount = (payload.buckets.startLocalLabels || []).length;
  if (bucketCount <= 0) return false;
  return (payload.buckets.plannedUncontrolledKWh || []).length === bucketCount
    && (payload.buckets.plannedControlledKWh || []).length === bucketCount;
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

const resolveComparisonChartMax = (day: DailyBudgetDayPayload | null): number => {
  if (!day) return 0;
  const planned = day.buckets.plannedKWh ?? [];
  const actual = (day.buckets.actualKWh ?? []).filter((value): value is number => Number.isFinite(value));
  return Math.max(0, ...planned, ...actual);
};

type ComparisonDay = {
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

const resolveAdjustData = (): BudgetAdjustData => {
  const view = getBudgetAdjustView();
  const { costDisplay } = latestRenderState;
  const showComparison = view.status === 'pending';
  const activePayload = showComparison ? getBudgetAdjustActivePayload() : null;
  const candidatePayload = showComparison ? getBudgetAdjustCandidatePayload() : null;
  const { dayView, activeDay, candidateDay, label } = resolveComparisonDay(activePayload, candidatePayload);
  const sharedMax = Math.max(resolveComparisonChartMax(activeDay), resolveComparisonChartMax(candidateDay));
  const priceReliable = isPriceReliable(activeDay) && isPriceReliable(candidateDay);
  return {
    draft: view.draft,
    active: view.active,
    candidate: view.candidate,
    activeChart: activeDay
      ? { payload: activeDay, view: dayView, costDisplay, priceReliable, dataMaxOverride: sharedMax }
      : null,
    candidateChart: candidateDay
      ? { payload: candidateDay, view: dayView, costDisplay, priceReliable, dataMaxOverride: sharedMax }
      : null,
    comparisonDayView: dayView,
    comparisonDayLabel: label,
    comparisonShowPrice: priceReliable,
    status: view.status,
    busy: view.busy,
    hardCapKw: Number.parseFloat(settingsCapacityLimitInput?.value ?? ''),
    safetyMarginKw: Number.parseFloat(settingsCapacityMarginInput?.value ?? ''),
  };
};

let externalOnDayChange: (v: BudgetDayView) => void = () => {};

const buildProps = (): BudgetOverviewProps => {
  const { payload, view, costDisplay, priceLevel } = latestRenderState;
  const viewPayload = resolveViewPayload(payload, view);
  const status = resolveStatus(viewPayload, view);
  const adjust = resolveAdjustData();
  // The persisted enabled flag — not the per-day payload — is the source
  // of truth for whether the feature is on. The selected day's payload
  // may be transiently null (e.g. tomorrowKey not yet seeded) even when
  // the feature is enabled.
  const budgetEnabled = adjust.active.enabled;
  const planPayload = resolvePlanPayload(viewPayload, budgetEnabled);
  const effectiveLocalView = resolveEffectiveLocalView(budgetEnabled, currentBudgetLocalView);
  return {
    localView: effectiveLocalView,
    view,
    hero: resolveHeroData({ viewPayload, view, costDisplay, status, budgetEnabled, priceLevel }),
    chart: resolveChartData(planPayload, view, currentChartMode, status, costDisplay),
    confidence: resolveConfidenceData(planPayload, view, status),
    adjust,
    allocationWarning: view === 'today' ? resolveAllocationWarning(planPayload) : null,
    priceLevelChip: resolvePriceLevelChip(latestRenderState.priceLevel),
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
  latestRenderState = { ...latestRenderState, payload, view, costDisplay };
  doRender();
};

export const initBudgetRedesignHandlers = (onDaySelect: (view: BudgetDayView) => void) => {
  externalOnDayChange = onDaySelect;
  doRender();
};
