import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import { encodeHtml, initEcharts, type EChartsOption, type EChartsType, type SeriesOption } from './echartsRegistry.ts';
import { formatKWh } from './dailyBudgetFormat.ts';
import { formatHourAxisLabel, resolveLabelEvery } from './dayViewChart.ts';

export type BudgetRedesignChartMode = 'progress' | 'hourlyPlan';
export type BudgetRedesignDayView = 'today' | 'tomorrow' | 'yesterday';

type BudgetChartPalette = {
  actual: string;
  plan: string;
  forecast: string;
  priceCheap: string;
  priceExpensive: string;
  muted: string;
  grid: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

type BudgetRedesignChartParams = {
  container: HTMLElement;
  payload: DailyBudgetDayPayload;
  mode: BudgetRedesignChartMode;
  view: BudgetRedesignDayView;
  priceReliable: boolean;
};

let chart: EChartsType | null = null;
let chartContainer: HTMLElement | null = null;
let chartResizeObserver: ResizeObserver | null = null;

const DEFAULT_CHART_HEIGHT = 210;
const DEFAULT_CHART_WIDTH = 480;

const resolveCssColor = (element: HTMLElement, variable: string, fallback: string) => {
  const raw = getComputedStyle(element).getPropertyValue(variable).trim();
  return raw || fallback;
};

const resolveChartSize = (element: HTMLElement) => {
  const width = element.clientWidth > 0
    ? element.clientWidth
    : (element.parentElement?.clientWidth ?? 0);
  const viewportWidth = document.documentElement?.clientWidth ?? 0;
  const fallbackWidth = viewportWidth > 0 ? Math.min(DEFAULT_CHART_WIDTH, viewportWidth) : DEFAULT_CHART_WIDTH;
  return {
    width: width > 0 ? width : fallbackWidth,
    height: element.clientHeight > 0 ? element.clientHeight : DEFAULT_CHART_HEIGHT,
  };
};

const disposeChart = () => {
  if (chartResizeObserver) {
    chartResizeObserver.disconnect();
    chartResizeObserver = null;
  }
  if (chart) {
    chart.dispose();
    chart = null;
  }
  chartContainer = null;
};

export const clearBudgetRedesignChart = () => {
  disposeChart();
};

const ensureChart = (container: HTMLElement): EChartsType => {
  if (chart && chartContainer === container) return chart;
  disposeChart();
  container.replaceChildren();
  chart = initEcharts(container, undefined, {
    renderer: 'svg',
    ...resolveChartSize(container),
  });
  chartContainer = container;
  if (typeof ResizeObserver === 'function') {
    chartResizeObserver = new ResizeObserver(() => {
      if (!chart || chartContainer !== container) return;
      chart.resize(resolveChartSize(container));
    });
    chartResizeObserver.observe(container);
  }
  return chart;
};

const resolvePalette = (container: HTMLElement): BudgetChartPalette => ({
  actual: resolveCssColor(container, '--pels-chart-actual', '#e6ecf5'),
  plan: resolveCssColor(container, '--pels-chart-plan', '#10b981'),
  forecast: resolveCssColor(container, '--pels-chart-forecast', '#64b5f6'),
  priceCheap: resolveCssColor(container, '--pels-chart-price-cheap', 'rgba(16, 185, 129, 0.10)'),
  priceExpensive: resolveCssColor(container, '--pels-chart-price-expensive', 'rgba(242, 107, 107, 0.15)'),
  muted: resolveCssColor(container, '--muted', '#9fb2a7'),
  grid: resolveCssColor(container, '--color-border-strong', 'rgba(255, 255, 255, 0.20)'),
  tooltipBackground: resolveCssColor(container, '--color-overlay-toast', 'rgba(12, 17, 27, 0.92)'),
  tooltipText: resolveCssColor(container, '--color-semantic-text-primary', '#e6ecf5'),
  tooltipBorder: resolveCssColor(container, '--color-border-medium', 'rgba(255, 255, 255, 0.15)'),
});

const cumulative = (values: number[]): number[] => {
  let total = 0;
  return values.map((value) => {
    total += Number.isFinite(value) ? value : 0;
    return Number(total.toFixed(3));
  });
};

const resolveActualUpToIndex = (payload: DailyBudgetDayPayload, view: BudgetRedesignDayView) => {
  if (view === 'tomorrow') return -1;
  if (view === 'yesterday') return (payload.buckets.actualKWh || []).length - 1;
  return Math.max(-1, Math.min(payload.currentBucketIndex, (payload.buckets.actualKWh || []).length - 1));
};

const buildActualCumulative = (
  actual: number[],
  actualUpToIndex: number,
): Array<number | null> => {
  let total = 0;
  return actual.map((value, index) => {
    if (index > actualUpToIndex || !Number.isFinite(value)) return null;
    total += value;
    return Number(total.toFixed(3));
  });
};

const buildProjectionCumulative = (params: {
  planned: number[];
  actualCumulative: Array<number | null>;
  actualUpToIndex: number;
  view: BudgetRedesignDayView;
}): Array<number | null> => {
  const { planned, actualCumulative, actualUpToIndex, view } = params;
  const projection = planned.map(() => null as number | null);
  if (view !== 'today' || actualUpToIndex < 0 || actualUpToIndex >= planned.length) return projection;
  const startValue = actualCumulative[actualUpToIndex];
  if (!Number.isFinite(startValue)) return projection;
  let total = startValue as number;
  projection[actualUpToIndex] = Number(total.toFixed(3));
  for (let index = actualUpToIndex + 1; index < planned.length; index += 1) {
    total += Number.isFinite(planned[index]) ? planned[index] : 0;
    projection[index] = Number(total.toFixed(3));
  }
  return projection;
};

const buildBaseOption = (params: {
  labels: string[];
  palette: BudgetChartPalette;
  dataMax: number;
}): EChartsOption => {
  const { labels, palette, dataMax } = params;
  const labelEvery = resolveLabelEvery(labels.length);
  return {
    animation: false,
    stateAnimation: { duration: 0 },
    grid: { left: 8, right: 8, top: 12, bottom: 26, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: palette.tooltipText, fontSize: 12, fontWeight: 500 },
      formatter: (rawParams: unknown) => {
        const paramsArray = Array.isArray(rawParams) ? rawParams : [rawParams];
        return paramsArray
          .filter((item): item is { seriesName?: string; value?: number } => (
            Boolean(item) && typeof item === 'object'
          ))
          .map((item) => `${encodeHtml(item.seriesName ?? '')}: ${formatKWh(Number(item.value ?? 0))}`)
          .join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (_label: string, index: number) => {
          if (index % labelEvery !== 0 && index !== labels.length - 1) return '';
          return formatHourAxisLabel(labels[index] ?? '');
        },
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: Math.max(1, dataMax) * 1.08,
      splitNumber: 3,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (value: number) => formatKWh(value).replace(' kWh', ''),
      },
      splitLine: { lineStyle: { color: palette.grid, width: 1 } },
    },
  };
};

