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
  getWeatherInsightView,
  setWeatherInsightRenderer,
} from './weatherInsight.ts';
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
// Where the Done button leads from the Adjust view. 'settings' when the user
// arrived via the Settings tab's "Daily budget" row; 'plan' for sessions
// started from the Budget page header (or the allocation-warning CTA).
let adjustReturnTarget: 'plan' | 'settings' = 'plan';
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

// Entry point for the Settings tab's "Daily budget" row: open the Adjust
// view directly and route Done back to the Settings panel.
export const openBudgetAdjustFromSettings = (): void => {
  currentBudgetLocalView = 'adjust';
  adjustReturnTarget = 'settings';
  doRender();
};

// Injected by boot (budgetRedesign cannot import realtime's showTab — the
// realtime → dailyBudget → budgetRedesign import chain would turn circular).
// Routing through showTab keeps the leave path uniform: discard, referrer
// reset, and the unsaved-changes toast all live in discardBudgetAdjustOnLeave.
let settingsNavigator: () => void = () => {};

export const setBudgetAdjustSettingsNavigator = (navigate: () => void): void => {
  settingsNavigator = navigate;
};

// Called when the budget panel is left (tab bar or Done-to-Settings) so a
// stale 'settings' referrer doesn't survive into the next Adjust session.
// A settings-initiated session also ends entirely: the next direct visit to
// the Budget tab should land on the plan view, not a leftover Adjust view.
export const resetBudgetAdjustReturnTarget = (): void => {
  if (adjustReturnTarget === 'settings') {
    currentBudgetLocalView = 'plan';
    adjustReturnTarget = 'plan';
    doRender();
  }
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
  const weatherInsight = getWeatherInsightView();
  const effectiveLocalView = resolveEffectiveLocalView(
    budgetEnabled,
    currentBudgetLocalView,
    weatherInsight?.readout != null,
  );
  return {
    localView: effectiveLocalView,
    view,
    hero: resolveHeroData(viewPayload, view, costDisplay, status, budgetEnabled),
    chart: resolveChartData(planPayload, view, currentChartMode, status, costDisplay),
    confidence: resolveConfidenceData(planPayload, view, status),
    adjust,
    allocationWarning: view === 'today' ? resolveAllocationWarning(planPayload) : null,
    priceLevelChip: resolvePriceLevelChip(latestRenderState.priceLevel),
    weatherInsight,
    adjustReturnTarget,
    onReturnToSettings: () => {
      // The header has already confirmed any discard (two-step button), so
      // drop the draft before navigating — discardBudgetAdjustOnLeave then
      // sees a clean draft and stays silent instead of toasting the user
      // for an action they explicitly confirmed.
      discardBudgetAdjust();
      settingsNavigator();
    },
    onLocalViewChange: (v) => {
      if (currentBudgetLocalView === 'adjust' && v !== 'adjust') discardBudgetAdjust();
      // Header-initiated Adjust sessions always return to the plan view.
      if (v === 'adjust') adjustReturnTarget = 'plan';
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
// Weather-insight data lands asynchronously (budget-tab fetch, settings.set
// round-trips); re-render the Budget surface whenever the controller updates.
setWeatherInsightRenderer(() => doRender());

// Entry point for the `budget-weather` virtual settings-target (boot.ts):
// open the Budget tab directly on the Weather insight detail view. If the
// readout isn't loaded yet, resolveEffectiveLocalView snaps to plan until the
// tab-activation fetch lands and re-renders.
export const openBudgetWeatherView = (): void => {
  currentBudgetLocalView = 'weather';
  doRender();
};

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
