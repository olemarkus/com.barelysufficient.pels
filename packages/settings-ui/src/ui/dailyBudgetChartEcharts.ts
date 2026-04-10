import { encodeHtml, initEcharts, type EChartsOption, type EChartsType, type SeriesOption } from './echartsRegistry.ts';
import { formatKWh } from './dailyBudgetFormat.ts';
import { formatHourAxisLabel, resolveLabelEvery, type DayViewBar } from './dayViewChart.ts';

type AxisFormatterParam = {
  dataIndex?: number;
};

type DailyBudgetChartEchartsParams = {
  bars: DayViewBar[];
  planned: number[];
  actual: number[];
  actualUncontrolled: Array<number | null>;
  actualControlled: Array<number | null>;
  plannedUncontrolled: number[];
  plannedControlled: number[];
  labels: string[];
  /** Index of the current (in-progress) hour; -1 if none (tomorrow, or completed day). */
  currentBucketIndex: number;
  /** Highest hour index for which actual data should be displayed; -1 if no actuals. */
  actualUpToIndex: number;
  showActual: boolean;
  showBreakdown: boolean;
  enabled: boolean;
  barsEl: HTMLElement;
  labelsEl: HTMLElement;
};

type DailyBudgetPalette = {
  planned: string;
  uncontrolled: string;
  controlled: string;
  actual: string;
  actualUncontrolled: string;
  actualControlled: string;
  over: string;
  disabled: string;
  disabledMarker: string;
  muted: string;
  grid: string;
  panel: string;
  text: string;
  currentBorder: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

const DEFAULT_CHART_HEIGHT = 176;
const DEFAULT_CHART_WIDTH = 480;
const ROUNDED_BAR_RADIUS = [4, 4, 0, 0] as [number, number, number, number];
const FLAT_BAR_RADIUS = [0, 0, 0, 0] as [number, number, number, number];

let plot: EChartsType | null = null;
let plotContainer: HTMLElement | null = null;
let plotResizeObserver: ResizeObserver | null = null;

const resolveCssColor = (element: HTMLElement, variable: string, fallback: string) => {
  const raw = getComputedStyle(element).getPropertyValue(variable).trim();
  return raw || fallback;
};

const resolveChartSize = (element: HTMLElement) => {
  const width = element.clientWidth > 0
    ? element.clientWidth
    : (element.parentElement?.clientWidth ?? 0);
  const viewportWidth = document.documentElement?.clientWidth ?? 0;
  const fallbackWidth = viewportWidth > 0
    ? Math.min(DEFAULT_CHART_WIDTH, viewportWidth)
    : DEFAULT_CHART_WIDTH;
  const height = element.clientHeight > 0 ? element.clientHeight : DEFAULT_CHART_HEIGHT;
  return { width: width > 0 ? width : fallbackWidth, height };
};

const disposePlot = () => {
  if (plotResizeObserver) {
    plotResizeObserver.disconnect();
    plotResizeObserver = null;
  }
  if (plot) {
    plot.dispose();
    plot = null;
  }
  if (plotContainer) {
    plotContainer.classList.remove('daily-budget-bars--echarts');
    plotContainer = null;
  }
};

const ensurePlot = (container: HTMLElement): EChartsType => {
  if (plot && plotContainer === container) {
    return plot;
  }

  disposePlot();
  container.classList.add('daily-budget-bars--echarts');
  container.replaceChildren();

  plot = initEcharts(container, undefined, {
    renderer: 'svg',
    ...resolveChartSize(container),
  });
  plotContainer = container;

  if (typeof ResizeObserver === 'function') {
    plotResizeObserver = new ResizeObserver(() => {
      if (!plot || plotContainer !== container) return;
      plot.resize(resolveChartSize(container));
    });
    plotResizeObserver.observe(container);
  }

  return plot;
};

const resolvePalette = (barsEl: HTMLElement): DailyBudgetPalette => ({
  planned: resolveCssColor(barsEl, '--day-view-color-planned', '#5CCB6B'),
  uncontrolled: resolveCssColor(barsEl, '--day-view-color-uncontrolled', '#3AA9FF'),
  controlled: resolveCssColor(barsEl, '--day-view-color-controlled', '#F2A13E'),
  actual: resolveCssColor(barsEl, '--day-view-color-actual', '#E6EFE8'),
  actualUncontrolled: resolveCssColor(barsEl, '--day-view-color-actual-uncontrolled', 'rgba(58,169,255,0.45)'),
  actualControlled: resolveCssColor(barsEl, '--day-view-color-actual-controlled', 'rgba(242,161,62,0.45)'),
  over: resolveCssColor(barsEl, '--color-state-warning-border', '#F2A13E'),
  disabled: resolveCssColor(barsEl, '--color-surface-4', '#4D5652'),
  disabledMarker: resolveCssColor(barsEl, '--color-surface-5', '#7C8581'),
  muted: resolveCssColor(barsEl, '--muted', '#9FB2A7'),
  grid: resolveCssColor(barsEl, '--color-border-strong', '#34423B'),
  panel: resolveCssColor(barsEl, '--color-surface-1', '#151F1B'),
  text: resolveCssColor(barsEl, '--text', '#E6EFE8'),
  currentBorder: resolveCssColor(barsEl, '--color-state-warning-border', '#E5B86A'),
  tooltipBackground: resolveCssColor(barsEl, '--color-overlay-toast', 'rgba(12, 17, 27, 0.92)'),
  tooltipText: resolveCssColor(barsEl, '--color-semantic-text-primary', '#E6ECF5'),
  tooltipBorder: resolveCssColor(barsEl, '--color-border-medium', 'rgba(255, 255, 255, 0.15)'),
});

const resolveBarOpacity = (enabled: boolean): number => (enabled ? 1 : 0.6);

const buildPlanBarData = (params: {
  values: number[];
  color: string;
  isTopSeries: boolean;
  enabled: boolean;
  currentBucketIndex: number;
  palette: DailyBudgetPalette;
}) => {
  const { values, color, isTopSeries, enabled, currentBucketIndex, palette } = params;
  return values.map((value, index) => {
    const isCurrent = currentBucketIndex >= 0 && index === currentBucketIndex;
    return {
      value,
      itemStyle: {
        color: enabled ? color : palette.disabled,
        opacity: resolveBarOpacity(enabled),
        borderWidth: isCurrent ? 1 : 0,
        borderColor: palette.currentBorder,
        borderRadius: isTopSeries ? ROUNDED_BAR_RADIUS : FLAT_BAR_RADIUS,
      },
    };
  });
};

const buildActualBarData = (params: {
  actual: number[];
  planned: number[];
  enabled: boolean;
  currentBucketIndex: number;
  actualUpToIndex: number;
  palette: DailyBudgetPalette;
}) => {
  const { actual, planned, enabled, currentBucketIndex, actualUpToIndex, palette } = params;
  return actual.map((actualValue, index) => {
    if (actualUpToIndex < 0 || index > actualUpToIndex) return null;
    if (!Number.isFinite(actualValue)) return null;
    const plannedValue = planned[index] ?? 0;
    const isOver = actualValue > plannedValue + 0.001;
    const isCurrent = index === currentBucketIndex;
    let actualColor = palette.actual;
    if (!enabled) actualColor = palette.disabled;
    else if (isOver) actualColor = palette.over;
    return {
      value: actualValue,
      itemStyle: {
        color: actualColor,
        opacity: enabled ? 1 : 0.6,
        borderWidth: isCurrent ? 1 : 0,
        borderColor: palette.currentBorder,
        borderRadius: ROUNDED_BAR_RADIUS,
      },
    };
  });
};

const buildActualBreakdownData = (params: {
  values: Array<number | null>;
  color: string;
  isTopSeries: boolean;
  enabled: boolean;
  currentBucketIndex: number;
  actualUpToIndex: number;
  palette: DailyBudgetPalette;
}) => {
  const { values, color, isTopSeries, enabled, currentBucketIndex, actualUpToIndex, palette } = params;
  return values.map((val, index) => {
    if (actualUpToIndex < 0 || index > actualUpToIndex) return null;
    if (!Number.isFinite(val)) return null;
    const isCurrent = index === currentBucketIndex;
    return {
      value: val as number,
      itemStyle: {
        color: enabled ? color : palette.disabled,
        opacity: resolveBarOpacity(enabled),
        borderWidth: isCurrent ? 1 : 0,
        borderColor: palette.currentBorder,
        borderRadius: isTopSeries ? ROUNDED_BAR_RADIUS : FLAT_BAR_RADIUS,
      },
    };
  });
};

const resolveTooltipIndex = (rawParams: unknown): number => {
  const first: unknown = Array.isArray(rawParams) ? rawParams[0] : rawParams;
  if (!first || typeof first !== 'object') return -1;
  const candidate = first as AxisFormatterParam;
  return typeof candidate.dataIndex === 'number' ? candidate.dataIndex : -1;
};

const buildTooltipFormatter = (bars: DayViewBar[]) => (rawParams: unknown): string => {
  const index = resolveTooltipIndex(rawParams);
  if (index < 0 || index >= bars.length) return '';
  const text = bars[index].title ?? '';
  return encodeHtml(text).replace(/ · /g, '<br/>');
};

const BAR_SERIES_BASE = {
  type: 'bar' as const,
  barMaxWidth: 10,
  barMinHeight: 2,
  emphasis: { disabled: true },
  blur: { disabled: true },
  select: { disabled: true },
};

type LegendItem = { name: string; icon?: string; itemStyle: { color: string } };

type SeriesContext = {
  planned: number[];
  actual: number[];
  actualUncontrolled: Array<number | null>;
  actualControlled: Array<number | null>;
  plannedUncontrolled: number[];
  plannedControlled: number[];
  enabled: boolean;
  currentBucketIndex: number;
  actualUpToIndex: number;
  palette: DailyBudgetPalette;
};

const buildStackedPlanSeries = (ctx: SeriesContext): SeriesOption[] => {
  const { palette, enabled, currentBucketIndex } = ctx;
  return [
    {
      ...BAR_SERIES_BASE,
      name: 'Plan Uncontrolled',
      stack: 'plan',
      data: buildPlanBarData({
        values: ctx.plannedUncontrolled, color: palette.uncontrolled,
        isTopSeries: false, enabled, currentBucketIndex, palette,
      }),
    },
    {
      ...BAR_SERIES_BASE,
      name: 'Plan Controlled',
      stack: 'plan',
      data: buildPlanBarData({
        values: ctx.plannedControlled, color: palette.controlled,
        isTopSeries: true, enabled, currentBucketIndex, palette,
      }),
    },
  ];
};

const buildActualBreakdownSeries = (ctx: SeriesContext): SeriesOption[] => {
  const { palette, enabled, currentBucketIndex, actualUpToIndex } = ctx;
  return [
    {
      ...BAR_SERIES_BASE,
      name: 'Actual Uncontrolled',
      stack: 'actual',
      data: buildActualBreakdownData({
        values: ctx.actualUncontrolled, color: palette.actualUncontrolled,
        isTopSeries: false, enabled, currentBucketIndex, actualUpToIndex, palette,
      }),
    },
    {
      ...BAR_SERIES_BASE,
      name: 'Actual Controlled',
      stack: 'actual',
      data: buildActualBreakdownData({
        values: ctx.actualControlled, color: palette.actualControlled,
        isTopSeries: true, enabled, currentBucketIndex, actualUpToIndex, palette,
      }),
    },
  ];
};

const buildActualTotalSeries = (ctx: SeriesContext): SeriesOption => ({
  ...BAR_SERIES_BASE,
  name: 'Actual',
  data: buildActualBarData({
    actual: ctx.actual, planned: ctx.planned, enabled: ctx.enabled,
    currentBucketIndex: ctx.currentBucketIndex, actualUpToIndex: ctx.actualUpToIndex, palette: ctx.palette,
  }),
});

const buildBudgetTotalSeries = (ctx: SeriesContext): SeriesOption => ({
  ...BAR_SERIES_BASE,
  name: 'Budget',
  data: buildPlanBarData({
    values: ctx.planned,
    color: ctx.palette.planned,
    isTopSeries: true,
    enabled: ctx.enabled,
    currentBucketIndex: ctx.currentBucketIndex,
    palette: ctx.palette,
  }),
});

const buildSeries = (params: {
  showBreakdown: boolean;
  showActual: boolean;
  hasActualBreakdown: boolean;
} & SeriesContext): SeriesOption[] => {
  const { showBreakdown, showActual, hasActualBreakdown, ...ctx } = params;

  const canStack = showBreakdown
    && ctx.plannedUncontrolled.length === ctx.planned.length
    && ctx.plannedControlled.length === ctx.planned.length;

  if (canStack) {
    const planSeries = buildStackedPlanSeries(ctx);
    if (!showActual) return planSeries;
    if (hasActualBreakdown) return [...buildActualBreakdownSeries(ctx), ...planSeries];
    return [buildActualTotalSeries(ctx), ...planSeries];
  }

  const budgetSeries = buildBudgetTotalSeries(ctx);
  if (!showActual) return [budgetSeries];

  // Actual breakdown available but planned breakdown absent (e.g. yesterday: no stored plan split).
  const canShowActualBreakdown = showBreakdown
    && ctx.actualUncontrolled.length === ctx.planned.length
    && ctx.actualControlled.length === ctx.planned.length;
  if (canShowActualBreakdown) return [...buildActualBreakdownSeries(ctx), budgetSeries];

  return [buildActualTotalSeries(ctx), budgetSeries];
};

const buildLegendData = (params: {
  showBreakdown: boolean;
  showActual: boolean;
  hasActualBreakdown: boolean;
  /** Actual breakdown available but planned breakdown absent (e.g. yesterday view). */
  canShowActualBreakdown: boolean;
  palette: DailyBudgetPalette;
}): LegendItem[] => {
  const { showBreakdown, showActual, hasActualBreakdown, canShowActualBreakdown, palette } = params;

  if (showBreakdown) {
    if (showActual && hasActualBreakdown) {
      return [
        { name: 'Actual Uncontrolled', itemStyle: { color: palette.actualUncontrolled } },
        { name: 'Actual Controlled', itemStyle: { color: palette.actualControlled } },
        { name: 'Plan Uncontrolled', itemStyle: { color: palette.uncontrolled } },
        { name: 'Plan Controlled', itemStyle: { color: palette.controlled } },
      ];
    }
    if (showActual && canShowActualBreakdown) {
      return [
        { name: 'Actual Uncontrolled', itemStyle: { color: palette.actualUncontrolled } },
        { name: 'Actual Controlled', itemStyle: { color: palette.actualControlled } },
        { name: 'Budget', itemStyle: { color: palette.planned } },
      ];
    }
    if (showActual) {
      return [
        { name: 'Actual', itemStyle: { color: palette.actual } },
        { name: 'Plan Uncontrolled', itemStyle: { color: palette.uncontrolled } },
        { name: 'Plan Controlled', itemStyle: { color: palette.controlled } },
      ];
    }
    return [
      { name: 'Plan Uncontrolled', itemStyle: { color: palette.uncontrolled } },
      { name: 'Plan Controlled', itemStyle: { color: palette.controlled } },
    ];
  }

  const items: LegendItem[] = [{ name: 'Budget', itemStyle: { color: palette.planned } }];
  if (showActual) {
    items.unshift({ name: 'Actual', itemStyle: { color: palette.actual } });
  }
  return items;
};

const buildOption = (params: DailyBudgetChartEchartsParams): EChartsOption => {
  const {
    bars,
    planned,
    actual,
    actualUncontrolled,
    actualControlled,
    plannedUncontrolled,
    plannedControlled,
    labels,
    currentBucketIndex,
    actualUpToIndex,
    showActual,
    showBreakdown,
    enabled,
    barsEl,
  } = params;

  const palette = resolvePalette(barsEl);
  const labelEvery = resolveLabelEvery(planned.length);
  const axisLabels = planned.map((_value, index) => labels[index] ?? '');
  const allActual = actual.filter((value): value is number => Number.isFinite(value));
  const dataMax = Math.max(1, ...planned, ...allActual);
  const canStack = showBreakdown
    && plannedUncontrolled.length === planned.length
    && plannedControlled.length === planned.length;
  const hasActualSplit = actualUncontrolled.length === planned.length
    && actualControlled.length === planned.length
    && actualUncontrolled.some((v) => v !== null);
  const hasActualBreakdown = canStack && hasActualSplit;
  // Actual breakdown available but planned breakdown absent (e.g. yesterday: plan split not stored).
  const canShowActualBreakdown = !canStack
    && showBreakdown
    && showActual
    && hasActualSplit;
  const legendData = buildLegendData({
    showBreakdown,
    showActual,
    hasActualBreakdown,
    canShowActualBreakdown,
    palette,
  });

  return {
    animation: false,
    stateAnimation: { duration: 0 },
    grid: { left: 6, right: 10, top: 6, bottom: 46, containLabel: true },
    legend: {
      show: true,
      left: 'center',
      bottom: 0,
      selectedMode: false,
      itemWidth: 12,
      itemHeight: 8,
      itemGap: 16,
      data: legendData,
      textStyle: { color: palette.muted, fontSize: 11 },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'none' },
      confine: true,
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      padding: [8, 10],
      extraCssText: 'opacity:1;backdrop-filter:none;box-shadow:var(--shadow-md);',
      textStyle: { color: palette.tooltipText, fontSize: 12, fontWeight: 500 },
      formatter: buildTooltipFormatter(bars),
    },
    xAxis: {
      type: 'category',
      data: axisLabels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (_label: string, index: number) => {
          if (index % labelEvery !== 0 && index !== planned.length - 1) return '';
          return formatHourAxisLabel(axisLabels[index] ?? '');
        },
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: dataMax * 1.08,
      splitNumber: 4,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (value: number) => formatKWh(value).replace(' kWh', ''),
      },
      splitLine: { lineStyle: { color: palette.grid, width: 1 } },
    },
    series: buildSeries({
      showBreakdown,
      showActual,
      planned,
      actual,
      actualUncontrolled,
      actualControlled,
      plannedUncontrolled,
      plannedControlled,
      hasActualBreakdown,
      enabled,
      currentBucketIndex,
      actualUpToIndex,
      palette,
    }),
  };
};

export const renderDailyBudgetChartEcharts = (params: DailyBudgetChartEchartsParams): boolean => {
  try {
    const { barsEl, labelsEl } = params;
    const chart = ensurePlot(barsEl);
    chart.setOption(buildOption(params), { notMerge: true });
    labelsEl.replaceChildren();
    labelsEl.hidden = true;
    return true;
  } catch (error) {
    console.warn('Failed to render daily budget chart (ECharts).', error);
    disposePlot();
    return false;
  }
};
