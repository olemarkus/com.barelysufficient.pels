import type {
  DailyBudgetDayPayload,
  DailyBudgetModelPreviewResponse,
  DailyBudgetModelSettings,
  DailyBudgetUiPayload,
} from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  dailyBudgetForm,
  dailyBudgetEnabledInput,
  dailyBudgetKwhInput,
  dailyBudgetPriceShapingInput,
  dailyBudgetControlledWeightInput,
  dailyBudgetPriceFlexShareInput,
  dailyBudgetStatusPill,
  dailyBudgetTitle,
  dailyBudgetDay,
  dailyBudgetRemaining,
  dailyBudgetDeviation,
  dailyBudgetCostLabel,
  dailyBudgetCost,
  dailyBudgetChart,
  dailyBudgetBars,
  dailyBudgetLabels,
  dailyBudgetEmpty,
  dailyBudgetConfidence,
  dailyBudgetBreakdownInput,
  dailyBudgetRecomputeButton,
  dailyBudgetApplyButton,
  dailyBudgetDiscardButton,
} from './dom.ts';
import { createToggleGroup } from './components.ts';
import { callApi, getSetting } from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { logSettingsError } from './logging.ts';
import { setTooltip } from './tooltips.ts';
import { formatKWh, formatSignedKWh } from './dailyBudgetFormat.ts';
import { renderDailyBudgetChart } from './dailyBudgetChart.ts';
import { getPricesReadModel } from './prices.ts';
import {
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
} from '../../../contracts/src/settingsKeys.ts';
import {
  SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH,
  SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  CONTROLLED_USAGE_WEIGHT,
  MAX_DAILY_BUDGET_KWH,
  MIN_DAILY_BUDGET_KWH,
  PRICE_SHAPING_FLEX_SHARE,
} from '../../../contracts/src/dailyBudgetConstants.ts';
const DEFAULT_COST_UNIT = 'kr';
const DEFAULT_COST_DIVISOR = 100;

type CostDisplay = {
  unit: string;
  divisor: number;
};

const formatCost = (value: number | null | undefined, display: CostDisplay) => {
  const unit = display.unit.trim();
  const suffix = unit ? ` ${unit}` : '';
  if (!Number.isFinite(value)) return `--${suffix}`;
  const adjusted = (value as number) / Math.max(1, display.divisor);
  return `${adjusted.toFixed(2)}${suffix}`;
};

type DailyBudgetView = 'today' | 'tomorrow' | 'yesterday';
let currentDailyBudgetView: DailyBudgetView = 'today';
let latestDailyBudgetPayload: DailyBudgetUiPayload | null = null;
let latestActiveDailyBudgetPayload: DailyBudgetUiPayload | null = null;
let pendingPreview: DailyBudgetModelPreviewResponse | null = null;
let costDisplay: CostDisplay = { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };
let setDailyBudgetToggleActive: (view: DailyBudgetView | null) => void = () => {};

const viewLabels: Record<DailyBudgetView, { title: string; costLabel: string }> = {
  today: { title: 'Today plan', costLabel: 'Estimated cost today' },
  tomorrow: { title: 'Tomorrow plan', costLabel: 'Estimated cost tomorrow' },
  yesterday: { title: 'Yesterday plan', costLabel: 'Cost yesterday' },
};

const resolveDailyBudgetTitle = (view: DailyBudgetView) => viewLabels[view].title;
const resolveDailyBudgetCostLabel = (view: DailyBudgetView) => viewLabels[view].costLabel;

const applyDailyBudgetBounds = () => {
  if (!dailyBudgetKwhInput) return;
  dailyBudgetKwhInput.min = MIN_DAILY_BUDGET_KWH.toString();
  dailyBudgetKwhInput.max = MAX_DAILY_BUDGET_KWH.toString();
};

const setPillState = (enabled: boolean, exceeded: boolean) => {
  if (!dailyBudgetStatusPill) return;
  if (enabled && exceeded) {
    dailyBudgetStatusPill.textContent = 'Exceeded';
    dailyBudgetStatusPill.classList.add('warn');
    dailyBudgetStatusPill.hidden = false;
  } else {
    dailyBudgetStatusPill.hidden = true;
  }
};

const setText = (element: HTMLElement | null, text: string) => {
  const target = element;
  if (target) target.textContent = text;
};

const setHidden = (element: HTMLElement | null, hidden: boolean) => {
  const target = element;
  if (target) target.hidden = hidden;
};

