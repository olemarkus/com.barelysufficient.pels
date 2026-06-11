import { initEcharts, type EChartsOption, type EChartsType } from './echartsRegistry.ts';
import {
  formatAxisTick,
  readChartPalette,
  resolveLabelEvery,
  roundedAxisMaxToInterval,
} from './dayViewChart.ts';
import {
  buildChartTooltipBase,
  buildDailyHistoryReadout,
  buildHourlyPatternReadout,
  readoutToTooltipHtml,
  resolveTooltipDataIndex,
  type ChartReadoutContent,
} from './chartTooltipFormat.ts';
import { attachChartReadout, prefersCoarsePointer, type ChartReadoutHandle } from './chartReadout.ts';
import { formatDateInTimeZone, getDateKeyStartMs } from './timezone.ts';
import { logSettingsWarn } from './logging.ts';
import { attachTabShownResize } from './chartVisibilityResize.ts';

type UsageStatsPalette = {
  bar: string;
  muted: string;
  grid: string;
  // On-surface high-contrast tone for the selected bar's border — the same
  // selection identity the smart-task schedule chart uses (`palette.text` in
  // `views/DeadlinePlan.tsx`). `--pels-chart-current-border` is reserved for
  // current-hour markers and must not double as selection.
  text: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
  overBudget: string;
};

export type HourlyPatternPoint = {
  hour: number;
  avg: number;
};

export type DailyHistoryPoint = {
  date: string;
  kWh: number;
};

type PlotState = {
  plot: EChartsType | null;
  container: HTMLElement | null;
  resizeObserver: ResizeObserver | null;
  detachTabShown: (() => void) | null;
  readout: ChartReadoutHandle | null;
  readoutHost: HTMLElement | null;
  className: string;
};

const DEFAULT_CHART_HEIGHT = 196;
const DEFAULT_CHART_WIDTH = 480;
const Y_AXIS_SPLIT_NUMBER = 4;
const hourlyPatternState: PlotState = {
  plot: null,
  container: null,
  resizeObserver: null,
  detachTabShown: null,
  readout: null,
  readoutHost: null,
  className: 'hourly-pattern--echarts',
};
const dailyHistoryState: PlotState = {
  plot: null,
  container: null,
  resizeObserver: null,
  detachTabShown: null,
  readout: null,
  readoutHost: null,
  className: 'daily-history--echarts',
};
type PlotKind = 'hourly' | 'daily';

const USAGE_STATS_PALETTE_VARS = {
  bar: '--pels-chart-measured',
  muted: '--pels-chart-muted',
  grid: '--pels-chart-grid',
  text: '--text',
  tooltipBackground: '--pels-chart-tooltip-bg',
  tooltipText: '--pels-chart-tooltip-text',
  tooltipBorder: '--pels-chart-tooltip-border',
  overBudget: '--pels-chart-warn',
} as const satisfies Record<keyof UsageStatsPalette, string>;

const resolvePalette = (container: HTMLElement): UsageStatsPalette => (
  readChartPalette<UsageStatsPalette>(container, USAGE_STATS_PALETTE_VARS)
);

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

const getPlotState = (kind: PlotKind): PlotState => (
  kind === 'hourly' ? hourlyPatternState : dailyHistoryState
);

const disposePlot = (kind: PlotKind) => {
  const state = getPlotState(kind);
  if (state.resizeObserver) {
    state.resizeObserver.disconnect();
    state.resizeObserver = null;
  }
  if (state.detachTabShown) {
    state.detachTabShown();
    state.detachTabShown = null;
  }
  if (state.readout) {
    state.readout.detach();
    state.readout = null;
  }
  if (state.readoutHost) {
    state.readoutHost.hidden = true;
    state.readoutHost = null;
  }
  if (state.plot) {
    state.plot.dispose();
    state.plot = null;
  }
  if (state.container) {
    state.container.classList.remove(state.className);
    state.container = null;
  }
};

const ensurePlot = (
  kind: PlotKind,
  container: HTMLElement,
  readoutHost: HTMLElement | null,
): EChartsType => {
  const state = getPlotState(kind);
  if (state.plot && state.container === container) {
    return state.plot;
  }

  disposePlot(kind);
  container.classList.add(state.className);
  container.replaceChildren();

  state.plot = initEcharts(container, undefined, {
    renderer: 'svg',
    ...resolveChartSize(container),
  });
  state.container = container;
  if (readoutHost) {
    state.readout = attachChartReadout({ chart: state.plot, host: readoutHost });
    state.readoutHost = readoutHost;
  }

  if (typeof ResizeObserver === 'function') {
    state.resizeObserver = new ResizeObserver(() => {
      if (!state.plot || state.container !== container) return;
      state.plot.resize(resolveChartSize(container));
    });
    state.resizeObserver.observe(container);
  }
  state.detachTabShown = attachTabShownResize({
    container,
    chart: state.plot,
    resolveSize: resolveChartSize,
  });

  return state.plot;
};

