import type {
  ConfidenceDebug,
  DailyBudgetDayPayload,
  DailyBudgetExplainability,
} from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  dailyBudgetAllowed,
  dailyBudgetConfidence,
  dailyBudgetDeviation,
  dailyBudgetExemptChip,
  dailyBudgetExplainList,
  dailyBudgetHeadline,
  dailyBudgetLimiterChip,
  dailyBudgetRemaining,
  dailyBudgetShapingChip,
  dailyBudgetSummaryText,
  dailyBudgetUsed,
} from './dom.ts';
import { formatKWh, formatSignedKWh } from './dailyBudgetFormat.ts';
import { setTooltip } from './tooltips.ts';

const formatKw = (value: number | null | undefined) => (
  Number.isFinite(value) ? `${(value as number).toFixed(1)} kW` : '--'
);

const formatPercent = (value: number | null | undefined) => (
  Number.isFinite(value) ? `${Math.round((value as number) * 100)}%` : '--'
);

const setText = (element: HTMLElement | null, text: string) => {
  const target = element;
  if (target) target.textContent = text;
};

const setChipTone = (element: HTMLElement | null, tone: 'ok' | 'neutral' | 'alert') => {
  if (!element) return;
  element.classList.remove('chip--ok', 'chip--neutral', 'chip--alert');
  if (tone === 'ok') element.classList.add('chip--ok');
  if (tone === 'alert') element.classList.add('chip--alert');
  if (tone === 'neutral') element.classList.add('chip--neutral');
};

const getFallbackLimiterLabel = (payload: DailyBudgetDayPayload) => {
  if (payload.state.exceeded) return 'Daily budget is tightening this hour';
  if (payload.budget.enabled) return 'Hourly capacity still leads';
  return 'Capacity limit only';
};

const getFallbackHeadline = (payload: DailyBudgetDayPayload) => {
  if (payload.state.remainingKWh >= 0) {
    return `${formatKWh(payload.state.remainingKWh)} left today`;
  }
  return `${formatKWh(Math.abs(payload.state.remainingKWh))} over today's target`;
};

const getFallbackSummary = (payload: DailyBudgetDayPayload) => {
  if (payload.state.exceeded) {
    return 'PELS is trying to slow the rest of the day down without overriding hourly protection.';
  }
  return 'PELS can still spread the remaining budget across the cheaper and quieter parts of the day.';
};

const buildFallbackExplainability = (payload: DailyBudgetDayPayload): DailyBudgetExplainability => {
  const currentHourPlan = payload.buckets.plannedKWh[payload.currentBucketIndex] ?? null;
  const priceEffectLabel = payload.state.priceShapingActive
    ? 'Shifting flexible load toward cheaper hours'
    : 'Keeping today close to its learned pattern';
  const baseLoadSeries = payload.buckets.plannedUncontrolledKWh ?? payload.buckets.plannedKWh;
  const currentPlannedKWh = payload.buckets.plannedKWh[payload.currentBucketIndex] ?? 0;

  return {
    headline: getFallbackHeadline(payload),
    summary: getFallbackSummary(payload),
    currentLimiterLabel: getFallbackLimiterLabel(payload),
    currentLimiterDetail: payload.state.exceeded
      ? 'The daily plan is stricter than the hourly soft limit right now.'
      : 'The hourly soft limit is still the tighter constraint for this hour.',
    effectiveSoftLimitKw: currentHourPlan !== null ? Math.max(0.6, currentHourPlan * 2.6) : null,
    hourlySoftLimitKw: currentHourPlan !== null ? Math.max(0.8, currentHourPlan * 2.9) : null,
    dailySoftLimitKw: currentHourPlan !== null ? Math.max(0.5, currentHourPlan * 2.3) : null,
    hardCapKw: currentHourPlan !== null ? Math.max(1.0, currentHourPlan * 3.2) : null,
    budgetExemptKWh: 1.3,
    baseLoadKWh: baseLoadSeries[payload.currentBucketIndex] ?? null,
    flexibleLoadKWh: payload.buckets.plannedControlledKWh?.[payload.currentBucketIndex]
      ?? (currentPlannedKWh * 0.35),
    priceEffectLabel,
    priceEffectDetail: payload.state.priceShapingActive
      ? 'Only the movable part of the plan is being nudged toward cheaper hours.'
      : 'Price spread is too small or price shaping is off, so the plan stays closer to normal usage.',
    notes: payload.state.exceeded
      ? ['You are ahead of the allowed curve, so restores may wait longer this hour.']
      : ['You are still within the planned curve, so capacity remains the main limiter.'],
  };
};

