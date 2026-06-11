import { initEcharts, type EChartsOption, type EChartsType } from './echartsRegistry.ts';
import { logSettingsWarn } from './logging.ts';
import {
  formatAxisTick,
  formatHourAxisLabel,
  readChartPalette,
  resolveLabelEvery,
  roundedAxisMaxToInterval,
  type DayViewBar,
} from './dayViewChart.ts';
import {
  buildChartTooltipBase,
  readoutToTooltipHtml,
  resolveTooltipDataIndex,
  type ChartReadoutContent,
} from './chartTooltipFormat.ts';
import { attachChartReadout, prefersCoarsePointer, type ChartReadoutHandle } from './chartReadout.ts';
import { attachTabShownResize } from './chartVisibilityResize.ts';

type UsageDayChartEchartsParams = {
  bars: DayViewBar[];
  labels: string[];
  // Structured per-bucket content feeding both the hover tooltip and the
  // pinned readout row (one grammar, identical information).
  readouts?: ChartReadoutContent[];
  readoutHost?: HTMLElement | null;
  // Default readout selection: the current hour on the Today view, the peak
  // hour otherwise. Negative falls back to index 0 inside the readout helper.
  defaultReadoutIndex?: number;
  currentBucketIndex: number;
  enabled: boolean;
  barsEl: HTMLElement;
  labelsEl: HTMLElement;
};

type UsageDayPalette = {
  measured: string;
  warn: string;
  disabled: string;
  muted: string;
  grid: string;
  // Current-hour marker border ONLY (borderWidth 1 in `buildMeasuredData`).
  currentBorder: string;
  // On-surface high-contrast tone for the selected bar's border — the same
  // selection identity the smart-task schedule chart uses (`palette.text` in
  // `views/DeadlinePlan.tsx`), kept visually distinct from the current-hour
  // marker above.
  text: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

const DEFAULT_CHART_HEIGHT = 160;
const DEFAULT_CHART_WIDTH = 480;

let plot: EChartsType | null = null;
let plotContainer: HTMLElement | null = null;
let plotResizeObserver: ResizeObserver | null = null;
let detachTabShownResize: (() => void) | null = null;
let plotReadout: ChartReadoutHandle | null = null;
let plotReadoutHost: HTMLElement | null = null;

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
  if (detachTabShownResize) {
    detachTabShownResize();
    detachTabShownResize = null;
  }
  if (plotReadout) {
    plotReadout.detach();
    plotReadout = null;
  }
  if (plotReadoutHost) {
    plotReadoutHost.hidden = true;
    plotReadoutHost = null;
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

const ensurePlot = (container: HTMLElement, readoutHost: HTMLElement | null): EChartsType => {
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
  if (readoutHost) {
    plotReadout = attachChartReadout({ chart: plot, host: readoutHost });
    plotReadoutHost = readoutHost;
  }

  if (typeof ResizeObserver === 'function') {
    plotResizeObserver = new ResizeObserver(() => {
      if (!plot || plotContainer !== container) return;
      plot.resize(resolveChartSize(container));
    });
    plotResizeObserver.observe(container);
  }
  detachTabShownResize = attachTabShownResize({ container, chart: plot, resolveSize: resolveChartSize });

  return plot;
};

const USAGE_DAY_PALETTE_VARS = {
  measured: '--pels-chart-measured',
  warn: '--pels-chart-warn',
  disabled: '--pels-chart-disabled-bar',
  muted: '--pels-chart-muted',
  grid: '--pels-chart-grid',
  currentBorder: '--pels-chart-current-border',
  text: '--text',
  tooltipBackground: '--pels-chart-tooltip-bg',
  tooltipText: '--pels-chart-tooltip-text',
  tooltipBorder: '--pels-chart-tooltip-border',
} as const satisfies Record<keyof UsageDayPalette, string>;

const resolvePalette = (barsEl: HTMLElement): UsageDayPalette => (
  readChartPalette<UsageDayPalette>(barsEl, USAGE_DAY_PALETTE_VARS)
);

const resolveBarOpacity = (enabled: boolean): number => (enabled ? 1 : 0.6);

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
      opacity: resolveBarOpacity(enabled),
      borderWidth: currentBucketIndex >= 0 && index === currentBucketIndex ? 1 : 0,
      borderColor: palette.currentBorder,
      borderRadius: [4, 4, 0, 0],
    },
  }));
};

