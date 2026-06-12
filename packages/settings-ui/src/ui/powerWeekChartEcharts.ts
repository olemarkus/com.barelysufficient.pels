import { attachTabShownResize } from './chartVisibilityResize.ts';
import { readChartPalette } from './dayViewChart.ts';
import { logSettingsWarn } from './logging.ts';
import { initEcharts, type EChartsOption, type EChartsType } from './echartsRegistry.ts';
import {
  buildChartTooltipBase,
  buildPowerWeekReadout,
  readoutToTooltipHtml,
  resolveTooltipDataIndex,
  type ChartReadoutContent,
} from './chartTooltipFormat.ts';
import {
  attachChartReadout,
  prefersCoarsePointer,
  resolveGridCellFromPixel,
  type ChartReadoutHandle,
} from './chartReadout.ts';
import {
  formatDateInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  shiftDateKey,
} from './timezone.ts';
import type { UsageDayEntry } from './usageDayView.ts';

type PowerUsageEntry = UsageDayEntry;

type HeatmapPalette = {
  cellUnreliable: string;
  border: string;
  muted: string;
  grid: string;
  warn: string;
  heatmapLow: string;
  heatmapHigh: string;
  // On-surface high-contrast tone for the selected cell's border — the same
  // selection identity the other Usage-tab charts use (`palette.text` in
  // `usageDayChartEcharts.ts`), deliberately NOT `--pels-chart-current-border`
  // (that colour is reserved for the current-hour marker).
  text: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

// Fallback matches the `--pels-chart-week-height` token value in
// `tokens/component.json` (currently a literal `240px`). Reading the token
// via `getComputedStyle` keeps the ECharts viewport in lockstep with the
// `.power-week-chart` container box (`height`/`min-height` in
// `public/style.css`) without two parallel literals.
const DEFAULT_CHART_HEIGHT_FALLBACK = 240;
const CHART_HEIGHT_VAR = '--pels-chart-week-height';
const DEFAULT_CHART_WIDTH = 480;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_POWER_HEATMAP_DATE_KEYS = 370;

let plot: EChartsType | null = null;
let plotContainer: HTMLElement | null = null;
let plotResizeObserver: ResizeObserver | null = null;

const resolveChartHeight = (element: HTMLElement): number => {
  const raw = getComputedStyle(element).getPropertyValue(CHART_HEIGHT_VAR).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHART_HEIGHT_FALLBACK;
};

const resolveChartSize = (element: HTMLElement) => {
  const width = element.clientWidth > 0
    ? element.clientWidth
    : (element.parentElement?.clientWidth ?? 0);
  const viewportWidth = document.documentElement?.clientWidth ?? 0;
  const fallbackWidth = viewportWidth > 0
    ? Math.min(DEFAULT_CHART_WIDTH, viewportWidth)
    : DEFAULT_CHART_WIDTH;
  return { width: width > 0 ? width : fallbackWidth, height: resolveChartHeight(element) };
};

const HEATMAP_PALETTE_VARS = {
  cellUnreliable: '--pels-chart-unreliable-cell',
  border: '--pels-chart-heatmap-border',
  muted: '--pels-chart-muted',
  grid: '--pels-chart-grid',
  warn: '--pels-chart-warn',
  heatmapLow: '--pels-chart-heatmap-low',
  heatmapHigh: '--pels-chart-heatmap-high',
  text: '--text',
  tooltipBackground: '--pels-chart-tooltip-bg',
  tooltipText: '--pels-chart-tooltip-text',
  tooltipBorder: '--pels-chart-tooltip-border',
} as const satisfies Record<keyof HeatmapPalette, string>;

const resolvePalette = (container: HTMLElement): HeatmapPalette => (
  readChartPalette<HeatmapPalette>(container, HEATMAP_PALETTE_VARS)
);

// Fallback matches the `--pels-chart-cell-radius` token value in
// `tokens/component.json` (currently aliased to `{radius.xs}` = 2 px).
// Reading the token via `getComputedStyle` keeps the chart cell radius in
// lockstep with the legend swatch (`.usage-legend__swatch--unreliable`)
// without two parallel literals.
const HEATMAP_CELL_RADIUS_FALLBACK = 2;
const HEATMAP_CELL_RADIUS_VAR = '--pels-chart-cell-radius';

const resolveCellRadius = (container: HTMLElement): number => {
  const raw = getComputedStyle(container).getPropertyValue(HEATMAP_CELL_RADIUS_VAR).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : HEATMAP_CELL_RADIUS_FALLBACK;
};

let detachTabShownResize: (() => void) | null = null;
let plotReadout: ChartReadoutHandle | null = null;
let plotReadoutHost: HTMLElement | null = null;

// Container sizing (height / min-height / -webkit-tap-highlight-color) lives
// in `.power-week-chart` (see `packages/settings-ui/public/style.css`). This
// module owns the ECharts lifecycle only; CSS owns the physical footprint.
export const disposePowerWeekChart = (_container?: HTMLElement) => {
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
  plotContainer = null;
};

const ensurePlot = (container: HTMLElement, readoutHost: HTMLElement | null): EChartsType => {
  if (plot && plotContainer === container) return plot;

  disposePowerWeekChart();
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

// Format one local-day key (`2026-06-04`) as `Thu, Jun 4`. The instant MUST
// come from `getDateKeyStartMs` (local-day midnight in the given zone) — a
// UTC-midnight `Date` formatted in a negative-offset zone lands on the
// previous calendar day (off-by-one fixed in the Phase 3 Usage-tab PR; do
// not reintroduce it).
export const buildPowerWeekDayLabel = (dateKey: string, timeZone: string): string => {
  const day = new Date(getDateKeyStartMs(dateKey, timeZone));
  return formatDateInTimeZone(day, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);
};

const buildDayLabels = (dateKeys: string[], timeZone: string): string[] => (
  dateKeys.map((dateKey) => buildPowerWeekDayLabel(dateKey, timeZone))
);

const buildHourLabels = (): string[] => (
  Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
);

type HeatCell = {
  // ECharts keys select state by item name (`getSelectionKey` falls back to
  // the x-category value for unnamed cartesian items), so without a unique
  // per-cell name a single `select` rings the ENTIRE day column. Verified
  // against echarts 6.1.0: `selectedMode: false` also silences *dispatched*
  // select actions, so suppressing the native click-toggle is not an option —
  // unique names are the only mechanism that confines the ring to one cell.
  name: string;
  value: [number, number, number];
  bucketCount: number;
  unreliable: boolean;
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
      if (entry.unreliable) {
        existing.unreliable = true;
        existing.itemStyle = { color: palette.cellUnreliable };
      }
      continue;
    }
    const cell: HeatCell = {
      name: key,
      value: [dayOffset, hour, entry.kWh],
      bucketCount: 1,
      unreliable: entry.unreliable === true,
    };
    if (entry.unreliable) cell.itemStyle = { color: palette.cellUnreliable };
    cellsByKey.set(key, cell);
  }
  return [...cellsByKey.values()].sort((a, b) => (
    a.value[0] - b.value[0] || a.value[1] - b.value[1]
  ));
};