// Sync the pinned readout row after a `setOption` refresh: re-apply the
// selection (wiped by `notMerge`) and surface the row. The default selection
// is the most informative point per chart — the peak hour on the typical-day
// pattern, the most recent complete day on the daily history — so the row is
// never empty.
const updateReadout = (params: {
  kind: PlotKind;
  itemCount: number;
  defaultIndex: number;
  resolveContent: (index: number) => ChartReadoutContent | null;
}) => {
  const state = getPlotState(params.kind);
  if (!state.readout || !state.readoutHost) return;
  state.readoutHost.hidden = false;
  state.readout.update({
    itemCount: params.itemCount,
    defaultIndex: params.defaultIndex,
    resolveContent: params.resolveContent,
  });
};

const peakIndex = (values: number[]): number => {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[best]) best = index;
  }
  return best;
};

const buildHourlyPatternOption = (params: {
  points: HourlyPatternPoint[];
  palette: UsageStatsPalette;
}): EChartsOption => {
  const { points, palette } = params;
  const values = points.map((point) => point.avg);
  const labels = points.map((point) => String(point.hour).padStart(2, '0'));
  const labelEvery = resolveLabelEvery(labels.length);
  const maxValue = Math.max(1, ...values);
  const yAxis = roundedAxisMaxToInterval(maxValue, Y_AXIS_SPLIT_NUMBER);

  return {
    animation: false,
    stateAnimation: { duration: 0 },
    grid: {
      left: 8,
      right: 10,
      top: 8,
      bottom: 24,
      containLabel: true,
    },
    tooltip: {
      ...buildChartTooltipBase(palette),
      show: !prefersCoarsePointer(),
      formatter: (rawParams: unknown) => {
        const index = resolveTooltipDataIndex(rawParams);
        if (index < 0 || index >= points.length) return '';
        return readoutToTooltipHtml(buildHourlyPatternReadout(points[index]));
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
        formatter: (_label: string, index: number) => (
          index % labelEvery !== 0 && index !== labels.length - 1 ? '' : labels[index]
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
      splitLine: {
        lineStyle: {
          color: palette.grid,
          width: 1,
        },
      },
    },
    series: [
      {
        name: 'Average',
        type: 'bar',
        data: values,
        barMaxWidth: 14,
        barMinHeight: 2,
        itemStyle: {
          color: palette.bar,
          borderRadius: [4, 4, 0, 0],
        },
        emphasis: { disabled: true },
        blur: { disabled: true },
        selectedMode: 'single',
        select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
      },
    ],
  };
};

const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];

// Daily-history `date` keys are LOCAL calendar days (`YYYY-MM-DD` in the
// configured zone). Anchoring them at UTC midnight (`T00:00:00.000Z`) makes
// negative-offset zones (America/*) format the PREVIOUS local day, so axis
// labels, the readout, and the tooltip would all be one day off. Resolve the
// key's local day start in the configured zone before formatting.
const formatDateKeyLabel = (
  dateKey: string,
  options: Intl.DateTimeFormatOptions,
  timeZone: string,
): string => formatDateInTimeZone(new Date(getDateKeyStartMs(dateKey, timeZone)), options, timeZone);

const resolveBarItemStyle = (value: number, budgetKWh: number | null, palette: UsageStatsPalette) => {
  if (budgetKWh !== null && Number.isFinite(value) && value > budgetKWh) {
    return { color: palette.overBudget, borderRadius: BAR_RADIUS };
  }
  return { color: palette.bar, borderRadius: BAR_RADIUS };
};

const buildBudgetMarkLine = (budgetKWh: number, palette: UsageStatsPalette) => ({
  symbol: 'none',
  silent: true,
  animation: false,
  label: {
    show: true,
    position: 'insideEndTop' as const,
    formatter: `Budget ${budgetKWh.toFixed(1)} kWh`,
    color: palette.muted,
    fontSize: 10,
  },
  lineStyle: {
    color: palette.overBudget,
    type: 'dashed' as const,
    width: 1,
  },
  data: [{ yAxis: budgetKWh }],
});

const buildDailyHistoryOption = (params: {
  ordered: DailyHistoryPoint[];
  readouts: ChartReadoutContent[];
  timeZone: string;
  palette: UsageStatsPalette;
  budgetKWh: number | null;
}): EChartsOption => {
  const { ordered, readouts, timeZone, palette, budgetKWh } = params;
  const values = ordered.map((point) => point.kWh);
  const labels = ordered.map((point) => (
    formatDateKeyLabel(point.date, { month: 'short', day: 'numeric' }, timeZone)
  ));
  const labelEvery = resolveLabelEvery(labels.length);
  // When the budget line would sit above the tallest bar, include it in the
  // axis ceiling so the reference still renders inside the chart frame.
  const showBudgetLine = budgetKWh !== null && Number.isFinite(budgetKWh) && budgetKWh > 0;
  const maxValue = Math.max(1, ...values, showBudgetLine ? (budgetKWh as number) : 0);
  const yAxis = roundedAxisMaxToInterval(maxValue, Y_AXIS_SPLIT_NUMBER);

  return {
    animation: false,
    stateAnimation: { duration: 0 },
    grid: {
      left: 8,
      right: 10,
      top: 8,
      bottom: 30,
      containLabel: true,
    },
    tooltip: {
      ...buildChartTooltipBase(palette),
      show: !prefersCoarsePointer(),
      formatter: (rawParams: unknown) => {
        const index = resolveTooltipDataIndex(rawParams);
        if (index < 0 || index >= readouts.length) return '';
        return readoutToTooltipHtml(readouts[index], { warnColor: palette.overBudget });
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
        formatter: (_label: string, index: number) => (
          index % labelEvery !== 0 && index !== labels.length - 1 ? '' : labels[index]
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
      splitLine: {
        lineStyle: {
          color: palette.grid,
          width: 1,
        },
      },
    },
    series: [
      {
        name: 'Daily total',
        type: 'bar',
        data: values.map((value) => ({ value, itemStyle: resolveBarItemStyle(value, budgetKWh, palette) })),
        barMaxWidth: 16,
        barMinHeight: 2,
        emphasis: { disabled: true },
        blur: { disabled: true },
        selectedMode: 'single',
        select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
        ...(showBudgetLine ? { markLine: buildBudgetMarkLine(budgetKWh as number, palette) } : {}),
      },
    ],
  };
};

export const renderHourlyPatternChartEcharts = (params: {
  container: HTMLElement;
  points: HourlyPatternPoint[];
  readoutHost?: HTMLElement | null;
}): boolean => {
  const { container, points, readoutHost = null } = params;
  if (!Array.isArray(points) || points.length === 0) {
    disposePlot('hourly');
    container.replaceChildren();
    if (readoutHost) readoutHost.hidden = true;
    return false;
  }
  try {
    const chart = ensurePlot('hourly', container, readoutHost);
    chart.setOption(buildHourlyPatternOption({
      points,
      palette: resolvePalette(container),
    }), { notMerge: true });
    updateReadout({
      kind: 'hourly',
      itemCount: points.length,
      defaultIndex: peakIndex(points.map((point) => point.avg)),
      resolveContent: (index) => (
        index >= 0 && index < points.length ? buildHourlyPatternReadout(points[index]) : null
      ),
    });
    return true;
  } catch (error) {
    void logSettingsWarn('Hourly pattern chart: echarts render failed', error, 'hourlyPatternChart');
    disposePlot('hourly');
    container.replaceChildren();
    if (readoutHost) readoutHost.hidden = true;
    return false;
  }
};

export const renderDailyHistoryChartEcharts = (params: {
  container: HTMLElement;
  points: DailyHistoryPoint[];
  timeZone: string;
  budgetKWh?: number | null;
  // Producer-resolved flag: the oldest day in the window is window-clipped,
  // so its readout gains the `(partial day)` note.
  leadingPartialDay?: boolean;
  readoutHost?: HTMLElement | null;
}): boolean => {
  const {
    container,
    points,
    timeZone,
    budgetKWh = null,
    leadingPartialDay = false,
    readoutHost = null,
  } = params;
  if (!Array.isArray(points) || points.length === 0) {
    disposePlot('daily');
    container.replaceChildren();
    if (readoutHost) readoutHost.hidden = true;
    return false;
  }
  try {
    const chart = ensurePlot('daily', container, readoutHost);
    const ordered = [...points].sort((a, b) => a.date.localeCompare(b.date));
    const readouts = ordered.map((point, index) => buildDailyHistoryReadout({
      dateLabel: formatDateKeyLabel(
        point.date,
        { weekday: 'short', month: 'short', day: 'numeric' },
        timeZone,
      ),
      kWh: point.kWh,
      budgetKWh,
      partialDay: leadingPartialDay && index === 0,
    }));
    chart.setOption(buildDailyHistoryOption({
      ordered,
      readouts,
      timeZone,
      palette: resolvePalette(container),
      budgetKWh,
    }), { notMerge: true });
    updateReadout({
      kind: 'daily',
      itemCount: ordered.length,
      // Most recent complete day (the producer already excludes today) — a
      // 14-day-peak default would pin a stale date as the row's anchor.
      defaultIndex: ordered.length - 1,
      resolveContent: (index) => (
        index >= 0 && index < readouts.length ? readouts[index] : null
      ),
    });
    return true;
  } catch (error) {
    void logSettingsWarn('Daily history chart: echarts render failed', error, 'dailyHistoryChart');
    disposePlot('daily');
    container.replaceChildren();
    if (readoutHost) readoutHost.hidden = true;
    return false;
  }
};
