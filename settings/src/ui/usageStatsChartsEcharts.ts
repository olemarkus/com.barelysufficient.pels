import { encodeHtml, initEcharts, type EChartsOption, type EChartsType } from './echartsRegistry';
import { resolveLabelEvery } from './dayViewChart';
import { formatDateInTimeZone } from './timezone';

type AxisFormatterParam = {
  dataIndex?: number;
};

type UsageStatsPalette = {
  bar: string;
  muted: string;
  grid: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
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
  className: string;
};

const DEFAULT_CHART_HEIGHT = 196;
const DEFAULT_CHART_WIDTH = 480;
const hourlyPatternState: PlotState = {
  plot: null,
  container: null,
  resizeObserver: null,
  className: 'hourly-pattern--echarts',
};
const dailyHistoryState: PlotState = {
  plot: null,
  container: null,
  resizeObserver: null,
  className: 'daily-history--echarts',
};
type PlotKind = 'hourly' | 'daily';

const resolveCssColor = (element: HTMLElement, variable: string, fallback: string) => {
  const raw = getComputedStyle(element).getPropertyValue(variable).trim();
  return raw || fallback;
};

const resolvePalette = (container: HTMLElement): UsageStatsPalette => ({
  bar: resolveCssColor(container, '--day-view-color-primary', '#64B5F6'),
  muted: resolveCssColor(container, '--muted', '#9FB2A7'),
  grid: resolveCssColor(container, '--color-border-strong', '#34423B'),
  tooltipBackground: resolveCssColor(container, '--color-overlay-toast', 'rgba(12, 17, 27, 0.92)'),
  tooltipText: resolveCssColor(container, '--color-semantic-text-primary', '#E6ECF5'),
  tooltipBorder: resolveCssColor(container, '--color-border-medium', 'rgba(255, 255, 255, 0.15)'),
});

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
  if (state.plot) {
    state.plot.dispose();
    state.plot = null;
  }
  if (state.container) {
    state.container.classList.remove(state.className);
    state.container = null;
  }
};

const ensurePlot = (kind: PlotKind, container: HTMLElement): EChartsType => {
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

  if (typeof ResizeObserver === 'function') {
    state.resizeObserver = new ResizeObserver(() => {
      if (!state.plot || state.container !== container) return;
      state.plot.resize(resolveChartSize(container));
    });
    state.resizeObserver.observe(container);
  }

  return state.plot;
};

const resolveTooltipIndex = (rawParams: unknown): number => {
  const first: unknown = Array.isArray(rawParams) ? rawParams[0] : rawParams;
  if (!first || typeof first !== 'object') return -1;
  const candidate = first as AxisFormatterParam;
  return typeof candidate.dataIndex === 'number' ? candidate.dataIndex : -1;
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
      formatter: (rawParams: unknown) => {
        const index = resolveTooltipIndex(rawParams);
        if (index < 0 || index >= points.length) return '';
        const point = points[index];
        const start = String(point.hour).padStart(2, '0');
        const end = String((point.hour + 1) % 24).padStart(2, '0');
        return `${encodeHtml(`${start}:00–${end}:00`)}<br/>${encodeHtml(`Average ${point.avg.toFixed(2)} kWh`)}`;
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
      max: maxValue * 1.08,
      splitNumber: 4,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
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
          opacity: 0.9,
        },
        emphasis: { disabled: true },
        blur: { disabled: true },
        select: { disabled: true },
      },
    ],
  };
};

const buildDailyHistoryOption = (params: {
  points: DailyHistoryPoint[];
  timeZone: string;
  palette: UsageStatsPalette;
}): EChartsOption => {
  const { points, timeZone, palette } = params;
  const ordered = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const values = ordered.map((point) => point.kWh);
  const dates = ordered.map((point) => point.date);
  const labels = dates.map((dateKey) => {
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    return formatDateInTimeZone(date, { month: 'short', day: 'numeric' }, timeZone);
  });
  const labelEvery = resolveLabelEvery(labels.length);
  const maxValue = Math.max(1, ...values);

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
      formatter: (rawParams: unknown) => {
        const index = resolveTooltipIndex(rawParams);
        if (index < 0 || index >= ordered.length) return '';
        const point = ordered[index];
        const date = new Date(`${point.date}T00:00:00.000Z`);
        const label = formatDateInTimeZone(date, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);
        return `${encodeHtml(label)}<br/>${encodeHtml(`${point.kWh.toFixed(1)} kWh`)}`;
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
      max: maxValue * 1.08,
      splitNumber: 4,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
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
        data: values,
        barMaxWidth: 16,
        barMinHeight: 2,
        itemStyle: {
          color: palette.bar,
          borderRadius: [4, 4, 0, 0],
          opacity: 0.9,
        },
        emphasis: { disabled: true },
        blur: { disabled: true },
        select: { disabled: true },
      },
    ],
  };
};

export const renderHourlyPatternChartEcharts = (params: {
  container: HTMLElement;
  points: HourlyPatternPoint[];
}): boolean => {
  const { container, points } = params;
  if (!Array.isArray(points) || points.length === 0) {
    disposePlot('hourly');
    container.replaceChildren();
    return false;
  }
  try {
    const chart = ensurePlot('hourly', container);
    chart.setOption(buildHourlyPatternOption({
      points,
      palette: resolvePalette(container),
    }), { notMerge: true });
    return true;
  } catch (error) {
    console.warn('Hourly pattern chart: echarts render failed', error);
    disposePlot('hourly');
    container.replaceChildren();
    return false;
  }
};

export const renderDailyHistoryChartEcharts = (params: {
  container: HTMLElement;
  points: DailyHistoryPoint[];
  timeZone: string;
}): boolean => {
  const { container, points, timeZone } = params;
  if (!Array.isArray(points) || points.length === 0) {
    disposePlot('daily');
    container.replaceChildren();
    return false;
  }
  try {
    const chart = ensurePlot('daily', container);
    chart.setOption(buildDailyHistoryOption({
      points,
      timeZone,
      palette: resolvePalette(container),
    }), { notMerge: true });
    return true;
  } catch (error) {
    console.warn('Daily history chart: echarts render failed', error);
    disposePlot('daily');
    container.replaceChildren();
    return false;
  }
};
