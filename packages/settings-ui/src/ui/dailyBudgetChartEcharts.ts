import { encodeHtml, initEcharts, type EChartsOption, type EChartsType, type SeriesOption } from './echartsRegistry';
import { formatKWh } from './dailyBudgetFormat';
import { formatHourAxisLabel, resolveLabelEvery, type DayViewBar } from './dayViewChart';

type AxisFormatterParam = {
  dataIndex?: number;
};

type DailyBudgetChartEchartsParams = {
  bars: DayViewBar[];
  planned: number[];
  actual: number[];
  plannedUncontrolled: number[];
  plannedControlled: number[];
  labels: string[];
  currentBucketIndex: number;
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

const resolveBarOpacity = (enabled: boolean, currentBucketIndex: number, index: number): number => {
  if (!enabled) return 0.6;
  if (currentBucketIndex < 0) return 1;
  if (index < currentBucketIndex) return 0.45;
  return 1;
};

const buildBarData = (params: {
  values: number[];
  color: string;
  topSeries: boolean;
  enabled: boolean;
  currentBucketIndex: number;
  palette: DailyBudgetPalette;
}) => {
  const {
    values,
    color,
    topSeries,
    enabled,
    currentBucketIndex,
    palette,
  } = params;
  return values.map((value, index) => ({
    value,
    itemStyle: {
      color: enabled ? color : palette.disabled,
      opacity: resolveBarOpacity(enabled, currentBucketIndex, index),
      borderWidth: currentBucketIndex >= 0 && index === currentBucketIndex ? 1 : 0,
      borderColor: palette.currentBorder,
      borderRadius: topSeries ? [4, 4, 0, 0] : [0, 0, 0, 0],
    },
  }));
};

const buildActualData = (params: {
  showActual: boolean;
  planned: number[];
  actual: number[];
  enabled: boolean;
  currentBucketIndex: number;
  palette: DailyBudgetPalette;
}) => {
  const {
    showActual,
    planned,
    actual,
    enabled,
    currentBucketIndex,
    palette,
  } = params;
  return planned.map((plannedValue, index) => {
    if (!showActual) return null;
    if (currentBucketIndex < 0 || index > currentBucketIndex) return null;
    const value = actual[index];
    if (!Number.isFinite(value)) return null;
    const over = (value as number) > plannedValue + 0.001;
    let color = palette.disabledMarker;
    if (enabled) {
      color = over ? palette.over : palette.actual;
    }
    return {
      value,
      itemStyle: {
        color,
        opacity: resolveBarOpacity(enabled, currentBucketIndex, index),
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

const buildSeries = (params: {
  showBreakdown: boolean;
  showActual: boolean;
  planned: number[];
  plannedUncontrolled: number[];
  plannedControlled: number[];
  actualData: Array<{ value: number; itemStyle: { color: string; opacity: number } } | null>;
  enabled: boolean;
  currentBucketIndex: number;
  palette: DailyBudgetPalette;
}) => {
  const {
    showBreakdown,
    showActual,
    planned,
    plannedUncontrolled,
    plannedControlled,
    actualData,
    enabled,
    currentBucketIndex,
    palette,
  } = params;
  const canStack = showBreakdown
    && plannedUncontrolled.length === planned.length
    && plannedControlled.length === planned.length;

  const baseSeries: SeriesOption[] = canStack
    ? [
      {
        name: 'Uncontrolled',
        type: 'bar',
        stack: 'plan',
        data: buildBarData({
          values: plannedUncontrolled,
          color: palette.uncontrolled,
          topSeries: false,
          enabled,
          currentBucketIndex,
          palette,
        }),
        barMaxWidth: 18,
        barMinHeight: 2,
        emphasis: { disabled: true },
        blur: { disabled: true },
        select: { disabled: true },
      },
      {
        name: 'Controlled',
        type: 'bar',
        stack: 'plan',
        data: buildBarData({
          values: plannedControlled,
          color: palette.controlled,
          topSeries: true,
          enabled,
          currentBucketIndex,
          palette,
        }),
        barMaxWidth: 18,
        barMinHeight: 2,
        emphasis: { disabled: true },
        blur: { disabled: true },
        select: { disabled: true },
      },
    ]
    : [
      {
        name: 'Planned',
        type: 'bar',
        data: buildBarData({
          values: planned,
          color: palette.planned,
          topSeries: true,
          enabled,
          currentBucketIndex,
          palette,
        }),
        barMaxWidth: 18,
        barMinHeight: 2,
        emphasis: { disabled: true },
        blur: { disabled: true },
        select: { disabled: true },
      },
    ];

  if (!showActual) return baseSeries;
  return [
    ...baseSeries,
    {
      name: 'Actual',
      type: 'scatter',
      data: actualData,
      symbol: 'circle',
      symbolSize: 8,
      itemStyle: {
        borderColor: palette.panel,
        borderWidth: 2,
      },
      z: 20,
      emphasis: { disabled: true },
      blur: { disabled: true },
      select: { disabled: true },
    },
  ];
};

const buildLegendData = (params: {
  showBreakdown: boolean;
  showActual: boolean;
}): string[] => {
  const { showBreakdown, showActual } = params;
  const legendItems = showBreakdown
    ? ['Uncontrolled', 'Controlled']
    : ['Planned'];
  if (showActual) legendItems.push('Actual');
  return legendItems;
};

const buildOption = (params: DailyBudgetChartEchartsParams): EChartsOption => {
  const {
    bars,
    planned,
    actual,
    plannedUncontrolled,
    plannedControlled,
    labels,
    currentBucketIndex,
    showActual,
    showBreakdown,
    enabled,
    barsEl,
  } = params;

  const palette = resolvePalette(barsEl);
  const labelEvery = resolveLabelEvery(planned.length);
  const axisLabels = planned.map((_value, index) => labels[index] ?? '');
  const actualData = buildActualData({
    showActual,
    planned,
    actual,
    enabled,
    currentBucketIndex,
    palette,
  });
  const allActual = actual.filter((value): value is number => Number.isFinite(value));
  const dataMax = Math.max(1, ...planned, ...allActual);
  const legendData = buildLegendData({ showBreakdown, showActual });

  return {
    animation: false,
    stateAnimation: { duration: 0 },
    grid: {
      left: 6,
      right: 10,
      top: 6,
      bottom: 46,
      containLabel: true,
    },
    legend: {
      show: true,
      left: 'center',
      bottom: 0,
      selectedMode: false,
      itemWidth: 12,
      itemHeight: 8,
      itemGap: 16,
      data: legendData,
      textStyle: {
        color: palette.muted,
        fontSize: 11,
      },
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
      textStyle: {
        color: palette.tooltipText,
        fontSize: 12,
        fontWeight: 500,
      },
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
      splitLine: {
        lineStyle: {
          color: palette.grid,
          width: 1,
        },
      },
    },
    series: buildSeries({
      showBreakdown,
      showActual,
      planned,
      plannedUncontrolled,
      plannedControlled,
      actualData,
      enabled,
      currentBucketIndex,
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