const resolveExplainability = (payload: DailyBudgetDayPayload) => (
  payload.explainability ?? buildFallbackExplainability(payload)
);

const renderBudgetExplainability = (payload: DailyBudgetDayPayload) => {
  if (!dailyBudgetExplainList) return;

  const explainability = resolveExplainability(payload);
  const rows = [
    [
      'Current limiter',
      explainability.currentLimiterLabel ?? '--',
      explainability.currentLimiterDetail,
    ],
    [
      'Effective soft limit',
      formatKw(explainability.effectiveSoftLimitKw),
      'The planner uses the smaller of the hourly and daily soft limits.',
    ],
    [
      'Hourly soft limit',
      formatKw(explainability.hourlySoftLimitKw),
      'Capacity protection for this hour before the daily budget tightens it.',
    ],
    [
      'Daily soft limit',
      formatKw(explainability.dailySoftLimitKw),
      'The daily budget pacing limit for the current hour.',
    ],
    [
      'Hard cap',
      formatKw(explainability.hardCapKw),
      'The daily budget never lets the plan exceed this.',
    ],
    [
      'Typical base load',
      formatKWh(explainability.baseLoadKWh),
      'Energy PELS expects to happen even without moving flexible devices.',
    ],
    [
      'Flexible load',
      formatKWh(explainability.flexibleLoadKWh),
      'The share of the plan that can move around the day.',
    ],
    [
      'Budget-exempt load',
      formatKWh(explainability.budgetExemptKWh),
      'Still real usage, but skipped by daily-budget control decisions.',
    ],
    [
      'Price effect',
      explainability.priceEffectLabel ?? '--',
      explainability.priceEffectDetail,
    ],
  ] as const;

  dailyBudgetExplainList.replaceChildren();
  rows.forEach(([label, value, detail]) => {
    const row = document.createElement('div');
    row.className = 'budget-insight-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'budget-insight-row__label';
    labelEl.textContent = label;

    const valueEl = document.createElement('strong');
    valueEl.className = 'budget-insight-row__value';
    valueEl.textContent = value;

    row.append(labelEl, valueEl);
    dailyBudgetExplainList.appendChild(row);

    if (!detail) return;
    const detailEl = document.createElement('p');
    detailEl.className = 'budget-insight-row__detail muted';
    detailEl.textContent = detail;
    dailyBudgetExplainList.appendChild(detailEl);
  });

  (explainability.notes ?? []).forEach((note) => {
    const noteEl = document.createElement('p');
    noteEl.className = 'budget-insight-note';
    noteEl.textContent = note;
    dailyBudgetExplainList.appendChild(noteEl);
  });
};

const getConfidenceTone = (value: number) => {
  if (value >= 0.7) return 'good';
  if (value >= 0.45) return 'mixed';
  return 'low';
};

const getConfidenceLabel = (value: number) => {
  if (value >= 0.7) return 'High confidence';
  if (value >= 0.45) return 'Medium confidence';
  return 'Still learning';
};

const getConfidenceDetail = (validDays: number) => (
  validDays >= 14
    ? 'Plenty of recent history is available.'
    : 'More stable days will make this forecast firmer.'
);

const buildConfidenceMarkup = (value: number, debug?: ConfidenceDebug | null) => {
  const regularity = debug?.confidenceRegularity ?? value;
  const adaptability = debug?.confidenceAdaptability ?? value;
  const validDays = debug?.confidenceValidActualDays ?? 0;
  const validPlannedDays = debug?.confidenceValidPlannedDays ?? 0;
  const confidenceRange = `${formatPercent(debug?.confidenceBootstrapLow)}`
    + `–${formatPercent(debug?.confidenceBootstrapHigh)}`;

  return `
    <div class="budget-confidence__hero">
      <span class="budget-confidence__score budget-confidence__score--${getConfidenceTone(value)}">
        ${formatPercent(value)}
      </span>
      <div>
        <strong>${getConfidenceLabel(value)}</strong>
        <p class="muted">${getConfidenceDetail(validDays)}</p>
      </div>
    </div>
    <div class="budget-confidence__rows">
      <div class="budget-confidence__row">
        <span>Usage regularity</span><strong>${formatPercent(regularity)}</strong>
      </div>
      <div class="budget-confidence__row">
        <span>Load-shift evidence</span><strong>${formatPercent(adaptability)}</strong>
      </div>
      <div class="budget-confidence__row">
        <span>Valid days</span><strong>${validDays} actual / ${validPlannedDays} planned</strong>
      </div>
      <div class="budget-confidence__row">
        <span>Expected range</span><strong>${confidenceRange}</strong>
      </div>
    </div>
  `;
};

