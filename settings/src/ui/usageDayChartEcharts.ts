import { encodeHtml, initEcharts, type EChartsOption, type EChartsType } from './echartsRegistry';
import { formatHourAxisLabel, resolveLabelEvery, type DayViewBar } from './dayViewChart';

type AxisFormatterParam = {
  dataIndex?: number;
};

type UsageDayChartEchartsParams = {
  bars: DayViewBar[];
  labels: string[];
  currentBucketIndex: number;
  enabled: boolean;
  barsEl: HTMLElement;
  labelsEl: HTMLElement;
};

type UsageDayPalette = {
  measured: string;
  warn: string;
  budgetMarker: string;
  markerBorder: string;
  disabled: string;
  muted: string;
  grid: string;
  currentBorder: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

const DEFAULT_CHART_HEIGHT = 160;
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

const formatAxisValue = (value: number): string => {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
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
    plotContainer.classList.remove('usage-day-bars--echarts');
    plotContainer = null;
  }
};

const ensurePlot = (container: HTMLElement): EChartsType => {
  if (plot && plotContainer === container) {
    return plot;
  }

  disposePlot();
  container.classList.add('usage-day-bars--echarts');
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

const resolvePalette = (barsEl: HTMLElement): UsageDayPalette => ({
  measured: resolveCssColor(barsEl, '--day-view-color-primary', '#64B5F6'),
  warn: resolveCssColor(barsEl, '--day-view-color-warn', '#F26B6B'),
  budgetMarker: resolveCssColor(barsEl, '--day-view-color-budget', '#5CCB6B'),
  markerBorder: resolveCssColor(barsEl, '--color-surface-1', '#151F1B'),
  disabled: resolveCssColor(barsEl, '--color-surface-4', '#4D5652'),
  muted: resolveCssColor(barsEl, '--muted', '#9FB2A7'),
  grid: resolveCssColor(barsEl, '--color-border-strong', '#34423B'),
  currentBorder: resolveCssColor(barsEl, '--color-state-info-border', '#64B5F6'),
  tooltipBackground: resolveCssColor(barsEl, '--color-overlay-toast', 'rgba(12, 17, 27, 0.92)'),
  tooltipText: resolveCssColor(barsEl, '--color-semantic-text-primary', '#E6ECF5'),
  tooltipBorder: resolveCssColor(barsEl, '--color-border-medium', 'rgba(255, 255, 255, 0.15)'),
});

const resolveBarOpacity = (enabled: boolean, state?: string): number => {
  if (!enabled) return 0.6;
  if (state === 'past') return 0.45;
  return 1;
};

const isWarnBar = (bar: DayViewBar) => (
  bar.state === 'warn'
  || (typeof bar.className === 'string' && bar.className.includes('is-warn'))
);

const buildMeasuredData = (params: {
  bars: DayViewBar[];
  currentBucketIndex: number;
  enabled: boolean;
  palette: UsageDayPalette;
}) => {
  const {
    bars,
    currentBucketIndex,
    enabled,
    palette,
  } = params;
  return bars.map((bar, index) => ({
    value: bar.value,
    itemStyle: {
      color: (() => {
        if (!enabled) return palette.disabled;
        return isWarnBar(bar) ? palette.warn : palette.measured;
      })(),
      opacity: resolveBarOpacity(enabled, bar.state),
      borderWidth: currentBucketIndex >= 0 && index === currentBucketIndex ? 1 : 0,
      borderColor: palette.currentBorder,
      borderRadius: [4, 4, 0, 0],
    },
  }));
};

const buildBudgetMarkerData = (bars: DayViewBar[]): Array<number | null> => (
  bars.map((bar) => {
    const markerValue = bar.marker?.value;
    return typeof markerValue === 'number' && Number.isFinite(markerValue) ? markerValue : null;
  })
);

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

const getDataMax = (bars: DayViewBar[]): number => {
  const maxBar = bars.reduce((max, bar) => Math.max(max, bar.value), 0);
  const maxMarker = bars.reduce((max, bar) => {
    const markerValue = bar.marker?.value;
    return (typeof markerValue === 'number' && Number.isFinite(markerValue))
      ? Math.max(max, markerValue)
      : max;
  }, 0);
  return Math.max(1, maxBar, maxMarker);
};

const buildOption = (params: UsageDayChartEchartsParams): EChartsOption => {
  const {
    bars,
    labels,
    currentBucketIndex,
    enabled,
    barsEl,
  } = params;
  const palette = resolvePalette(barsEl);
  const axisLabels = labels.map((label) => formatHourAxisLabel(label));
  const labelEvery = resolveLabelEvery(bars.length);

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
      data: ['Measured', 'Budget', 'Warning'],
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
        formatter: (_label: string, index: number) => (
          index % labelEvery !== 0 && index !== bars.length - 1 ? '' : axisLabels[index]
        ),
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: getDataMax(bars) * 1.08,
      splitNumber: 4,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (value: number) => formatAxisValue(value),
      },
      splitLine: { lineStyle: { color: palette.grid } },
    },
    series: [
      {
        name: 'Measured',
        type: 'bar',
        data: buildMeasuredData({ bars, currentBucketIndex, enabled, palette }),
        barMaxWidth: 18,
        barMinHeight: 2,
        emphasis: { disabled: true },
        blur: { disabled: true },
        select: { disabled: true },
      },
      {
        name: 'Budget',
        type: 'scatter',
        data: buildBudgetMarkerData(bars),
        symbol: 'circle',
        symbolSize: 8,
        itemStyle: {
          color: palette.budgetMarker,
          borderColor: palette.markerBorder,
          borderWidth: 2,
          opacity: enabled ? 1 : 0.6,
        },
        emphasis: { disabled: true },
        blur: { disabled: true },
        select: { disabled: true },
        z: 4,
      },
      {
        name: 'Warning',
        type: 'bar',
        data: bars.map(() => null),
        itemStyle: { color: palette.warn },
        emphasis: { disabled: true },
        blur: { disabled: true },
        select: { disabled: true },
      },
    ],
  };
};

export const renderUsageDayChartEcharts = (params: UsageDayChartEchartsParams): boolean => {
  const { barsEl, labelsEl, bars } = params;
  if (!barsEl) return false;
  if (!Array.isArray(bars) || bars.length === 0) {
    disposePlot();
    barsEl.replaceChildren();
    labelsEl.hidden = true;
    return false;
  }

  try {
    const chart = ensurePlot(barsEl);
    chart.setOption(buildOption(params), { notMerge: true });
    labelsEl.hidden = true;
    return true;
  } catch (error) {
    console.warn('Usage day chart: echarts render failed', error);
    disposePlot();
    barsEl.replaceChildren();
    labelsEl.hidden = true;
    return false;
  }
};
