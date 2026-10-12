import type { EChartsOption, EChartsType } from './echartsRegistry.ts';
import { mountChart, resolveChartSize, type MountedChart } from './echartsMount.ts';
import {
  buildUsageCategoryXAxis,
  buildUsageValueYAxis,
  readChartPalette,
  resolveLabelEvery,
  roundedAxisMaxToInterval,
  Y_AXIS_SPLIT_NUMBER,
} from './dayViewChart.ts';
import {
  buildDailyHistoryOption,
  formatDateKeyLabel,
  resolveDailyHistorySegments,
} from './usageDailyHistoryOption.ts';
import {
  buildChartTooltipBase,
  buildDailyHistoryReadout,
  buildHourlyPatternReadout,
  readoutToTooltipHtml,
  resolveTooltipDataIndex,
} from './chartTooltipFormat.ts';
import {
  attachChartReadout,
  prefersCoarsePointer,
  type ChartReadoutHandle,
  type ChartReadoutState,
} from './chartReadout.ts';
import { logSettingsWarn } from './logging.ts';
import type { DailyHistoryPoint, HourlyPatternPoint } from './powerStats.ts';

export type UsageStatsPalette = {
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
  // Neutral slate for the dashed budget reference line + its label pill —
  // a guideline, not a judgment (amber is reserved for the over-budget
  // portion of the bars).
  budgetReference: string;
};

type PlotState = {
  plot: MountedChart | null;
  container: HTMLElement | null;
  readout: ChartReadoutHandle | null;
  readoutHost: HTMLElement | null;
  className: string;
};

const DEFAULT_CHART_HEIGHT = 196;
const hourlyPatternState: PlotState = {
  plot: null,
  container: null,
  readout: null,
  readoutHost: null,
  className: 'hourly-pattern--echarts',
};
const dailyHistoryState: PlotState = {
  plot: null,
  container: null,
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
  budgetReference: '--pels-chart-budget-reference',
} as const satisfies Record<keyof UsageStatsPalette, string>;

const resolvePalette = (container: HTMLElement): UsageStatsPalette => (
  readChartPalette<UsageStatsPalette>(container, USAGE_STATS_PALETTE_VARS)
);

const resolvePlotSize = (element: HTMLElement) => resolveChartSize(element, DEFAULT_CHART_HEIGHT);

const getPlotState = (kind: PlotKind): PlotState => (
  kind === 'hourly' ? hourlyPatternState : dailyHistoryState
);

const disposePlot = (kind: PlotKind) => {
  const state = getPlotState(kind);
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
    return state.plot.chart;
  }

  disposePlot(kind);
  container.classList.add(state.className);
  container.replaceChildren();

  const plot = mountChart(container, resolvePlotSize);
  state.plot = plot;
  state.container = container;
  if (readoutHost) {
    state.readout = attachChartReadout({ chart: plot.chart, host: readoutHost });
    state.readoutHost = readoutHost;
  }

  return plot.chart;
};

// Sync the pinned readout row after a `setOption` refresh: re-apply the
// selection (wiped by `notMerge`) and surface the row. The default selection
// is the most informative point per chart — the peak hour on the typical-day
// pattern, the most recent complete day on the daily history — so the row is
// never empty. The daily history dispatches the column select to both stack
// series so the border wraps the whole column (mint base + amber over segment);
// the single-series pattern chart leaves it to series 0.
const updateReadout = (kind: PlotKind, readout: ChartReadoutState) => {
  const state = getPlotState(kind);
  if (!state.readout || !state.readoutHost) return;
  state.readoutHost.hidden = false;
  state.readout.update(readout);
};

const peakIndex = (values: number[]): number => {
  let best = 0;
  for (const [index, value] of values.entries()) {
    const bestValue = values[best];
    if (bestValue === undefined || value > bestValue) best = index;
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
        const point = points[index];
        if (point === undefined) return '';
        return readoutToTooltipHtml(buildHourlyPatternReadout(point));
      },
    },
    xAxis: buildUsageCategoryXAxis(labels, labelEvery, palette),
    yAxis: buildUsageValueYAxis(yAxis, palette),
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
    updateReadout('hourly', {
      itemCount: points.length,
      defaultIndex: peakIndex(points.map((point) => point.avg)),
      resolveContent: (index) => {
        const point = points[index];
        return point === undefined ? null : buildHourlyPatternReadout(point);
      },
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
    chart.setOption(buildDailyHistoryOption(
      ordered,
      readouts,
      timeZone,
      resolvePalette(container),
      budgetKWh,
    ), { notMerge: true });
    // Same segment resolution the option builder uses, so the select
    // dispatch list matches the rendered series count (base only, or base +
    // the amber over-budget series).
    const hasOverSeries = resolveDailyHistorySegments(
      ordered.map((point) => point.kWh),
      budgetKWh !== null && Number.isFinite(budgetKWh) && budgetKWh > 0 ? budgetKWh : null,
    ).over.some((value) => value > 0);
    updateReadout('daily', {
      itemCount: ordered.length,
      // Most recent complete day (the producer already excludes today) — a
      // 14-day-peak default would pin a stale date as the row's anchor.
      defaultIndex: ordered.length - 1,
      selectSeriesIndexes: hasOverSeries ? [0, 1] : [0],
      resolveContent: (index) => readouts[index] ?? null,
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