const buildProgressOption = (
  payload: DailyBudgetDayPayload,
  view: BudgetRedesignDayView,
  palette: BudgetChartPalette,
): EChartsOption => {
  const planned = payload.buckets.plannedKWh || [];
  const actual = payload.buckets.actualKWh || [];
  const labels = payload.buckets.startLocalLabels || [];
  const actualUpToIndex = resolveActualUpToIndex(payload, view);
  const planCumulative = cumulative(planned);
  const actualCumulative = buildActualCumulative(actual, actualUpToIndex);
  const projection = buildProjectionCumulative({ planned, actualCumulative, actualUpToIndex, view });
  const values = [
    ...planCumulative,
    ...actualCumulative.filter((value): value is number => Number.isFinite(value)),
    ...projection.filter((value): value is number => Number.isFinite(value)),
  ];
  const option = buildBaseOption({ labels, palette, dataMax: Math.max(...values, payload.budget.dailyBudgetKWh) });
  const series: SeriesOption[] = [
    {
      type: 'line',
      name: 'Plan',
      data: planCumulative,
      showSymbol: false,
      smooth: true,
      lineStyle: { color: palette.plan, width: 3 },
      areaStyle: { color: 'rgba(16, 185, 129, 0.08)' },
      emphasis: { disabled: true },
    },
  ];
  if (view !== 'tomorrow') {
    series.unshift({
      type: 'line',
      name: 'Actual',
      data: actualCumulative,
      showSymbol: false,
      smooth: true,
      connectNulls: false,
      lineStyle: { color: palette.actual, width: 3 },
      emphasis: { disabled: true },
    });
  }
  if (projection.some((value) => Number.isFinite(value))) {
    series.push({
      type: 'line',
      name: 'Projection',
      data: projection,
      showSymbol: false,
      smooth: true,
      connectNulls: false,
      lineStyle: { color: palette.forecast, width: 2, type: 'dashed' },
      emphasis: { disabled: true },
    });
  }
  return { ...option, series };
};

