import './materialWeb.ts';
import type { DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
} from './dom.ts';
import { type CostDisplay } from './dailyBudgetCost.ts';
import {
  renderBudgetOverview,
  type BudgetAdjustData,
  type BudgetLocalView,
  type BudgetOverviewProps,
} from './views/BudgetOverview.tsx';
import { type BudgetRedesignChartMode } from './budgetRedesignChart.ts';
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
import {
  isPriceReliable,
  resolveChartData,
  resolveComparisonChartMax,
  resolveComparisonDay,
  resolveConfidenceData,
  resolveEffectiveLocalView,
  resolveHeroData,
  resolvePlanPayload,
  resolveStatus,
  resolveViewPayload,
  type BudgetDayView,
} from './budgetRedesignResolvers.ts';

export type { BudgetDayView } from './budgetRedesignResolvers.ts';

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

export const updateBudgetPriceLevel = (priceLevel: string | null): void => {
  if (latestRenderState.priceLevel === priceLevel) return;
  latestRenderState = { ...latestRenderState, priceLevel };
  doRender();
};
let budgetSurface: HTMLElement | null = null;

const getBudgetSurface = (): HTMLElement | null => (
  budgetSurface ??= document.getElementById('budget-redesign-surface')
);

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
  const { payload, view, costDisplay } = latestRenderState;
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
    hero: resolveHeroData(viewPayload, view, costDisplay, status, budgetEnabled),
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
