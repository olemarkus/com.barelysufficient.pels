import { encodeHtml, initEcharts, type EChartsOption, type EChartsType } from './echartsRegistry';
import { formatDateInTimeZone } from './timezone';
import type { UsageDayEntry } from './usageDayView';

type PowerUsageEntry = UsageDayEntry;

type HeatmapPalette = {
  cellUnreliable: string;
  border: string;
  muted: string;
  grid: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

const DEFAULT_CHART_HEIGHT = 240;
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

const HEATMAP_COLOR_LOW = '#64B5F6';
const HEATMAP_COLOR_HIGH = '#E57373';

const resolvePalette = (container: HTMLElement): HeatmapPalette => ({
  cellUnreliable: resolveCssColor(container, '--color-surface-5', '#4A5C56'),
  border: resolveCssColor(container, '--color-surface-1', '#151F1B'),
  muted: resolveCssColor(container, '--muted', '#9FB2A7'),
  grid: resolveCssColor(container, '--color-border-strong', '#34423B'),
  tooltipBackground: resolveCssColor(container, '--color-overlay-toast', 'rgba(12, 17, 27, 0.92)'),
  tooltipText: resolveCssColor(container, '--color-semantic-text-primary', '#E6ECF5'),
  tooltipBorder: resolveCssColor(container, '--color-border-medium', 'rgba(255, 255, 255, 0.15)'),
});

export const disposePowerWeekChart = () => {
  if (plotResizeObserver) {
    plotResizeObserver.disconnect();
    plotResizeObserver = null;
  }
  if (plot) {
    plot.dispose();
    plot = null;
  }
  plotContainer = null;
};

const ensurePlot = (container: HTMLElement): EChartsType => {
  if (plot && plotContainer === container) return plot;

  disposePowerWeekChart();
  container.replaceChildren();

  plot = initEcharts(container, undefined, {
    renderer: 'svg',
    ...resolveChartSize(container),
  });
  plotContainer = container;
  container.style.setProperty('-webkit-tap-highlight-color', 'transparent');

  if (typeof ResizeObserver === 'function') {
    plotResizeObserver = new ResizeObserver(() => {
      if (!plot || plotContainer !== container) return;
      plot.resize(resolveChartSize(container));
    });
    plotResizeObserver.observe(container);
  }

  return plot;
};

const getLocalHour = (date: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === 'hour');
  const hour = Number(hourPart?.value ?? 0);
  return Number.isFinite(hour) ? hour % 24 : 0;
};

const buildDayLabels = (startMs: number, numDays: number, timeZone: string): string[] => {
  const labels: string[] = [];
  for (let i = 0; i < numDays; i += 1) {
    const day = new Date(startMs + i * 24 * 60 * 60 * 1000);
    labels.push(formatDateInTimeZone(day, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone));
  }
  return labels;
};

const buildHourLabels = (): string[] => (
  Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
);

type HeatCell = {
  value: [number, number, number];
  itemStyle?: { color: string };
};

const getDayOffsetFromStart = (entry: PowerUsageEntry, startMs: number, timeZone: string): number => {
  const hourOfDay = getLocalHour(entry.hour, timeZone);
  const dayStartMs = entry.hour.getTime() - hourOfDay * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((dayStartMs - startMs) / dayMs);
};

const buildHeatmapDataFixed = (
  entries: PowerUsageEntry[],
  startMs: number,
  numDays: number,
  timeZone: string,
  palette: HeatmapPalette,
): HeatCell[] => (
  entries
    .map((entry) => {
      const dayOffset = getDayOffsetFromStart(entry, startMs, timeZone);
      if (dayOffset < 0 || dayOffset >= numDays) return null;
      const hour = getLocalHour(entry.hour, timeZone);
      const cell: HeatCell = { value: [dayOffset, hour, entry.kWh] };
      if (entry.unreliable) cell.itemStyle = { color: palette.cellUnreliable };
      return cell;
    })
    .filter((cell): cell is HeatCell => cell !== null)
);

