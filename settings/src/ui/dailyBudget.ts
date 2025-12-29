import type { DailyBudgetUiPayload } from '../../../lib/dailyBudget/dailyBudgetTypes';
import {
  dailyBudgetForm,
  dailyBudgetEnabledInput,
  dailyBudgetKwhInput,
  dailyBudgetAggressivenessSelect,
  dailyBudgetPriceShapingInput,
  dailyBudgetStatusPill,
  dailyBudgetDay,
  dailyBudgetUsed,
  dailyBudgetAllowed,
  dailyBudgetRemaining,
  dailyBudgetDeviation,
  dailyBudgetPressure,
  dailyBudgetChart,
  dailyBudgetBars,
  dailyBudgetLabels,
  dailyBudgetLegend,
  dailyBudgetEmpty,
  dailyBudgetConfidence,
  dailyBudgetPriceShapingState,
  dailyBudgetFrozen,
  dailyBudgetRefreshButton,
  dailyBudgetResetButton,
} from './dom';
import { callApi, getSetting, setSetting } from './homey';
import { showToast, showToastError } from './toast';
import { logSettingsError } from './logging';
import {
  DAILY_BUDGET_AGGRESSIVENESS,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_RESET,
} from '../../../lib/utils/settingsKeys';

const formatKWh = (value: number, digits = 2) => (
  Number.isFinite(value) ? `${value.toFixed(digits)} kWh` : '-- kWh'
);
const formatSignedKWh = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return '-- kWh';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)} kWh`;
};
const formatPercent = (value: number) => (
  Number.isFinite(value) ? `${Math.round(value * 100)}%` : '--%'
);

const MIN_DAILY_BUDGET_KWH = 20;
const MAX_DAILY_BUDGET_KWH = 360;

let priceOptimizationEnabled = true;

const applyDailyBudgetBounds = () => {
  if (!dailyBudgetKwhInput) return;
  dailyBudgetKwhInput.min = MIN_DAILY_BUDGET_KWH.toString();
  dailyBudgetKwhInput.max = MAX_DAILY_BUDGET_KWH.toString();
};

const setPillState = (enabled: boolean, exceeded: boolean) => {
  if (!dailyBudgetStatusPill) return;
  dailyBudgetStatusPill.classList.remove('ok', 'warn');
  if (!enabled) {
    dailyBudgetStatusPill.textContent = 'Disabled';
    return;
  }
  if (exceeded) {
    dailyBudgetStatusPill.textContent = 'Exceeded';
    dailyBudgetStatusPill.classList.add('warn');
    return;
  }
  dailyBudgetStatusPill.textContent = 'On track';
  dailyBudgetStatusPill.classList.add('ok');
};

const setChipState = (element: HTMLElement, label: string, active?: boolean, alert?: boolean) => {
  const el = element;
  el.textContent = label;
  el.classList.remove('chip--ok', 'chip--alert');
  if (active) el.classList.add('chip--ok');
  if (alert) el.classList.add('chip--alert');
};

const resolveLabelEvery = (count: number) => {
  if (count >= 24) return 4;
  if (count >= 16) return 3;
  if (count >= 12) return 2;
  return 1;
};

const renderDailyBudgetChart = (payload: DailyBudgetUiPayload) => {
  if (!dailyBudgetBars || !dailyBudgetLabels) return;
  const planned = payload.buckets.plannedKWh || [];
  const actual = payload.buckets.actualKWh || [];
  const labels = payload.buckets.startLocalLabels || [];
  const count = planned.length;
  dailyBudgetBars.innerHTML = '';
  dailyBudgetLabels.innerHTML = '';

  const maxPlanned = planned.reduce((max, value) => Math.max(max, value), 0);
  const maxActual = actual.reduce((max, value) => (
    Number.isFinite(value) ? Math.max(max, value) : max
  ), 0);
  const maxValue = Math.max(maxPlanned, maxActual);
  const labelEvery = resolveLabelEvery(count);

  planned.forEach((value, index) => {
    const bar = document.createElement('div');
    bar.className = 'daily-budget-bar';
    if (index < payload.currentBucketIndex) bar.classList.add('is-past');
    if (index === payload.currentBucketIndex) bar.classList.add('is-current');

    const fill = document.createElement('div');
    fill.className = 'daily-budget-bar__fill';
    const heightPct = maxValue > 0 ? (value / maxValue) * 100 : 0;
    fill.style.height = value > 0 ? `${Math.max(2, heightPct)}%` : '0%';
    bar.appendChild(fill);

    const actualValue = actual[index];
    const showActual = Number.isFinite(actualValue) && index <= payload.currentBucketIndex;
    if (showActual) {
      const dot = document.createElement('div');
      dot.className = 'daily-budget-dot';
      if (actualValue > value + 0.001) dot.classList.add('is-over');
      const actualPct = maxValue > 0 ? (actualValue / maxValue) * 100 : 0;
      dot.style.bottom = `${Math.max(0, Math.min(100, actualPct))}%`;
      bar.appendChild(dot);
    }

    const label = labels[index] ?? '';
    const titleParts = [];
    if (label) titleParts.push(label);
    titleParts.push(`Planned ${formatKWh(value)}`);
    if (Number.isFinite(actualValue)) {
      const actualLabel = index === payload.currentBucketIndex ? 'Actual so far' : 'Actual';
      titleParts.push(`${actualLabel} ${formatKWh(actualValue)}`);
    }
    bar.title = titleParts.join(' · ');

    dailyBudgetBars.appendChild(bar);

    const axisLabel = document.createElement('div');
    axisLabel.className = 'daily-budget-label';
    axisLabel.textContent = (index % labelEvery === 0 || index === count - 1) ? label : '';
    dailyBudgetLabels.appendChild(axisLabel);
  });

  if (count === 0) return;
};

const renderDailyBudgetEmptyState = () => {
  if (!dailyBudgetChart || !dailyBudgetEmpty) return;
  dailyBudgetEmpty.hidden = false;
  dailyBudgetChart.hidden = true;
  if (dailyBudgetLegend) dailyBudgetLegend.hidden = true;
  setPillState(false, false);
  if (dailyBudgetDay) dailyBudgetDay.textContent = '--';
  if (dailyBudgetUsed) dailyBudgetUsed.textContent = '-- kWh';
  if (dailyBudgetAllowed) dailyBudgetAllowed.textContent = '-- kWh';
  if (dailyBudgetRemaining) dailyBudgetRemaining.textContent = '-- kWh';
  if (dailyBudgetDeviation) dailyBudgetDeviation.textContent = '-- kWh';
  if (dailyBudgetDeviation) dailyBudgetDeviation.removeAttribute('title');
  if (dailyBudgetPressure) dailyBudgetPressure.textContent = '--%';
  if (dailyBudgetConfidence) setChipState(dailyBudgetConfidence, 'Confidence --');
  if (dailyBudgetPriceShapingState) setChipState(dailyBudgetPriceShapingState, 'Price shaping --');
  if (dailyBudgetFrozen) {
    dailyBudgetFrozen.hidden = true;
    dailyBudgetFrozen.removeAttribute('title');
  }
};

const renderDailyBudgetHeader = (payload: DailyBudgetUiPayload) => {
  if (dailyBudgetDay) {
    dailyBudgetDay.textContent = `${payload.dateKey} · ${payload.timeZone}`;
  }
  setPillState(payload.budget.enabled, payload.state.exceeded);
};

const renderDailyBudgetStats = (payload: DailyBudgetUiPayload) => {
  if (dailyBudgetUsed) dailyBudgetUsed.textContent = formatKWh(payload.state.usedNowKWh);
  if (dailyBudgetAllowed) dailyBudgetAllowed.textContent = formatKWh(payload.state.allowedNowKWh);
  if (dailyBudgetRemaining) dailyBudgetRemaining.textContent = formatKWh(payload.state.remainingKWh);
  if (dailyBudgetDeviation) {
    const deviation = payload.state.usedNowKWh - payload.state.allowedNowKWh;
    dailyBudgetDeviation.textContent = formatSignedKWh(deviation);
    dailyBudgetDeviation.title = 'Deviation = used minus allowed so far. Positive means over plan.';
  }
  if (dailyBudgetPressure) dailyBudgetPressure.textContent = formatPercent(payload.state.pressure);
};

const renderDailyBudgetChips = (payload: DailyBudgetUiPayload) => {
  if (dailyBudgetConfidence) {
    const confidenceLabel = `Confidence ${formatPercent(payload.state.confidence)}`;
    setChipState(dailyBudgetConfidence, confidenceLabel, payload.state.confidence >= 0.5);
  }
  if (dailyBudgetPriceShapingState) {
    const priceShapingEnabled = payload.budget.priceShapingEnabled;
    const priceOptimizationOn = priceOptimizationEnabled;
    let label = 'Price shaping off';
    let active = false;
    let alert = false;

    if (!priceShapingEnabled) {
      label = 'Price shaping off';
    } else if (!priceOptimizationOn) {
      label = 'Requires price optimization';
    } else if (!payload.state.priceShapingActive) {
      label = 'Waiting for prices';
      alert = payload.budget.enabled;
    } else {
      label = 'Price shaping on';
      active = true;
    }

    setChipState(dailyBudgetPriceShapingState, label, active, alert);
  }
  if (dailyBudgetFrozen) {
    dailyBudgetFrozen.hidden = !payload.state.frozen;
    if (payload.state.frozen) {
      setChipState(dailyBudgetFrozen, 'Plan frozen', false, true);
      dailyBudgetFrozen.title = 'Plan frozen while over plan; resumes once you are back under.';
    } else {
      dailyBudgetFrozen.removeAttribute('title');
    }
  }
};

const renderDailyBudget = (payload: DailyBudgetUiPayload | null) => {
  if (!dailyBudgetChart || !dailyBudgetEmpty) return;
  if (!payload) {
    renderDailyBudgetEmptyState();
    return;
  }

  dailyBudgetEmpty.hidden = true;
  dailyBudgetChart.hidden = false;
  if (dailyBudgetLegend) dailyBudgetLegend.hidden = false;
  dailyBudgetChart.classList.toggle('is-disabled', !payload.budget.enabled);

  renderDailyBudgetHeader(payload);
  renderDailyBudgetStats(payload);
  renderDailyBudgetChips(payload);
  renderDailyBudgetChart(payload);
};

export const loadDailyBudgetSettings = async () => {
  const [enabled, dailyBudgetKWh, aggressiveness, priceShapingEnabled] = await Promise.all([
    getSetting(DAILY_BUDGET_ENABLED),
    getSetting(DAILY_BUDGET_KWH),
    getSetting(DAILY_BUDGET_AGGRESSIVENESS),
    getSetting(DAILY_BUDGET_PRICE_SHAPING_ENABLED),
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
  if (dailyBudgetAggressivenessSelect) {
    dailyBudgetAggressivenessSelect.value = typeof aggressiveness === 'string' ? aggressiveness : 'balanced';
  }
  if (dailyBudgetPriceShapingInput) {
    dailyBudgetPriceShapingInput.checked = priceShapingEnabled !== false;
  }
};

export const saveDailyBudgetSettings = async () => {
  const enabled = dailyBudgetEnabledInput?.checked ?? false;
  const kwhValue = parseFloat(dailyBudgetKwhInput?.value || '0');
  if (!Number.isFinite(kwhValue) || kwhValue < 0) {
    throw new Error('Daily budget must be a non-negative number.');
  }
  if (enabled && (kwhValue < MIN_DAILY_BUDGET_KWH || kwhValue > MAX_DAILY_BUDGET_KWH)) {
    throw new Error(`Daily budget must be between ${MIN_DAILY_BUDGET_KWH} and ${MAX_DAILY_BUDGET_KWH} kWh.`);
  }
  const boundedKwh = Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, kwhValue));
  const aggressiveness = dailyBudgetAggressivenessSelect?.value || 'balanced';
  const priceShapingEnabled = dailyBudgetPriceShapingInput?.checked ?? true;

  await setSetting(DAILY_BUDGET_ENABLED, enabled);
  await setSetting(DAILY_BUDGET_KWH, boundedKwh);
  await setSetting(DAILY_BUDGET_AGGRESSIVENESS, aggressiveness);
  await setSetting(DAILY_BUDGET_PRICE_SHAPING_ENABLED, priceShapingEnabled);
  await showToast('Daily budget settings saved.', 'ok');
};

export const refreshDailyBudgetPlan = async () => {
  try {
    const [payload, priceOptEnabled] = await Promise.all([
      callApi<DailyBudgetUiPayload | null>('GET', '/daily_budget'),
      getSetting('price_optimization_enabled').catch(() => undefined),
    ]);
    if (priceOptEnabled !== undefined) {
      priceOptimizationEnabled = priceOptEnabled !== false;
    }
    renderDailyBudget(payload);
  } catch (error) {
    await logSettingsError('Failed to load daily budget plan', error, 'refreshDailyBudgetPlan');
    renderDailyBudget(null);
  }
};

const handleDailyBudgetReset = async () => {
  try {
    await setSetting(DAILY_BUDGET_RESET, Date.now());
    await showToast('Daily budget learning reset.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to reset daily budget learning', error, 'dailyBudgetReset');
    await showToastError(error, 'Failed to reset daily budget learning.');
  }
};

export const initDailyBudgetHandlers = () => {
  const autoSave = async () => {
    try {
      await saveDailyBudgetSettings();
    } catch (error) {
      await logSettingsError('Failed to save daily budget settings', error, 'autoSaveDailyBudget');
      await showToastError(error, 'Failed to save daily budget settings.');
    }
  };

  dailyBudgetEnabledInput?.addEventListener('change', autoSave);
  dailyBudgetKwhInput?.addEventListener('change', autoSave);
  dailyBudgetAggressivenessSelect?.addEventListener('change', autoSave);
  dailyBudgetPriceShapingInput?.addEventListener('change', autoSave);
  dailyBudgetForm?.addEventListener('submit', (event) => event.preventDefault());

  dailyBudgetRefreshButton?.addEventListener('click', async () => {
    await refreshDailyBudgetPlan();
  });

  dailyBudgetResetButton?.addEventListener('click', async () => {
    await handleDailyBudgetReset();
  });
};
