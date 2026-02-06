import type { DailyBudgetDayPayload } from '../../../lib/dailyBudget/dailyBudgetTypes';
import { setTooltip } from './tooltips';
import { formatKWh } from './dailyBudgetFormat';

const resolveLabelEvery = (count: number) => {
  if (count >= 24) return 4;
  if (count >= 16) return 3;
  if (count >= 12) return 2;
  return 1;
};

const formatHourLabel = (label: string) => {
  if (!label) return '';
  const trimmed = label.trim();
  if (!trimmed) return '';
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex > 0) return trimmed.slice(0, separatorIndex);
  return trimmed;
};

const getChartMaxValue = (planned: number[], actual: number[]) => {
  const maxPlanned = planned.reduce((max, value) => Math.max(max, value), 0);
  const maxActual = actual.reduce((max, value) => (
    Number.isFinite(value) ? Math.max(max, value) : max
  ), 0);
  return Math.max(maxPlanned, maxActual);
};

const buildDailyBudgetBarTitle = (params: {
  label: string;
  plannedKWh: number;
  actualKWh: number | undefined;
  actualControlledKWh?: number;
  actualUncontrolledKWh?: number;
  isCurrent: boolean;
  plannedUncontrolledKWh?: number;
  plannedControlledKWh?: number;
  showBreakdown: boolean;
}) => {
  const {
    label,
    plannedKWh,
    actualKWh,
    actualControlledKWh,
    actualUncontrolledKWh,
    isCurrent,
    plannedUncontrolledKWh,
    plannedControlledKWh,
    showBreakdown,
  } = params;
  const titleParts = [];
  if (label) titleParts.push(label);
  titleParts.push(`Planned ${formatKWh(plannedKWh)}`);
  if (showBreakdown
    && typeof plannedUncontrolledKWh === 'number'
    && typeof plannedControlledKWh === 'number') {
    titleParts.push(`Uncontrolled ${formatKWh(plannedUncontrolledKWh)}`);
    titleParts.push(`Controlled ${formatKWh(plannedControlledKWh)}`);
  }
  const hasActualSplit = Number.isFinite(actualControlledKWh) && Number.isFinite(actualUncontrolledKWh);
  if (hasActualSplit) {
    const actualLabel = isCurrent ? 'Actual so far' : 'Actual';
    titleParts.push(`${actualLabel} controlled ${formatKWh(actualControlledKWh as number)}`);
    titleParts.push(`${actualLabel} uncontrolled ${formatKWh(actualUncontrolledKWh as number)}`);
  } else if (Number.isFinite(actualKWh)) {
    const actualLabel = isCurrent ? 'Actual so far' : 'Actual';
    titleParts.push(`${actualLabel} ${formatKWh(actualKWh as number)}`);
  }
  return titleParts.join(' \u00B7 ');
};

const applyBarState = (bar: HTMLDivElement, index: number, currentBucketIndex: number) => {
  if (currentBucketIndex < 0) return;
  if (index < currentBucketIndex) {
    bar.classList.add('is-past');
    return;
  }
  if (index === currentBucketIndex) {
    bar.classList.add('is-current');
  }
};

const buildStackFill = () => {
  const fill = document.createElement('div');
  fill.className = 'daily-budget-bar__segment daily-budget-bar__segment--planned';
  fill.style.height = '100%';
  return fill;
};

const buildBreakdownSegments = (uncontrolled: number, controlled: number) => {
  const total = uncontrolled + controlled;
  const uncontrolledShare = total > 0 ? uncontrolled / total : 0;
  const controlledShare = total > 0 ? controlled / total : 0;

  const uncontrolledSegment = document.createElement('div');
  uncontrolledSegment.className = 'daily-budget-bar__segment daily-budget-bar__segment--uncontrolled';
  uncontrolledSegment.style.height = `${Math.max(0, uncontrolledShare * 100)}%`;

  const controlledSegment = document.createElement('div');
  controlledSegment.className = 'daily-budget-bar__segment daily-budget-bar__segment--controlled';
  controlledSegment.style.height = `${Math.max(0, controlledShare * 100)}%`;

  return { uncontrolledSegment, controlledSegment };
};

const buildBarStack = (params: {
  value: number;
  maxValue: number;
  showBreakdown: boolean;
  plannedUncontrolledValue?: number;
  plannedControlledValue?: number;
}) => {
  const {
    value,
    maxValue,
    showBreakdown,
    plannedUncontrolledValue,
    plannedControlledValue,
  } = params;
  const stack = document.createElement('div');
  stack.className = 'daily-budget-bar__stack';
  const heightPct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  stack.style.height = value > 0 ? `${Math.max(2, heightPct)}%` : '0%';

  if (showBreakdown
    && typeof plannedUncontrolledValue === 'number'
    && typeof plannedControlledValue === 'number') {
    const { uncontrolledSegment, controlledSegment } = buildBreakdownSegments(
      plannedUncontrolledValue,
      plannedControlledValue,
    );
    stack.appendChild(uncontrolledSegment);
    stack.appendChild(controlledSegment);
    return stack;
  }

  stack.appendChild(buildStackFill());
  return stack;
};