const setDeviationVisibility = (visible: boolean) => {
  const card = dailyBudgetDeviation?.closest('.summary-card') as HTMLElement | null;
  setHidden(card, !visible);
};

const resolveViewPayload = (
  payload: DailyBudgetUiPayload,
  view: DailyBudgetView,
): DailyBudgetDayPayload | null => {
  if (view === 'yesterday') {
    const key = payload.yesterdayKey;
    if (!key) return null;
    return payload.days[key] ?? null;
  }
  const key = view === 'tomorrow' ? payload.tomorrowKey : payload.todayKey;
  if (!key) return null;
  return payload.days[key] ?? null;
};


const resolveCostDisplay = (combinedPrices: unknown | null): CostDisplay => {
  if (!combinedPrices || typeof combinedPrices !== 'object') {
    return { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };
  }
  const { priceScheme, priceUnit } = combinedPrices as { priceScheme?: unknown; priceUnit?: unknown };
  if (priceScheme === 'flow' || priceScheme === 'homey') {
    const unit = typeof priceUnit === 'string' && priceUnit !== 'price units' ? priceUnit : '';
    return { unit, divisor: 1 };
  }
  return { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };
};

const computeEstimatedCost = (params: {
  plannedKWh: number[];
  actualKWh?: number[];
  currentBucketIndex?: number;
  prices?: Array<number | null>;
}): number | null => {
  const {
    plannedKWh,
    actualKWh,
    currentBucketIndex,
    prices,
  } = params;
  if (!prices || prices.length === 0) return null;
  if (prices.length < plannedKWh.length) return null;
  let totalCost = 0;
  for (let index = 0; index < plannedKWh.length; index += 1) {
    const price = prices[index];
    if (!Number.isFinite(price)) return null;
    let kwh = plannedKWh[index] ?? 0;
    if (typeof currentBucketIndex === 'number' && index < currentBucketIndex) {
      const actualValue = actualKWh?.[index];
      if (Number.isFinite(actualValue)) {
        kwh = actualValue as number;
      }
    }

    totalCost += kwh * (price as number);
  }
  return totalCost;
};

const setConfidence = (value: number | null) => {
  if (!dailyBudgetConfidence) return;
  if (value === null || !Number.isFinite(value)) {
    dailyBudgetConfidence.hidden = true;
    return;
  }
  dailyBudgetConfidence.textContent = `Confidence ${Math.round(value * 100)}%`;
  setTooltip(
    dailyBudgetConfidence,
    'How well PELS can predict your energy use based on the regularity'
    + ' of your usage patterns and how closely your home follows the budget plan.',
  );
  dailyBudgetConfidence.hidden = false;
};

const renderDailyBudgetEmptyState = (message = 'Daily budget data not available yet.') => {
  if (!dailyBudgetChart || !dailyBudgetEmpty) return;
  dailyBudgetEmpty.hidden = false;
  dailyBudgetEmpty.textContent = message;
  dailyBudgetChart.hidden = true;
  setConfidence(null);
  setPillState(false, false);
  const isTomorrow = currentDailyBudgetView === 'tomorrow';
  setDeviationVisibility(!isTomorrow);

  setText(dailyBudgetTitle, resolveDailyBudgetTitle(currentDailyBudgetView));
  setText(dailyBudgetDay, '--');
  setText(dailyBudgetRemaining, '-- kWh');
  setText(dailyBudgetDeviation, '-- kWh');

  setText(dailyBudgetCostLabel, resolveDailyBudgetCostLabel(currentDailyBudgetView));
  setText(dailyBudgetCost, formatCost(null, costDisplay));
};

const renderDailyBudgetHeader = (payload: DailyBudgetDayPayload, view: DailyBudgetView) => {
  if (dailyBudgetTitle) {
    dailyBudgetTitle.textContent = resolveDailyBudgetTitle(view);
  }
  if (dailyBudgetDay) {
    dailyBudgetDay.textContent = `${payload.dateKey} · ${payload.timeZone}`;
  }
  setPillState(payload.budget.enabled, (view === 'today' || view === 'yesterday') ? payload.state.exceeded : false);
};