const buildTooltipFormatter = (
  dayLabels: string[],
) => (rawParams: unknown): string => {
  const params: unknown = Array.isArray(rawParams) ? rawParams[0] : rawParams;
  if (!params || typeof params !== 'object') return '';
  const { data } = params as { data?: HeatCell };
  if (!data) return '';
  const [dayIdx, hour, kWh] = data.value as [number, number, number];
  const dayLabel = dayLabels[dayIdx] ?? '';
  const hourStr = String(hour).padStart(2, '0');
  const nextHour = String((hour + 1) % 24).padStart(2, '0');
  return [
    encodeHtml(dayLabel),
    encodeHtml(`${hourStr}:00–${nextHour}:00`),
    encodeHtml(`${(kWh as number).toFixed(2)} kWh`),
  ].join('<br/>');
};

const buildOption = (params: {
  entries: PowerUsageEntry[];
  startMs: number;
  numDays: number;
  timeZone: string;
  container: HTMLElement;
  globalMinKWh: number;
  globalMaxKWh: number;
}): EChartsOption => {
  const {
    entries,
    startMs,
    numDays,
    timeZone,
    container,
    globalMinKWh,
    globalMaxKWh,
  } = params;

  const palette = resolvePalette(container);
  const dayLabels = buildDayLabels(startMs, numDays, timeZone);
  const hourLabels = buildHourLabels();
  const data = buildHeatmapDataFixed(entries, startMs, numDays, timeZone, palette);

  return {
    animation: false,
    stateAnimation: { duration: 0 },
    hoverLayerThreshold: Infinity,
    grid: {
      left: 8,
      right: 56,
      top: 8,
      bottom: 8,
      containLabel: true,
    },
    tooltip: {
      trigger: 'item',
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
      formatter: buildTooltipFormatter(dayLabels),
    },
    visualMap: {
      min: globalMinKWh,
      max: globalMaxKWh,
      show: true,
      orient: 'vertical',
      right: 0,
      top: 'center',
      itemWidth: 8,
      itemHeight: 80,
      text: [`${globalMaxKWh.toFixed(1)}`, `${globalMinKWh.toFixed(1)}`],
      textStyle: { color: palette.muted, fontSize: 9 },
      inRange: {
        color: [HEATMAP_COLOR_LOW, HEATMAP_COLOR_HIGH],
      },
    },
    xAxis: {
      type: 'category',
      data: dayLabels.map((label) => label.split(',')[0] ?? label),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      axisLabel: {
        color: palette.muted,
        fontSize: 10,
      },
      splitArea: { show: false },
    },
    yAxis: {
      type: 'category',
      data: hourLabels,
      inverse: true,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 10,
        formatter: (_label: string, index: number) => (index % 6 === 0 ? hourLabels[index] : ''),
      },
      splitArea: { show: false },
    },
    series: [
      {
        type: 'heatmap',
        data,
        itemStyle: {
          borderWidth: 1,
          borderColor: palette.border,
          borderRadius: 2,
        },
        emphasis: { disabled: true },
        blur: { disabled: true },
        select: { disabled: true },
      },
    ],
  };
};

export const renderPowerWeekChart = (params: {
  container: HTMLElement;
  entries: PowerUsageEntry[];
  startMs: number;
  endMs: number;
  timeZone: string;
  globalMinKWh?: number;
  globalMaxKWh?: number;
}): boolean => {
  const {
    container,
    entries,
    startMs,
    endMs,
    timeZone,
    globalMinKWh,
    globalMaxKWh,
  } = params;
  try {
    const kWhValues = entries.map((e) => e.kWh);
    const localMinKWh = kWhValues.length > 0 ? Math.min(...kWhValues) : 0;
    const localMaxKWh = Math.max(0.1, ...kWhValues);
    const resolvedGlobalMinKWh = Math.min(localMinKWh, globalMinKWh ?? localMinKWh);
    const resolvedGlobalMaxKWh = Math.max(localMaxKWh, globalMaxKWh ?? localMaxKWh);
    const numDays = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000));
    const chart = ensurePlot(container);
    chart.resize(resolveChartSize(container));
    chart.setOption(
      buildOption({
        entries, startMs, numDays, timeZone, container,
        globalMinKWh: resolvedGlobalMinKWh, globalMaxKWh: resolvedGlobalMaxKWh,
      }),
      { notMerge: true },
    );
    return true;
  } catch (error) {
    console.warn('Power week heatmap: echarts render failed', error);
    disposePowerWeekChart();
    return false;
  }
};