const buildTooltipFormatter = (readouts: ChartReadoutContent[], warnColor: string) => (
  (rawParams: unknown): string => {
    const index = resolveTooltipDataIndex(rawParams);
    if (index < 0 || index >= readouts.length) return '';
    return readoutToTooltipHtml(readouts[index], { warnColor });
  }
);

const getDataMax = (bars: DayViewBar[]): number => (
  Math.max(1, ...bars.map((bar) => bar.value))
);

const Y_AXIS_SPLIT_NUMBER = 4;

const buildOption = (params: UsageDayChartEchartsParams): EChartsOption => {
  const {
    bars,
    labels,
    readouts = [],
    currentBucketIndex,
    enabled,
    barsEl,
  } = params;
  const palette = resolvePalette(barsEl);
  const axisLabels = labels.map((label) => formatHourAxisLabel(label));
  const labelEvery = resolveLabelEvery(bars.length);
  const hasWarnBars = bars.some((bar) => isWarnBar(bar));
  const yAxis = roundedAxisMaxToInterval(getDataMax(bars), Y_AXIS_SPLIT_NUMBER);

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
      data: hasWarnBars ? ['Measured', 'Warning'] : ['Measured'],
      textStyle: {
        color: palette.muted,
        fontSize: 11,
      },
    },
    tooltip: {
      ...buildChartTooltipBase(palette),
      show: !prefersCoarsePointer(),
      formatter: buildTooltipFormatter(readouts, palette.warn),
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
      max: yAxis.max,
      interval: yAxis.interval,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (value: number) => formatAxisTick(value, yAxis.interval),
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
        itemStyle: { color: palette.measured },
        emphasis: { disabled: true },
        blur: { disabled: true },
        selectedMode: 'single',
        select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
      },
      // Zero-data dummy series so the legend's "Warning" entry has a real
      // series to bind to. The "Measured" series colours warning bars
      // per-item, so without this stub ECharts silently drops the legend
      // label (TODO 1122 — fixed v2.7.0). Empty `data` produces no bars, so
      // adding the series only affects the legend; the `barMaxWidth` cap on
      // both series prevents any width competition with Measured. Only added
      // when warn bars exist so the legend stays a single-item row in the
      // common case.
      ...(hasWarnBars
        ? [{
          name: 'Warning',
          type: 'bar' as const,
          data: [] as number[],
          barMaxWidth: 18,
          itemStyle: { color: palette.warn },
          emphasis: { disabled: true },
          blur: { disabled: true },
          select: { disabled: true },
        }]
        : []),
    ],
  };
};

export const renderUsageDayChartEcharts = (params: UsageDayChartEchartsParams): boolean => {
  const { barsEl, labelsEl, bars, readouts = [], readoutHost = null, defaultReadoutIndex = 0 } = params;
  if (!barsEl) return false;
  if (!Array.isArray(bars) || bars.length === 0) {
    disposePlot();
    barsEl.replaceChildren();
    labelsEl.hidden = true;
    if (readoutHost) readoutHost.hidden = true;
    return false;
  }

  try {
    const chart = ensurePlot(barsEl, readoutHost);
    chart.setOption(buildOption(params), { notMerge: true });
    if (plotReadout && plotReadoutHost) {
      plotReadoutHost.hidden = false;
      plotReadout.update({
        itemCount: bars.length,
        defaultIndex: defaultReadoutIndex,
        resolveContent: (index) => (
          index >= 0 && index < readouts.length ? readouts[index] : null
        ),
      });
    }
    labelsEl.hidden = true;
    return true;
  } catch (error) {
    void logSettingsWarn('Usage day chart: echarts render failed', error, 'usageDayChart');
    disposePlot();
    barsEl.replaceChildren();
    labelsEl.hidden = true;
    if (readoutHost) readoutHost.hidden = true;
    return false;
  }
};