const renderConfidence = (value: number | null, debug?: ConfidenceDebug | null) => {
  if (!dailyBudgetConfidence) return;
  if (value === null || !Number.isFinite(value)) {
    dailyBudgetConfidence.hidden = true;
    dailyBudgetConfidence.replaceChildren();
    return;
  }

  dailyBudgetConfidence.hidden = false;
  dailyBudgetConfidence.innerHTML = buildConfidenceMarkup(value, debug);
  setTooltip(
    dailyBudgetConfidence,
    'Confidence blends how regular your daily usage looks and'
      + ' how well past days followed shifted plans.',
  );
};

const renderBudgetHero = (payload: DailyBudgetDayPayload) => {
  const explainability = resolveExplainability(payload);
  const shapingLabel = explainability.priceEffectLabel
    ?? (payload.state.priceShapingActive ? 'Active' : 'Minimal');
  const exemptKWh = explainability.budgetExemptKWh ?? 0;

  setText(dailyBudgetHeadline, explainability.headline ?? getFallbackHeadline(payload));
  setText(
    dailyBudgetSummaryText,
    explainability.summary
      ?? 'PELS is combining the daily budget, hourly protection, and'
        + ' price shape to decide how much flexibility is left.',
  );
  setText(dailyBudgetUsed, formatKWh(payload.state.usedNowKWh));
  setText(dailyBudgetAllowed, formatKWh(payload.state.allowedNowKWh));
  setText(dailyBudgetRemaining, formatKWh(payload.state.remainingKWh));
  setText(dailyBudgetDeviation, formatSignedKWh(payload.state.deviationKWh));
  setText(
    dailyBudgetLimiterChip,
    `Current limiter: ${explainability.currentLimiterLabel ?? '--'}`,
  );
  setText(dailyBudgetShapingChip, `Price influence: ${shapingLabel}`);
  setText(
    dailyBudgetExemptChip,
    `Budget-exempt load: ${formatKWh(explainability.budgetExemptKWh)}`,
  );

  setChipTone(dailyBudgetLimiterChip, payload.state.exceeded ? 'alert' : 'neutral');
  setChipTone(dailyBudgetShapingChip, payload.state.priceShapingActive ? 'ok' : 'neutral');
  setChipTone(dailyBudgetExemptChip, exemptKWh > 0 ? 'neutral' : 'ok');
};

export const resetDailyBudgetStory = () => {
  setText(dailyBudgetHeadline, 'Daily plan is unavailable');
  setText(
    dailyBudgetSummaryText,
    'PELS needs live power, prices, and daily-budget data before it can explain the pacing plan.',
  );
  if (dailyBudgetExplainList) dailyBudgetExplainList.replaceChildren();
  if (dailyBudgetConfidence) {
    dailyBudgetConfidence.replaceChildren();
    dailyBudgetConfidence.hidden = true;
  }
  setText(dailyBudgetUsed, '-- kWh');
  setText(dailyBudgetAllowed, '-- kWh');
  setText(dailyBudgetRemaining, '-- kWh');
  setText(dailyBudgetDeviation, '-- kWh');
  setText(dailyBudgetLimiterChip, 'Current limiter: --');
  setText(dailyBudgetShapingChip, 'Price influence: --');
  setText(dailyBudgetExemptChip, 'Budget-exempt load: --');
};

export const renderDailyBudgetStory = (payload: DailyBudgetDayPayload) => {
  renderBudgetHero(payload);
  renderBudgetExplainability(payload);
  renderConfidence(payload.state.confidence, payload.state.confidenceDebug);
};