const renderDailyBudgetStats = (payload: DailyBudgetDayPayload, view: DailyBudgetView) => {
  const isTomorrow = view === 'tomorrow';
  if (dailyBudgetRemaining) dailyBudgetRemaining.textContent = formatKWh(payload.state.remainingKWh);
  setConfidence(view === 'today' ? payload.state.confidence : null);
  setDeviationVisibility(!isTomorrow);
  if (dailyBudgetDeviation && !isTomorrow) {
    dailyBudgetDeviation.textContent = formatSignedKWh(payload.state.deviationKWh);
  }
  if (dailyBudgetCostLabel) dailyBudgetCostLabel.textContent = resolveDailyBudgetCostLabel(view);
  const plannedKWh = payload.buckets.plannedKWh || [];
  let costIndex: number | undefined;
  if (view === 'yesterday') {
    costIndex = plannedKWh.length;
  } else if (view === 'today') {
    costIndex = payload.currentBucketIndex;
  }
  const estimatedCost = computeEstimatedCost({
    plannedKWh,
    actualKWh: (view === 'today' || view === 'yesterday') ? payload.buckets.actualKWh : undefined,
    currentBucketIndex: costIndex,
    prices: payload.buckets.price,
  });
  if (dailyBudgetCost) dailyBudgetCost.textContent = formatCost(estimatedCost, costDisplay);
};

const hasPlanBreakdownData = (payload: DailyBudgetDayPayload) => (
  Array.isArray(payload.buckets.plannedUncontrolledKWh)
  && Array.isArray(payload.buckets.plannedControlledKWh)
  && payload.buckets.plannedUncontrolledKWh.length === payload.buckets.plannedKWh.length
  && payload.buckets.plannedControlledKWh.length === payload.buckets.plannedKWh.length
);

const renderDailyBudget = (payload: DailyBudgetUiPayload | null) => {
  if (!dailyBudgetChart || !dailyBudgetEmpty) return;
  latestDailyBudgetPayload = payload;
  setDailyBudgetToggleActive(currentDailyBudgetView);
  if (!payload) {
    renderDailyBudgetEmptyState();
    return;
  }

  const viewPayload = resolveViewPayload(payload, currentDailyBudgetView);
  if (!viewPayload) {
    let msg = 'Tomorrow plan not available yet.';
    if (currentDailyBudgetView === 'yesterday') msg = 'Yesterday history not available.';
    renderDailyBudgetEmptyState(msg);
    return;
  }
  const showActual = currentDailyBudgetView === 'today' || currentDailyBudgetView === 'yesterday';
  const breakdownEnabled = Boolean(dailyBudgetBreakdownInput?.checked);
  const showBreakdown = breakdownEnabled && hasPlanBreakdownData(viewPayload);

  dailyBudgetEmpty.hidden = true;
  dailyBudgetChart.hidden = false;
  dailyBudgetChart.classList.toggle('is-disabled', !viewPayload.budget.enabled);

  renderDailyBudgetHeader(viewPayload, currentDailyBudgetView);
  renderDailyBudgetStats(viewPayload, currentDailyBudgetView);
  if (dailyBudgetBars && dailyBudgetLabels) {
    renderDailyBudgetChart({
      payload: viewPayload,
      showActual,
      showBreakdown,
      barsEl: dailyBudgetBars,
      labelsEl: dailyBudgetLabels,
    });
  }
};

const setDailyBudgetModelDirty = (dirty: boolean) => {
  if (dirty) pendingPreview = null;
  if (dailyBudgetRecomputeButton) {
    dailyBudgetRecomputeButton.textContent = dirty ? 'Preview changes' : 'Preview plan';
  }
  if (dailyBudgetApplyButton) {
    dailyBudgetApplyButton.hidden = !pendingPreview;
  }
  if (dailyBudgetDiscardButton) {
    dailyBudgetDiscardButton.hidden = !pendingPreview;
  }
};

const showActiveDailyBudgetPlan = () => {
  renderDailyBudget(latestActiveDailyBudgetPayload);
};

const showPendingPreview = () => {
  if (!pendingPreview?.candidate) return false;
  renderDailyBudget(pendingPreview.candidate);
  if (dailyBudgetApplyButton) {
    dailyBudgetApplyButton.hidden = false;
    dailyBudgetApplyButton.disabled = false;
  }
  if (dailyBudgetDiscardButton) {
    dailyBudgetDiscardButton.hidden = false;
    dailyBudgetDiscardButton.disabled = false;
  }
  return true;
};

const discardDailyBudgetPreview = () => {
  pendingPreview = null;
  if (dailyBudgetApplyButton) {
    dailyBudgetApplyButton.hidden = true;
    dailyBudgetApplyButton.disabled = false;
  }
  if (dailyBudgetDiscardButton) {
    dailyBudgetDiscardButton.hidden = true;
    dailyBudgetDiscardButton.disabled = false;
  }
  showActiveDailyBudgetPlan();
};