const appendActualDot = (params: {
  bar: HTMLDivElement;
  actualValue: number | undefined;
  plannedValue: number;
  maxValue: number;
  index: number;
  currentBucketIndex: number;
}) => {
  const {
    bar,
    actualValue,
    plannedValue,
    maxValue,
    index,
    currentBucketIndex,
  } = params;
  const showActual = Number.isFinite(actualValue) && currentBucketIndex >= 0 && index <= currentBucketIndex;
  if (!showActual) return;
  const dot = document.createElement('div');
  dot.className = 'daily-budget-dot';
  if ((actualValue as number) > plannedValue + 0.001) dot.classList.add('is-over');
  const actualPct = maxValue > 0 ? ((actualValue as number) / maxValue) * 100 : 0;
  dot.style.bottom = `${Math.max(0, Math.min(100, actualPct))}%`;
  bar.appendChild(dot);
};

const buildDailyBudgetBar = (params: {
  value: number;
  actualValue: number | undefined;
  actualControlledValue?: number;
  actualUncontrolledValue?: number;
  plannedUncontrolledValue?: number;
  plannedControlledValue?: number;
  showBreakdown: boolean;
  index: number;
  currentBucketIndex: number;
  maxValue: number;
  label: string;
}) => {
  const {
    value,
    actualValue,
    actualControlledValue,
    actualUncontrolledValue,
    plannedUncontrolledValue,
    plannedControlledValue,
    showBreakdown,
    index,
    currentBucketIndex,
    maxValue,
    label,
  } = params;
  const bar = document.createElement('div');
  bar.className = 'daily-budget-bar';
  applyBarState(bar, index, currentBucketIndex);

  bar.appendChild(buildBarStack({
    value,
    maxValue,
    showBreakdown,
    plannedUncontrolledValue,
    plannedControlledValue,
  }));

  appendActualDot({
    bar,
    actualValue,
    plannedValue: value,
    maxValue,
    index,
    currentBucketIndex,
  });

  setTooltip(bar, buildDailyBudgetBarTitle({
    label,
    plannedKWh: value,
    actualKWh: actualValue,
    actualControlledKWh: actualControlledValue,
    actualUncontrolledKWh: actualUncontrolledValue,
    isCurrent: index === currentBucketIndex,
    plannedUncontrolledKWh: plannedUncontrolledValue,
    plannedControlledKWh: plannedControlledValue,
    showBreakdown,
  }));

  return bar;
};

const buildDailyBudgetAxisLabel = (params: {
  label: string;
  index: number;
  count: number;
  labelEvery: number;
}) => {
  const { label, index, count, labelEvery } = params;
  const axisLabel = document.createElement('div');
  axisLabel.className = 'daily-budget-label';
  const shortLabel = formatHourLabel(label);
  axisLabel.textContent = (index % labelEvery === 0 || index === count - 1) ? shortLabel : '';
  if (shortLabel && label && shortLabel !== label) {
    setTooltip(axisLabel, label);
  }
  return axisLabel;
};

export const renderDailyBudgetChart = (params: {
  payload: DailyBudgetDayPayload;
  showActual: boolean;
  showBreakdown: boolean;
  barsEl: HTMLElement;
  labelsEl: HTMLElement;
}) => {
  const {
    payload,
    showActual,
    showBreakdown,
    barsEl,
    labelsEl,
  } = params;
  const planned = payload.buckets.plannedKWh || [];
  const actual = showActual ? payload.buckets.actualKWh || [] : [];
  const actualControlled = showActual ? payload.buckets.actualControlledKWh || [] : [];
  const actualUncontrolled = showActual ? payload.buckets.actualUncontrolledKWh || [] : [];
  const plannedUncontrolled = payload.buckets.plannedUncontrolledKWh || [];
  const plannedControlled = payload.buckets.plannedControlledKWh || [];
  const labels = payload.buckets.startLocalLabels || [];
  const count = planned.length;
  barsEl.innerHTML = '';
  labelsEl.innerHTML = '';

  const maxValue = getChartMaxValue(planned, actual);
  const labelEvery = resolveLabelEvery(count);
  const currentBucketIndex = showActual ? payload.currentBucketIndex : -1;

  planned.forEach((value, index) => {
    const label = labels[index] ?? '';
    const actualValue = showActual ? actual[index] : undefined;
    const actualControlledValue = showActual ? actualControlled[index] : undefined;
    const actualUncontrolledValue = showActual ? actualUncontrolled[index] : undefined;
    const bar = buildDailyBudgetBar({
      value,
      actualValue,
      actualControlledValue: typeof actualControlledValue === 'number' ? actualControlledValue : undefined,
      actualUncontrolledValue: typeof actualUncontrolledValue === 'number' ? actualUncontrolledValue : undefined,
      plannedUncontrolledValue: showBreakdown ? plannedUncontrolled[index] : undefined,
      plannedControlledValue: showBreakdown ? plannedControlled[index] : undefined,
      showBreakdown,
      index,
      currentBucketIndex,
      maxValue,
      label,
    });
    barsEl.appendChild(bar);
    labelsEl.appendChild(buildDailyBudgetAxisLabel({
      label,
      index,
      count,
      labelEvery,
    }));
  });
};