const buildPriceAreas = (
  labels: string[],
  prices: Array<number | null> | undefined,
  palette: BudgetChartPalette,
) => {
  if (!prices || prices.length < labels.length || !prices.every((price) => Number.isFinite(price))) return [];
  const sorted = [...prices].sort((a, b) => (a as number) - (b as number));
  const cheapThreshold = sorted[Math.floor(sorted.length * 0.25)] as number;
  const expensiveThreshold = sorted[Math.ceil(sorted.length * 0.75) - 1] as number;
  const tones = prices.map((price) => {
    if ((price as number) <= cheapThreshold) return 'cheap';
    if ((price as number) >= expensiveThreshold) return 'expensive';
    return 'normal';
  });
  const areas: unknown[] = [];
  let start = 0;
  while (start < tones.length) {
    const tone = tones[start];
    if (tone === 'normal') {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < tones.length && tones[end + 1] === tone) end += 1;
    const color = tone === 'cheap' ? palette.priceCheap : palette.priceExpensive;
    areas.push([
      { xAxis: labels[start], itemStyle: { color } },
      { xAxis: labels[end] },
    ]);
    start = end + 1;
  }
  return areas;
};

const buildHourlyOption = (
  payload: DailyBudgetDayPayload,
  view: BudgetRedesignDayView,
  palette: BudgetChartPalette,
  priceReliable: boolean,
): EChartsOption => {
  const planned = payload.buckets.plannedKWh || [];
  const actual = payload.buckets.actualKWh || [];
  const labels = payload.buckets.startLocalLabels || [];
  const actualUpToIndex = resolveActualUpToIndex(payload, view);
  const actualVisible = actual.map((value, index) => (
    index <= actualUpToIndex && Number.isFinite(value) ? value : null
  ));
  const allActual = actualVisible.filter((value): value is number => Number.isFinite(value));
  const option = buildBaseOption({ labels, palette, dataMax: Math.max(...planned, ...allActual) });
  const priceAreas = priceReliable ? buildPriceAreas(labels, payload.buckets.price, palette) : [];
  const series: SeriesOption[] = [
    {
      type: 'bar',
      name: 'Plan',
      data: planned,
      barMaxWidth: 10,
      itemStyle: { color: palette.plan, borderRadius: [4, 4, 0, 0] },
      emphasis: { disabled: true },
      markArea: priceAreas.length > 0 ? { silent: true, data: priceAreas } : undefined,
    },
  ];
  if (view !== 'tomorrow') {
    series.push({
      type: 'line',
      name: 'Actual',
      data: actualVisible,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { color: palette.actual, width: 2 },
      emphasis: { disabled: true },
    });
  }
  return { ...option, series };
};

export const renderBudgetRedesignChart = (params: BudgetRedesignChartParams) => {
  const {
    container,
    payload,
    mode,
    view,
    priceReliable,
  } = params;
  const palette = resolvePalette(container);
  const option = mode === 'progress'
    ? buildProgressOption(payload, view, palette)
    : buildHourlyOption(payload, view, palette, priceReliable);
  ensureChart(container).setOption(option, { notMerge: true });
};
