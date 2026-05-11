import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import { encodeHtml, initEcharts, type EChartsOption, type EChartsType, type SeriesOption } from './echartsRegistry.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import { formatKWh } from './dailyBudgetFormat.ts';
import { formatHourAxisLabel, resolveLabelEvery } from './dayViewChart.ts';

export type BudgetRedesignChartMode = 'progress' | 'hourlyPlan';
export type BudgetRedesignDayView = 'today' | 'tomorrow' | 'yesterday';

type BudgetChartPalette = {
  actual: string;
  plan: string;
  background: string;
  managed: string;
  forecast: string;
  priceLine: string;
  priceFill: string;
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
  costDisplay: CostDisplay;
  dataMaxOverride?: number;
};

type ChartHandle = { chart: EChartsType; resizeObserver?: ResizeObserver };
const chartHandles = new WeakMap<HTMLElement, ChartHandle>();

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

export const clearBudgetRedesignChart = (container?: HTMLElement) => {
  if (!container) return;
  const handle = chartHandles.get(container);
  if (!handle) return;
  handle.resizeObserver?.disconnect();
  handle.chart.dispose();
  chartHandles.delete(container);
};

const ensureChart = (container: HTMLElement): EChartsType => {
  const existing = chartHandles.get(container);
  if (existing) return existing.chart;
  container.replaceChildren();
  const chart = initEcharts(container, undefined, {
    renderer: 'svg',
    ...resolveChartSize(container),
  });
  let resizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      const handle = chartHandles.get(container);
      if (!handle) return;
      handle.chart.resize(resolveChartSize(container));
    });
    resizeObserver.observe(container);
  }
  chartHandles.set(container, { chart, resizeObserver });
  return chart;
};

const resolvePalette = (container: HTMLElement): BudgetChartPalette => ({
  actual: resolveCssColor(container, '--pels-chart-actual', '#e6ecf5'),
  plan: resolveCssColor(container, '--pels-chart-plan', '#10b981'),
  background: resolveCssColor(container, '--day-view-color-background-usage', '#64b5f6'),
  managed: resolveCssColor(container, '--day-view-color-managed-usage', '#f59e0b'),
  forecast: resolveCssColor(container, '--pels-chart-forecast', '#64b5f6'),
  priceLine: resolveCssColor(container, '--pels-chart-price-line', '#f59e0b'),
  priceFill: resolveCssColor(container, '--pels-chart-price-fill', 'rgba(245, 158, 11, 0.14)'),
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

export const buildProjectionCumulative = (params: {
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
  const previousActualTotal = actualUpToIndex > 0 ? actualCumulative[actualUpToIndex - 1] : 0;
  if (!Number.isFinite(previousActualTotal)) return projection;
  const currentActual = Math.max(0, (startValue as number) - (previousActualTotal as number));
  const currentPlanned = Number.isFinite(planned[actualUpToIndex]) ? planned[actualUpToIndex] : 0;
  let total = (startValue as number) + Math.max(0, (currentPlanned as number) - currentActual);
  projection[actualUpToIndex] = Number(total.toFixed(3));
  for (let index = actualUpToIndex + 1; index < planned.length; index += 1) {
    total += Number.isFinite(planned[index]) ? planned[index] : 0;
    projection[index] = Number(total.toFixed(3));
  }
  return projection;
};

type ChartScaleKind = 'progress' | 'hourly';

const resolveYAxisScale = (dataMax: number, kind: ChartScaleKind): { max: number; interval: number } => {
  const safeMax = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
  if (kind === 'hourly') {
    const interval = safeMax <= 1.2 ? 0.3 : 0.5;
    const max = Math.max(interval, Math.ceil(safeMax / interval) * interval);
    return {
      max: Number(max.toFixed(1)),
      interval,
    };
  }
  const interval = safeMax <= 20 ? 5 : 10;
  return {
    max: Math.max(interval, Math.ceil(safeMax / interval) * interval),
    interval,
  };
};

const resolvePriceYAxisScale = (prices: number[]): { min: number; max: number; interval: number } => {
  if (prices.length === 0) return { min: 0, max: 1, interval: 0.5 };
  const dataMin = Math.min(...prices);
  const dataMax = Math.max(...prices);
  const span = Math.max(0.01, dataMax - dataMin);
  const pad = span * 0.1;
  const interval = span <= 1.2 ? 0.3 : 0.5;
  const minPadded = Math.max(0, Math.floor((dataMin - pad) / interval) * interval);
  const maxPadded = Math.ceil((dataMax + pad) / interval) * interval;
  return {
    min: Number(minPadded.toFixed(2)),
    max: Number(maxPadded.toFixed(2)),
    interval,
  };
};

const resolvePriceAxisUnit = (display: CostDisplay): string => {
  const unit = display.unit.trim();
  if (!unit) return 'Price';
  return unit.toLowerCase().includes('/kwh') ? unit : `${unit}/kWh`;
};

const normalizePriceValues = (
  prices: Array<number | null> | undefined,
  length: number,
  display: CostDisplay,
): number[] => {
  const divisor = Math.max(1, display.divisor);
  return (prices || [])
    .slice(0, length)
    .filter((value): value is number => Number.isFinite(value))
    .map((value) => Number((value / divisor).toFixed(4)));
};

const readTooltipValue = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const values = value as readonly unknown[];
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const candidate = values[index];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    }
  }
  return null;
};

