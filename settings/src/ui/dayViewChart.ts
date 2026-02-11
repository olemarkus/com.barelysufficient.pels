import { setTooltip } from './tooltips';

export type DayViewBarState = 'past' | 'current' | 'warn';

export type DayViewSegment = {
  value: number;
  className?: string;
};

export type DayViewMarker = {
  value: number;
  className?: string;
  overWhenGreaterThan?: number;
  overClassName?: string;
};

export type DayViewBar = {
  label: string;
  shortLabel?: string;
  value: number;
  state?: DayViewBarState;
  title?: string;
  className?: string;
  stackClassName?: string;
  segments?: DayViewSegment[];
  marker?: DayViewMarker;
};

export type RenderDayViewChartParams = {
  bars: DayViewBar[];
  barsEl: HTMLElement;
  labelsEl: HTMLElement;
  maxValue?: number;
  minBarHeightPct?: number;
  labelEvery?: number;
  barClassName?: string;
  stackClassName?: string;
  labelClassName?: string;
  formatShortLabel?: (label: string) => string;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const resolveLabelEvery = (count: number) => {
  if (count >= 24) return 4;
  if (count >= 16) return 3;
  if (count >= 12) return 2;
  return 1;
};

export const formatHourAxisLabel = (label: string) => {
  if (!label) return '';
  const trimmed = label.trim();
  if (!trimmed) return '';
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex > 0) return trimmed.slice(0, separatorIndex);
  return trimmed;
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

export const getDayViewChartMaxValue = (bars: DayViewBar[]): number => (
  bars.reduce((max, bar) => {
    const markerValue = isFiniteNumber(bar.marker?.value) ? bar.marker.value : 0;
    return Math.max(max, bar.value, markerValue);
  }, 0)
);

const applyBarState = (barEl: HTMLElement, state?: DayViewBarState) => {
  if (state === 'past') barEl.classList.add('is-past');
  if (state === 'current') barEl.classList.add('is-current');
  if (state === 'warn') barEl.classList.add('is-warn');
};

const appendSegments = (stack: HTMLElement, bar: DayViewBar) => {
  const segments = bar.segments ?? [];
  if (segments.length === 0) {
    const segment = document.createElement('div');
    segment.className = 'day-view-bar__segment day-view-bar__segment--primary';
    segment.style.height = '100%';
    stack.appendChild(segment);
    return;
  }

  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  segments.forEach((segment) => {
    const segmentEl = document.createElement('div');
    segmentEl.className = ['day-view-bar__segment', segment.className].filter(Boolean).join(' ');
    const heightPct = total > 0 ? (Math.max(0, segment.value) / total) * 100 : 0;
    segmentEl.style.height = `${heightPct}%`;
    stack.appendChild(segmentEl);
  });
};

const appendMarker = (barEl: HTMLElement, marker: DayViewMarker | undefined, maxValue: number) => {
  if (!marker || !isFiniteNumber(marker.value)) return;
  const markerEl = document.createElement('div');
  markerEl.className = ['day-view-marker', marker.className].filter(Boolean).join(' ');
  if (
    isFiniteNumber(marker.overWhenGreaterThan)
    && marker.value > marker.overWhenGreaterThan + 0.001
    && marker.overClassName
  ) {
    markerEl.classList.add(marker.overClassName);
  }
  const markerPct = maxValue > 0 ? (marker.value / maxValue) * 100 : 0;
  markerEl.style.bottom = `${clamp(markerPct, 0, 100)}%`;
  barEl.appendChild(markerEl);
};

const buildAxisLabel = (params: {
  bar: DayViewBar;
  index: number;
  count: number;
  labelEvery: number;
  labelClassName?: string;
  formatShortLabel: (label: string) => string;
}) => {
  const {
    bar,
    index,
    count,
    labelEvery,
    labelClassName,
    formatShortLabel,
  } = params;
  const labelEl = document.createElement('div');
  labelEl.className = ['day-view-label', labelClassName].filter(Boolean).join(' ');
  const shortLabel = bar.shortLabel ?? formatShortLabel(bar.label);
  labelEl.textContent = (index % labelEvery === 0 || index === count - 1) ? shortLabel : '';
  if (shortLabel && bar.label && shortLabel !== bar.label) {
    setTooltip(labelEl, bar.label);
  }
  return labelEl;
};

export const renderDayViewChart = (params: RenderDayViewChartParams) => {
  const {
    bars,
    barsEl,
    labelsEl,
    maxValue,
    minBarHeightPct = 2,
    labelEvery = resolveLabelEvery(bars.length),
    barClassName,
    stackClassName,
    labelClassName,
    formatShortLabel = formatHourAxisLabel,
  } = params;

  barsEl.replaceChildren();
  labelsEl.replaceChildren();
  const resolvedMax = typeof maxValue === 'number' && Number.isFinite(maxValue)
    ? maxValue
    : getDayViewChartMaxValue(bars);

  bars.forEach((bar, index) => {
    const barEl = document.createElement('div');
    barEl.className = ['day-view-bar', barClassName, bar.className].filter(Boolean).join(' ');
    applyBarState(barEl, bar.state);

    const stack = document.createElement('div');
    stack.className = ['day-view-bar__stack', stackClassName, bar.stackClassName].filter(Boolean).join(' ');
    const heightPct = resolvedMax > 0 ? (bar.value / resolvedMax) * 100 : 0;
    stack.style.height = bar.value > 0 ? `${Math.max(minBarHeightPct, heightPct)}%` : '0%';
    appendSegments(stack, bar);
    barEl.appendChild(stack);

    appendMarker(barEl, bar.marker, resolvedMax);

    if (bar.title) {
      setTooltip(barEl, bar.title);
    }
    barsEl.appendChild(barEl);
    labelsEl.appendChild(buildAxisLabel({
      bar,
      index,
      count: bars.length,
      labelEvery,
      labelClassName,
      formatShortLabel,
    }));
  });
};
