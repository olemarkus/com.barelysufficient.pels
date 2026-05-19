import { attachTabShownResize } from './chartVisibilityResize.ts';
import { readChartPalette } from './dayViewChart.ts';
import { encodeHtml, initEcharts, type EChartsOption, type EChartsType } from './echartsRegistry.ts';
import {
  formatDateInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  shiftDateKey,
} from './timezone.ts';
import type { UsageDayEntry } from './usageDayView.ts';
import { formatPowerUsageHourlyTotal } from '../../../shared-domain/src/powerUsageStrings.ts';

type PowerUsageEntry = UsageDayEntry;

type HeatmapPalette = {
  cellUnreliable: string;
  border: string;
  muted: string;
  grid: string;
  heatmapLow: string;
  heatmapHigh: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

const DEFAULT_CHART_HEIGHT = 240;
const DEFAULT_CHART_WIDTH = 480;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_POWER_HEATMAP_DATE_KEYS = 370;

let plot: EChartsType | null = null;
let plotContainer: HTMLElement | null = null;
let plotResizeObserver: ResizeObserver | null = null;

const resolveChartSize = (element: HTMLElement) => {
  const width = element.clientWidth > 0
    ? element.clientWidth
    : (element.parentElement?.clientWidth ?? 0);
  const viewportWidth = document.documentElement?.clientWidth ?? 0;
  const fallbackWidth = viewportWidth > 0
    ? Math.min(DEFAULT_CHART_WIDTH, viewportWidth)
    : DEFAULT_CHART_WIDTH;
  return { width: width > 0 ? width : fallbackWidth, height: DEFAULT_CHART_HEIGHT };
};

const HEATMAP_PALETTE_VARS = {
  cellUnreliable: '--pels-chart-unreliable-cell',
  border: '--pels-chart-heatmap-border',
  muted: '--pels-chart-muted',
  grid: '--pels-chart-grid',
  heatmapLow: '--pels-chart-heatmap-low',
  heatmapHigh: '--pels-chart-heatmap-high',
  tooltipBackground: '--pels-chart-tooltip-bg',
  tooltipText: '--pels-chart-tooltip-text',
  tooltipBorder: '--pels-chart-tooltip-border',
} as const satisfies Record<keyof HeatmapPalette, string>;

const resolvePalette = (container: HTMLElement): HeatmapPalette => (
  readChartPalette<HeatmapPalette>(container, HEATMAP_PALETTE_VARS)
);

// Fallback matches the `--radius-xs` token value in `tokens/base.json`. Reading
// the token via `getComputedStyle` keeps the chart cell radius in lockstep with
// the legend swatch (`.usage-legend__swatch--unreliable`) without two parallel
// literals.
const HEATMAP_CELL_RADIUS_FALLBACK = 2;

const resolveCellRadius = (container: HTMLElement): number => {
  const raw = getComputedStyle(container).getPropertyValue('--radius-xs').trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : HEATMAP_CELL_RADIUS_FALLBACK;
};

let detachTabShownResize: (() => void) | null = null;

const clearPlotInlineStyles = (container: HTMLElement | null) => {
  if (!container) return;
  container.style.removeProperty('height');
  container.style.removeProperty('min-height');
  container.style.removeProperty('-webkit-tap-highlight-color');
};

export const disposePowerWeekChart = (container?: HTMLElement) => {
  if (plotResizeObserver) {
    plotResizeObserver.disconnect();
    plotResizeObserver = null;
  }
  if (detachTabShownResize) {
    detachTabShownResize();
    detachTabShownResize = null;
  }
  if (plot) {
    plot.dispose();
    plot = null;
  }
  clearPlotInlineStyles(container ?? plotContainer);
  plotContainer = null;
};

const ensurePlot = (container: HTMLElement): EChartsType => {
  if (plot && plotContainer === container) return plot;

  disposePowerWeekChart();
  container.replaceChildren();
  container.style.setProperty('height', `${DEFAULT_CHART_HEIGHT}px`);
  container.style.setProperty('min-height', `${DEFAULT_CHART_HEIGHT}px`);

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

  detachTabShownResize = attachTabShownResize({ container, chart: plot, resolveSize: resolveChartSize });

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

const buildDateKeysForRange = (startMs: number, endMs: number, timeZone: string): string[] => {
  if (endMs <= startMs) return [];
  const nominalDayCount = Math.ceil((endMs - startMs) / MS_PER_DAY) + 2;
  if (nominalDayCount > MAX_POWER_HEATMAP_DATE_KEYS) {
    throw new RangeError(`Power week chart range spans ${nominalDayCount} days`);
  }
  const keys: string[] = [];
  let dateKey = getDateKeyInTimeZone(new Date(startMs), timeZone);
  for (let i = 0; i < nominalDayCount; i += 1) {
    const dayStartMs = getDateKeyStartMs(dateKey, timeZone);
    if (dayStartMs >= endMs) break;
    keys.push(dateKey);
    dateKey = shiftDateKey(dateKey, 1);
  }
  return keys;
};

const buildDayLabels = (dateKeys: string[], timeZone: string): string[] => {
  return dateKeys.map((dateKey) => {
    const day = new Date(getDateKeyStartMs(dateKey, timeZone));
    return formatDateInTimeZone(day, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);
  });
};

const buildHourLabels = (): string[] => (
  Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
);

type HeatCell = {
  value: [number, number, number];
  bucketCount: number;
  itemStyle?: { color: string };
};

const resolveHeatCellKey = (dateKey: string, hour: number): string => `${dateKey}:${hour}`;

export const resolvePowerWeekChartValueRange = (
  entries: PowerUsageEntry[],
  timeZone: string,
  dateKeys?: string[],
): { minKWh: number; maxKWh: number } => {
  const allowedDateKeys = dateKeys ? new Set(dateKeys) : null;
  const kWhByCell = new Map<string, number>();
  for (const entry of entries) {
    const dateKey = getDateKeyInTimeZone(entry.hour, timeZone);
    if (allowedDateKeys && !allowedDateKeys.has(dateKey)) continue;
    const hour = getLocalHour(entry.hour, timeZone);
    const key = resolveHeatCellKey(dateKey, hour);
    kWhByCell.set(key, (kWhByCell.get(key) ?? 0) + entry.kWh);
  }
  const values = [...kWhByCell.values()];
  return {
    minKWh: values.length > 0 ? Math.min(...values) : 0,
    maxKWh: Math.max(0.1, ...values),
  };
};

const buildHeatmapDataFixed = (
  entries: PowerUsageEntry[],
  dateKeys: string[],
  timeZone: string,
  palette: HeatmapPalette,
): HeatCell[] => {
  const dateKeyToIndex = new Map(dateKeys.map((dateKey, index) => [dateKey, index]));
  const cellsByKey = new Map<string, HeatCell>();
  for (const entry of entries) {
    const dateKey = getDateKeyInTimeZone(entry.hour, timeZone);
    const dayOffset = dateKeyToIndex.get(dateKey);
    if (dayOffset === undefined) continue;
    const hour = getLocalHour(entry.hour, timeZone);
    const key = resolveHeatCellKey(dateKey, hour);
    const existing = cellsByKey.get(key);
    if (existing) {
      existing.value[2] += entry.kWh;
      existing.bucketCount += 1;
      if (entry.unreliable) existing.itemStyle = { color: palette.cellUnreliable };
      continue;
    }
    const cell: HeatCell = { value: [dayOffset, hour, entry.kWh], bucketCount: 1 };
    if (entry.unreliable) cell.itemStyle = { color: palette.cellUnreliable };
    cellsByKey.set(key, cell);
  }
  return [...cellsByKey.values()].sort((a, b) => (
    a.value[0] - b.value[0] || a.value[1] - b.value[1]
  ));
};

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
  // The `kWh total` suffix on aggregated cells already signals that the number
  // sums more than one physical hour, so a separate "N measured hours" line is
  // redundant and exposes internal vocabulary (`bucket`).
  const kWhLabel = formatPowerUsageHourlyTotal(kWh, { aggregated: data.bucketCount > 1 });
  return [
    encodeHtml(dayLabel),
    encodeHtml(`${hourStr}:00–${nextHour}:00`),
    encodeHtml(kWhLabel),
  ].join('<br/>');
};

const buildOption = (params: {
  entries: PowerUsageEntry[];
  timeZone: string;
  dateKeys: string[];
  container: HTMLElement;
  globalMinKWh: number;
  globalMaxKWh: number;
}): EChartsOption => {
  const {
    entries,
    timeZone,
    dateKeys,
    container,
    globalMinKWh,
    globalMaxKWh,
  } = params;

  const palette = resolvePalette(container);
  const cellRadius = resolveCellRadius(container);
  const dayLabels = buildDayLabels(dateKeys, timeZone);
  const hourLabels = buildHourLabels();
  const data = buildHeatmapDataFixed(entries, dateKeys, timeZone, palette);

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
      // The visualMap legend on the right edge shows the kWh range that maps
      // to the colour ramp. Without the `kWh` unit label users can't tell
      // whether the numbers are kWh, kr/kWh, or W (TODO 2026-05-16 live walk).
      // Append `kWh` to the top label only — the bottom is always 0 (or near
      // it) and the unit is implied by the top sibling 6 px above.
      text: [`${globalMaxKWh.toFixed(1)} kWh`, `${globalMinKWh.toFixed(1)}`],
      textStyle: { color: palette.muted, fontSize: 9 },
      inRange: {
        color: [palette.heatmapLow, palette.heatmapHigh],
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
          borderRadius: cellRadius,
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
    const dateKeys = buildDateKeysForRange(startMs, endMs, timeZone);
    const localRange = resolvePowerWeekChartValueRange(entries, timeZone, dateKeys);
    const resolvedGlobalMinKWh = Math.min(localRange.minKWh, globalMinKWh ?? localRange.minKWh);
    const resolvedGlobalMaxKWh = Math.max(localRange.maxKWh, globalMaxKWh ?? localRange.maxKWh);
    const chart = ensurePlot(container);
    chart.resize(resolveChartSize(container));
    chart.setOption(
      buildOption({
        entries, timeZone, dateKeys, container,
        globalMinKWh: resolvedGlobalMinKWh, globalMaxKWh: resolvedGlobalMaxKWh,
      }),
      { notMerge: true },
    );
    return true;
  } catch (error) {
    console.warn('Power week heatmap: echarts render failed', error);
    disposePowerWeekChart(container);
    return false;
  }
};