export const markDailyBudgetModelDraftChanged = () => {
  setDailyBudgetModelDirty(true);
  showActiveDailyBudgetPlan();
};

const parseDailyBudgetRatio = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
};

const readDailyBudgetKWh = (enabled: boolean): number => {
  const kwhValue = parseFloat(dailyBudgetKwhInput?.value || '0');
  if (!Number.isFinite(kwhValue) || kwhValue < 0) {
    throw new Error('Daily budget must be a non-negative number.');
  }
  if (enabled && (kwhValue < MIN_DAILY_BUDGET_KWH || kwhValue > MAX_DAILY_BUDGET_KWH)) {
    throw new Error(`Daily budget must be between ${MIN_DAILY_BUDGET_KWH} and ${MAX_DAILY_BUDGET_KWH} kWh.`);
  }
  return Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, kwhValue));
};

const readDailyBudgetModelDraft = (): DailyBudgetModelSettings => {
  const enabled = dailyBudgetEnabledInput?.checked ?? false;
  return {
    enabled,
    dailyBudgetKWh: readDailyBudgetKWh(enabled),
    priceShapingEnabled: dailyBudgetPriceShapingInput?.checked ?? true,
    controlledUsageWeight: parseDailyBudgetRatio(
      dailyBudgetControlledWeightInput?.value ?? '',
      CONTROLLED_USAGE_WEIGHT,
    ),
    priceShapingFlexShare: parseDailyBudgetRatio(
      dailyBudgetPriceFlexShareInput?.value ?? '',
      PRICE_SHAPING_FLEX_SHARE,
    ),
  };
};

export const rerenderDailyBudget = () => {
  renderDailyBudget(latestDailyBudgetPayload);
};

export const loadDailyBudgetSettings = async () => {
  const [enabled, dailyBudgetKWh, priceShapingEnabled, controlledWeightRaw, priceFlexShareRaw] = await Promise.all([
    getSetting(DAILY_BUDGET_ENABLED),
    getSetting(DAILY_BUDGET_KWH),
    getSetting(DAILY_BUDGET_PRICE_SHAPING_ENABLED),
    getSetting(DAILY_BUDGET_CONTROLLED_WEIGHT),
    getSetting(DAILY_BUDGET_PRICE_FLEX_SHARE),
  ]);

  applyDailyBudgetBounds();

  if (dailyBudgetEnabledInput) {
    dailyBudgetEnabledInput.checked = enabled === true;
  }
  if (dailyBudgetKwhInput) {
    const raw = typeof dailyBudgetKWh === 'number' ? dailyBudgetKWh : MIN_DAILY_BUDGET_KWH;
    const bounded = Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, raw));
    dailyBudgetKwhInput.value = bounded.toString();
  }
  if (dailyBudgetPriceShapingInput) {
    dailyBudgetPriceShapingInput.checked = priceShapingEnabled !== false;
  }
  if (dailyBudgetControlledWeightInput) {
    dailyBudgetControlledWeightInput.value = parseDailyBudgetRatio(
      typeof controlledWeightRaw === 'number' ? controlledWeightRaw.toString() : '',
      CONTROLLED_USAGE_WEIGHT,
    ).toString();
  }
  if (dailyBudgetPriceFlexShareInput) {
    dailyBudgetPriceFlexShareInput.value = parseDailyBudgetRatio(
      typeof priceFlexShareRaw === 'number' ? priceFlexShareRaw.toString() : '',
      PRICE_SHAPING_FLEX_SHARE,
    ).toString();
  }
  setDailyBudgetModelDirty(false);
};

export const refreshDailyBudgetPlan = async (payloadOverride?: DailyBudgetUiPayload | null) => {
  try {
    const hasExplicitPayload = payloadOverride !== undefined;
    const [payload, combinedPrices] = await Promise.all([
      hasExplicitPayload
        ? Promise.resolve(payloadOverride)
        : callApi<DailyBudgetUiPayload | null>('GET', '/daily_budget'),
      getPricesReadModel().then((prices) => prices.combinedPrices).catch(() => null),
    ]);
    costDisplay = resolveCostDisplay(combinedPrices);
    latestActiveDailyBudgetPayload = payload;
    if (!hasExplicitPayload && showPendingPreview()) return;
    pendingPreview = null;
    renderDailyBudget(payload);
    setDailyBudgetModelDirty(false);
  } catch (error) {
    await logSettingsError('Failed to load daily budget plan', error, 'refreshDailyBudgetPlan');
    renderDailyBudget(null);
  }
};