// One structured content object per cell, feeding both the desktop hover
// tooltip and the pinned touch readout (one grammar, identical information).
// The `kWh total` suffix on aggregated cells already signals that the number
// sums more than one physical hour, so a separate "N measured hours" line is
// redundant and exposes internal vocabulary (`bucket`).
const buildCellReadouts = (cells: HeatCell[], dayLabels: string[]): ChartReadoutContent[] => (
  cells.map((cell) => buildPowerWeekReadout({
    dayLabel: dayLabels[cell.value[0]] ?? '',
    hour: cell.value[1],
    kWh: cell.value[2],
    aggregated: cell.bucketCount > 1,
    unreliable: cell.unreliable,
  }))
);

const buildTooltipFormatter = (readouts: ChartReadoutContent[], warnColor: string) => (
  (rawParams: unknown): string => {
    const index = resolveTooltipDataIndex(rawParams);
    if (index < 0 || index >= readouts.length) return '';
    return readoutToTooltipHtml(readouts[index], { warnColor });
  }
);

const buildOption = (params: {
  palette: HeatmapPalette;
  data: HeatCell[];
  readouts: ChartReadoutContent[];
  dayLabels: string[];
  container: HTMLElement;
  globalMinKWh: number;
  globalMaxKWh: number;
}): EChartsOption => {
  const {
    palette,
    data,
    readouts,
    dayLabels,
    container,
    globalMinKWh,
    globalMaxKWh,
  } = params;

  const cellRadius = resolveCellRadius(container);
  const hourLabels = buildHourLabels();

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
      ...buildChartTooltipBase(palette),
      // Heatmap cells are item-keyed, not axis-keyed — the shared base's
      // `trigger: 'axis'` would fire one box per column.
      trigger: 'item',
      show: !prefersCoarsePointer(),
      formatter: buildTooltipFormatter(readouts, palette.warn),
    },
    visualMap: {
      min: globalMinKWh,
      max: globalMaxKWh,
      show: true,
      // No hover-linkage indicator dot on the ramp: emphasis/blur are already
      // disabled on the series, and on touch the dot has no mouseout — it
      // appears on the first tap and lingers as a stale artifact.
      hoverLink: false,
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
        selectedMode: 'single',
        select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
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
  readoutHost?: HTMLElement | null;
  globalMinKWh?: number;
  globalMaxKWh?: number;
}): boolean => {
  const {
    container,
    entries,
    startMs,
    endMs,
    timeZone,
    readoutHost = null,
    globalMinKWh,
    globalMaxKWh,
  } = params;
  try {
    const dateKeys = buildDateKeysForRange(startMs, endMs, timeZone);
    const localRange = resolvePowerWeekChartValueRange(entries, timeZone, dateKeys);
    const resolvedGlobalMinKWh = Math.min(localRange.minKWh, globalMinKWh ?? localRange.minKWh);
    const resolvedGlobalMaxKWh = Math.max(localRange.maxKWh, globalMaxKWh ?? localRange.maxKWh);
    const chart = ensurePlot(container, readoutHost);
    const palette = resolvePalette(container);
    const dayLabels = buildDayLabels(dateKeys, timeZone);
    const data = buildHeatmapDataFixed(entries, dateKeys, timeZone, palette);
    const readouts = buildCellReadouts(data, dayLabels);
    chart.resize(resolveChartSize(container));
    chart.setOption(
      buildOption({
        palette, data, readouts, dayLabels, container,
        globalMinKWh: resolvedGlobalMinKWh, globalMaxKWh: resolvedGlobalMaxKWh,
      }),
      { notMerge: true },
    );
    if (plotReadout && plotReadoutHost) {
      // Cells are sorted (day, hour) ascending, so the last entry is the most
      // recent cell with data — the default selection is never an empty cell.
      const indexByCell = new Map(data.map((cell, index) => (
        [resolveHeatCellKey(String(cell.value[0]), cell.value[1]), index] as const
      )));
      // No selectable cells (empty week) -> keep the caption slot hidden
      // rather than showing an empty row under the no-data message.
      plotReadoutHost.hidden = data.length === 0;
      plotReadout.update({
        itemCount: data.length,
        defaultIndex: data.length - 1,
        resolveContent: (index) => (
          index >= 0 && index < readouts.length ? readouts[index] : null
        ),
        resolveIndexFromPixel: (x, y) => {
          const cell = resolveGridCellFromPixel(chart, x, y);
          if (!cell) return null;
          return indexByCell.get(resolveHeatCellKey(String(cell.columnIndex), cell.rowIndex)) ?? null;
        },
      });
    }
    return true;
  } catch (error) {
    void logSettingsWarn('Power week heatmap: echarts render failed', error, 'powerWeekChart');
    disposePowerWeekChart(container);
    return false;
  }
};