export const formatBudgetChartTooltip = (
  rawParams: unknown,
  priceAxisUnit?: string | null,
): string => {
  const paramsArray = Array.isArray(rawParams) ? rawParams : [rawParams];
  return paramsArray
    .filter((item): item is { seriesName?: string; value?: unknown } => (
      Boolean(item) && typeof item === 'object'
    ))
    .flatMap((item) => {
      const value = readTooltipValue(item.value);
      if (value === null) return [];
      const name = item.seriesName ?? '';
      const formatted = name === 'Price'
        ? `${value.toFixed(2)} ${priceAxisUnit ?? 'price'}`
        : formatKWh(value);
      return `${encodeHtml(name)}: ${formatted}`;
    })
    .join('<br/>');
};

const buildBaseOption = (params: {
  labels: string[];
  palette: BudgetChartPalette;
  dataMax: number;
  scaleKind: ChartScaleKind;
  priceAxisUnit?: string | null;
}): EChartsOption => {
  const {
    labels,
    palette,
    dataMax,
    scaleKind,
    priceAxisUnit,
  } = params;
  const labelEvery = resolveLabelEvery(labels.length);
  const yScale = resolveYAxisScale(dataMax, scaleKind);
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
        return formatBudgetChartTooltip(rawParams, priceAxisUnit);
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
      max: yScale.max,
      interval: yScale.interval,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (value: number) => (
          scaleKind === 'hourly' ? value.toFixed(1) : String(Math.round(value))
        ),
      },
      splitLine: { lineStyle: { color: palette.grid, width: 1 } },
    },
  };
};

const buildProgressOption = (
  payload: DailyBudgetDayPayload,
  view: BudgetRedesignDayView,
  palette: BudgetChartPalette,
  dataMaxOverride?: number,
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
  const computedMax = Math.max(...values, payload.budget.dailyBudgetKWh);
  const dataMax = dataMaxOverride !== undefined ? Math.max(computedMax, dataMaxOverride) : computedMax;
  const option = buildBaseOption({
    labels,
    palette,
    dataMax,
    scaleKind: 'progress',
  });
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
      lineStyle: { color: palette.forecast, width: 2, type: 'dashed', opacity: 0.7 },
      emphasis: { disabled: true },
    });
  }
  return { ...option, series };
};

type BuildHourlyParams = {
  payload: DailyBudgetDayPayload;
  view: BudgetRedesignDayView;
  palette: BudgetChartPalette;
  priceReliable: boolean;
  costDisplay: CostDisplay;
  dataMaxOverride?: number;
};