const previewDailyBudgetModel = async () => {
  const button = dailyBudgetRecomputeButton;
  if (!button) return;
  button.disabled = true;
  if (dailyBudgetApplyButton) dailyBudgetApplyButton.disabled = true;
  if (dailyBudgetDiscardButton) dailyBudgetDiscardButton.disabled = true;
  const previousText = button.textContent || 'Preview changes';
  button.textContent = 'Previewing...';
  try {
    const draft = readDailyBudgetModelDraft();
    const response = await callApi<DailyBudgetModelPreviewResponse | null>(
      'POST',
      SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH,
      draft,
    );
    if (!response?.candidate) throw new Error('Daily budget preview is not available.');
    pendingPreview = response;
    renderDailyBudget(response.candidate);
    if (dailyBudgetApplyButton) {
      dailyBudgetApplyButton.hidden = false;
      dailyBudgetApplyButton.disabled = false;
    }
    if (dailyBudgetDiscardButton) {
      dailyBudgetDiscardButton.hidden = false;
      dailyBudgetDiscardButton.disabled = false;
    }
    await showToast('Previewing daily budget changes.', 'ok');
  } catch (error) {
    pendingPreview = null;
    if (dailyBudgetApplyButton) dailyBudgetApplyButton.hidden = true;
    if (dailyBudgetDiscardButton) dailyBudgetDiscardButton.hidden = true;
    await logSettingsError('Failed to preview daily budget model', error, 'previewDailyBudgetModel');
    await showToastError(error, 'Failed to preview daily budget changes.');
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
};

const applyDailyBudgetModel = async () => {
  const button = dailyBudgetApplyButton;
  if (!button) return;
  button.disabled = true;
  if (dailyBudgetRecomputeButton) dailyBudgetRecomputeButton.disabled = true;
  if (dailyBudgetDiscardButton) dailyBudgetDiscardButton.disabled = true;
  const previousText = button.textContent || 'Apply changes';
  button.textContent = 'Applying...';
  try {
    const draft = pendingPreview?.settings ?? readDailyBudgetModelDraft();
    const payload = await callApi<DailyBudgetUiPayload | null>(
      'POST',
      SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH,
      draft,
    );
    pendingPreview = null;
    latestActiveDailyBudgetPayload = payload;
    await refreshDailyBudgetPlan(payload);
    await showToast('Daily budget model applied.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to apply daily budget model', error, 'applyDailyBudgetModel');
    await showToastError(error, 'Failed to apply daily budget changes.');
  } finally {
    button.disabled = false;
    button.textContent = previousText;
    if (dailyBudgetRecomputeButton) dailyBudgetRecomputeButton.disabled = false;
    if (dailyBudgetDiscardButton) dailyBudgetDiscardButton.disabled = false;
  }
};

const setDailyBudgetView = (view: DailyBudgetView) => {
  if (currentDailyBudgetView === view) return;
  currentDailyBudgetView = view;
  renderDailyBudget(latestDailyBudgetPayload);
};

export const initDailyBudgetHandlers = () => {
  dailyBudgetEnabledInput?.addEventListener('change', markDailyBudgetModelDraftChanged);
  dailyBudgetKwhInput?.addEventListener('change', markDailyBudgetModelDraftChanged);
  dailyBudgetPriceShapingInput?.addEventListener('change', markDailyBudgetModelDraftChanged);
  dailyBudgetRecomputeButton?.addEventListener('click', () => {
    void previewDailyBudgetModel();
  });
  dailyBudgetApplyButton?.addEventListener('click', () => {
    void applyDailyBudgetModel();
  });
  dailyBudgetDiscardButton?.addEventListener('click', () => {
    discardDailyBudgetPreview();
  });
  dailyBudgetForm?.addEventListener('submit', (event) => event.preventDefault());
  const toggleMount = document.getElementById('daily-budget-toggle-mount');
  if (toggleMount) {
    const { element, setActive } = createToggleGroup(
      [
        { value: 'yesterday' as const, label: 'Yesterday' },
        { value: 'today' as const, label: 'Today' },
        { value: 'tomorrow' as const, label: 'Tomorrow' },
      ],
      'Daily budget view',
      setDailyBudgetView,
    );
    toggleMount.replaceWith(element);
    setDailyBudgetToggleActive = setActive;
    setDailyBudgetToggleActive(currentDailyBudgetView);
  }
};
