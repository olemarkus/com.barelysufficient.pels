import type { DailyBudgetDayPayload } from '../../../lib/dailyBudget/dailyBudgetTypes';
import { formatKWh } from './dailyBudgetFormat';
import type { DayViewBar } from './dayViewChart';
import { renderDailyBudgetChartEcharts } from './dailyBudgetChartEcharts';

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
  label: string;
}): DayViewBar => {
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
    label,
  } = params;

  const segments = showBreakdown
    && typeof plannedUncontrolledValue === 'number'
    && typeof plannedControlledValue === 'number'
    ? [
      { value: plannedUncontrolledValue, className: 'day-view-bar__segment--uncontrolled' },
      { value: plannedControlledValue, className: 'day-view-bar__segment--controlled' },
    ]
    : [{ value, className: 'day-view-bar__segment--planned' }];

  const marker = Number.isFinite(actualValue) && currentBucketIndex >= 0 && index <= currentBucketIndex
    ? {
      value: actualValue as number,
      className: 'day-view-marker--actual',
      overWhenGreaterThan: value,
      overClassName: 'is-over',
    }
    : undefined;

  let state: 'past' | 'current' | undefined;
  if (currentBucketIndex >= 0) {
    if (index < currentBucketIndex) state = 'past';
    if (index === currentBucketIndex) state = 'current';
  }

  return {
    label,
    value,
    state,
    segments,
    marker,
    title: buildDailyBudgetBarTitle({
      label,
      plannedKWh: value,
      actualKWh: actualValue,
      actualControlledKWh: actualControlledValue,
      actualUncontrolledKWh: actualUncontrolledValue,
      isCurrent: index === currentBucketIndex,
      plannedUncontrolledKWh: plannedUncontrolledValue,
      plannedControlledKWh: plannedControlledValue,
      showBreakdown,
    }),
  };
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
  const currentBucketIndex = showActual ? payload.currentBucketIndex : -1;

  const bars: DayViewBar[] = planned.map((value, index) => {
    const label = labels[index] ?? '';
    const actualValue = showActual ? actual[index] : undefined;
    const actualControlledValue = showActual ? actualControlled[index] : undefined;
    const actualUncontrolledValue = showActual ? actualUncontrolled[index] : undefined;
    return buildDailyBudgetBar({
      value,
      actualValue,
      actualControlledValue: typeof actualControlledValue === 'number' ? actualControlledValue : undefined,
      actualUncontrolledValue: typeof actualUncontrolledValue === 'number' ? actualUncontrolledValue : undefined,
      plannedUncontrolledValue: showBreakdown ? plannedUncontrolled[index] : undefined,
      plannedControlledValue: showBreakdown ? plannedControlled[index] : undefined,
      showBreakdown,
      index,
      currentBucketIndex,
      label,
    });
  });

  const renderedWithEcharts = renderDailyBudgetChartEcharts({
    bars,
    planned,
    actual,
    plannedUncontrolled,
    plannedControlled,
    labels,
    currentBucketIndex,
    showActual,
    showBreakdown,
    enabled: payload.budget.enabled !== false,
    barsEl,
    labelsEl,
  });

  if (renderedWithEcharts) return;
  barsEl.replaceChildren();
  labelsEl.replaceChildren();
  labelsEl.hidden = true;
};