const buildPriceYAxis = (priceValues: number[], priceAxisUnit: string, palette: BudgetChartPalette) => {
  const priceScale = resolvePriceYAxisScale(priceValues);
  return {
    type: 'value' as const,
    min: priceScale.min,
    max: priceScale.max,
    interval: priceScale.interval,
    name: priceAxisUnit,
    nameGap: 8,
    nameTextStyle: { color: palette.muted, fontSize: 10, padding: [0, 0, 4, 0] as [number, number, number, number] },
    axisTick: { show: false },
    axisLine: { show: false },
    axisLabel: {
      color: palette.muted,
      fontSize: 11,
      formatter: (value: number) => value.toFixed(1),
    },
    splitLine: { show: false },
  };
};

const buildHourlyOption = (params: BuildHourlyParams): EChartsOption => {
  const {
    payload,
    view,
    palette,
    priceReliable,
    costDisplay,
    dataMaxOverride,
  } = params;
  const planned = payload.buckets.plannedKWh || [];
  const actual = payload.buckets.actualKWh || [];
  const labels = payload.buckets.startLocalLabels || [];
  const actualUpToIndex = resolveActualUpToIndex(payload, view);
  const actualVisible = actual.map((value, index) => (
    index <= actualUpToIndex && Number.isFinite(value) ? value : null
  ));
  const allActual = actualVisible.filter((value): value is number => Number.isFinite(value));
  const computedMax = Math.max(0, ...planned, ...allActual);
  const dataMax = dataMaxOverride !== undefined ? Math.max(computedMax, dataMaxOverride) : computedMax;
  const priceAxisUnit = resolvePriceAxisUnit(costDisplay);
  const option = buildBaseOption({
    labels,
    palette,
    dataMax,
    scaleKind: 'hourly',
    priceAxisUnit,
  });
  const priceValues = priceReliable
    ? normalizePriceValues(payload.buckets.price, labels.length, costDisplay)
    : [];
  if (priceValues.length === labels.length) {
    option.grid = { ...(option.grid as Record<string, unknown>), right: 48, top: 26 };
    option.yAxis = [option.yAxis, buildPriceYAxis(priceValues, priceAxisUnit, palette)];
  }
  const plannedBackground = payload.buckets.plannedUncontrolledKWh || [];
  const plannedManaged = payload.buckets.plannedControlledKWh || [];
  const hasSplit = plannedBackground.length === labels.length
    && plannedManaged.length === labels.length;
  const series: SeriesOption[] = hasSplit
    ? [
      {
        type: 'bar',
        name: 'Background',
        data: plannedBackground,
        stack: 'planned',
        z: 2,
        barMaxWidth: 10,
        itemStyle: { color: palette.background },
        emphasis: { disabled: true },
      },
      {
        type: 'bar',
        name: 'Managed',
        data: plannedManaged,
        stack: 'planned',
        z: 2,
        barMaxWidth: 10,
        itemStyle: { color: palette.managed, borderRadius: [4, 4, 0, 0] },
        emphasis: { disabled: true },
      },
    ]
    : [
      {
        type: 'bar',
        name: 'Plan',
        data: planned,
        z: 2,
        barMaxWidth: 10,
        itemStyle: { color: palette.plan, borderRadius: [4, 4, 0, 0] },
        emphasis: { disabled: true },
      },
    ];
  if (priceValues.length === labels.length) {
    series.push({
      type: 'line',
      name: 'Price',
      data: priceValues,
      yAxisIndex: 1,
      z: 5,
      showSymbol: false,
      smooth: false,
      step: 'middle',
      lineStyle: { color: palette.priceLine, width: 3 },
      areaStyle: { color: palette.priceFill },
      emphasis: { disabled: true },
    });
  }
  if (view !== 'tomorrow') {
    series.push({
      type: 'line',
      name: 'Actual',
      data: actualVisible,
      z: 4,
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
    costDisplay,
    dataMaxOverride,
  } = params;
  const palette = resolvePalette(container);
  const option = mode === 'progress'
    ? buildProgressOption(payload, view, palette, dataMaxOverride)
    : buildHourlyOption({ payload, view, palette, priceReliable, costDisplay, dataMaxOverride });
  ensureChart(container).setOption(option, { notMerge: true });
};
