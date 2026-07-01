import { initEcharts, type EChartsOption, type EChartsType, type SeriesOption } from './echartsRegistry.ts';
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
  splitCoversMeasured,
  type ChartReadoutContent,
} from './chartTooltipFormat.ts';
import { attachChartReadout, prefersCoarsePointer, type ChartReadoutHandle } from './chartReadout.ts';
import { attachTabShownResize } from './chartVisibilityResize.ts';
import {
  SPLIT_BACKGROUND_LABEL,
  SPLIT_MANAGED_LABEL,
} from '../../../shared-domain/src/dailyBudgetHeroStrings.ts';

// Per-hour managed/background attribution (kWh), resolved upstream by
// `resolveUsageSplit`; null when the hour carries no split data.
export type UsageDaySplit = {
  managedKWh: number;
  backgroundKWh: number;
};

type UsageDayChartEchartsParams = {
  bars: DayViewBar[];
  // Parallel to `bars`: the hour's managed/background split, or null. Hours
  // without a split render as a single Measured-toned bar.
  splits?: Array<UsageDaySplit | null>;
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
  managed: string;
  background: string;
  unattributed: string;
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
  managed: '--pels-chart-managed',
  background: '--pels-chart-background',
  unattributed: '--pels-chart-unattributed',
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

// Per-hour stack decomposition. The encoding is honest by construction: the
// three stacked segments (background + managed + unattributed) always sum to
// the hour's measured total, so the stacked bar is exactly as tall as the
// former single Measured bar. Hours that cannot show a trustworthy split
// (no split data, unreliable/warn hours, zero measurement) fall back to a
// single full-height bar carried by the Measured series instead.
export type UsageDayStackSegments = {
  backgroundKWh: number;
  managedKWh: number;
  // Measured remainder the split does not attribute (gross tracking gap).
  // Rendered as a neutral segment rather than inflating either side.
  unattributedKWh: number;
  // Non-null = the hour renders as a single Measured-toned bar of this value
  // (the stacked segments are all zero). Null = the stack renders.
  fallbackKWh: number | null;
};

// Below this measurement a stack would be sub-pixel ink: the two segments of
// an early in-progress hour would each render under ~1px at typical axis
// scales. Such hours fall back to the single Measured bar, whose
// `barMinHeight: 2` keeps a visible stub (the readout still carries the
// split numbers).
const MIN_SPLIT_RENDER_KWH = 0.05;

export const resolveUsageDayStackSegments = (params: {
  measuredKWh: number;
  split: UsageDaySplit | null;
  warn: boolean;
}): UsageDayStackSegments => {
  const measured = Number.isFinite(params.measuredKWh) ? Math.max(0, params.measuredKWh) : 0;
  const empty = { backgroundKWh: 0, managedKWh: 0, unattributedKWh: 0 };
  // Warn hours render as the established full-height amber bar: the bar
  // withholds the split CLAIM for an hour whose samples have gaps, while the
  // tapped readout still carries the Managed/Background numbers alongside
  // the "Unreliable — some readings missing this hour" consequence line
  // (`notes/ui-terminology.md` § Usage tab chart readouts).
  if (!params.split || params.warn || measured <= MIN_SPLIT_RENDER_KWH) {
    return { ...empty, fallbackKWh: measured };
  }
  const managed = Number.isFinite(params.split.managedKWh) ? Math.max(0, params.split.managedKWh) : 0;
  const background = Number.isFinite(params.split.backgroundKWh) ? Math.max(0, params.split.backgroundKWh) : 0;
  const sum = managed + background;
  if (sum <= 0) return { ...empty, fallbackKWh: measured };
  if (splitCoversMeasured(sum, measured)) {
    // The split accounts for the whole measurement (shared epsilon absorbs
    // ±1e-13-scale tracker float drift — without it, most hours would grow an
    // invisible unattributed sliver that steals the rounded top corners).
    // When the gross sum exceeds the measured net (self-consumed solar), the
    // proportional rescale keeps the bar at the measured total while the
    // readout carries the unscaled gross figures with its "Before solar:"
    // prefix — the same epsilon decides both, so bar and readout agree.
    const scale = measured / sum;
    return {
      backgroundKWh: background * scale,
      managedKWh: managed * scale,
      unattributedKWh: 0,
      fallbackKWh: null,
    };
  }
  return {
    backgroundKWh: background,
    managedKWh: managed,
    unattributedKWh: measured - sum,
    fallbackKWh: null,
  };
};

// Rounded top corners follow the topmost rendered segment of each column so a
// stacked bar keeps the single bar's silhouette. The bottom-most segment is
// the marker carrier: per-segment borders on a stacked column would draw
// divider lines across the segment boundaries, so both the current-hour
// border and the tap-select border outline only the bottom segment (its
// left/right/bottom edges trace the column silhouette).
type StackSegmentKind = 'background' | 'managed' | 'unattributed';

const topSegmentOf = (stack: UsageDayStackSegments): StackSegmentKind | null => {
  if (stack.fallbackKWh !== null) return null;
  if (stack.unattributedKWh > 0) return 'unattributed';
  if (stack.managedKWh > 0) return 'managed';
  if (stack.backgroundKWh > 0) return 'background';
  return null;
};

const bottomSegmentOf = (stack: UsageDayStackSegments): StackSegmentKind | null => {
  if (stack.fallbackKWh !== null) return null;
  if (stack.backgroundKWh > 0) return 'background';
  if (stack.managedKWh > 0) return 'managed';
  if (stack.unattributedKWh > 0) return 'unattributed';
  return null;
};

const buildStackSegmentData = (params: {
  stacks: UsageDayStackSegments[];
  kind: StackSegmentKind;
  color: string;
  currentBucketIndex: number;
  enabled: boolean;
  palette: UsageDayPalette;
}) => {
  const { stacks, kind, color, currentBucketIndex, enabled, palette } = params;
  const valueOf = (stack: UsageDayStackSegments): number => {
    if (kind === 'background') return stack.backgroundKWh;
    if (kind === 'managed') return stack.managedKWh;
    return stack.unattributedKWh;
  };
  return stacks.map((stack, index) => {
    const isMarkerCarrier = bottomSegmentOf(stack) === kind;
    return {
      value: valueOf(stack),
      itemStyle: {
        color: enabled ? color : palette.disabled,
        opacity: resolveBarOpacity(enabled),
        borderWidth: isMarkerCarrier && currentBucketIndex >= 0 && index === currentBucketIndex ? 1 : 0,
        borderColor: palette.currentBorder,
        borderRadius: topSegmentOf(stack) === kind ? [4, 4, 0, 0] : [0, 0, 0, 0],
      },
      // Per-item select override: only the marker-carrier segment renders the
      // tap-select border (the series-level style would seam every boundary).
      select: {
        itemStyle: { borderColor: palette.text, borderWidth: isMarkerCarrier ? 2 : 0 },
      },
    };
  });
};

// Fallback single-bar series. Hours rendered by the stack get `null` (no data
// point at all — a zero would still paint a `barMinHeight` stub on top of the
// stacked column), and so do zero-value hours (future hours of the Today
// view): the legend deliberately has no entry for a zero stub, so rendering
// one would be unexplained ink.
const buildMeasuredData = (params: {
  bars: DayViewBar[];
  stacks: UsageDayStackSegments[];
  currentBucketIndex: number;
  enabled: boolean;
  palette: UsageDayPalette;
}) => {
  const {
    bars,
    stacks,
    currentBucketIndex,
    enabled,
    palette,
  } = params;
  return bars.map((bar, index) => {
    const stack = stacks[index];
    // `??` must not resurrect a null fallback (null means "the stack renders
    // this hour") — only an absent stack entry defaults to the bar value.
    const fallback = stack === undefined ? bar.value : stack.fallbackKWh;
    if (fallback === null || fallback <= 0) return null;
    return {
      value: fallback,
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
    };
  });
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

const buildLegendData = (params: {
  bars: DayViewBar[];
  stacks: UsageDayStackSegments[];
  hasWarnBars: boolean;
}): string[] => {
  const { bars, stacks, hasWarnBars } = params;
  const hasSplitBars = stacks.some((stack) => stack.fallbackKWh === null);
  // A "Measured" legend entry is only needed for visible fallback bars
  // alongside a split (warn bars are covered by the "Warning" entry, and
  // zero-value future-hour stubs carry no information worth a legend row).
  const hasMeasuredFallbackBars = stacks.some((stack, index) => (
    stack.fallbackKWh !== null && stack.fallbackKWh > 0 && !isWarnBar(bars[index])
  ));
  return [
    ...(hasSplitBars ? [SPLIT_BACKGROUND_LABEL, SPLIT_MANAGED_LABEL] : []),
    ...(!hasSplitBars || hasMeasuredFallbackBars ? ['Measured'] : []),
    ...(hasWarnBars ? ['Warning'] : []),
  ];
};

// Bar series plus the indexes the pinned readout dispatches its column
// select to — colocated so the dispatch list can never drift from the series
// ordering (the Warning legend-binder stub is excluded: it has no data and
// select is disabled on it).
const buildBarSeries = (params: {
  bars: DayViewBar[];
  stacks: UsageDayStackSegments[];
  currentBucketIndex: number;
  enabled: boolean;
  palette: UsageDayPalette;
  hasWarnBars: boolean;
}): { series: SeriesOption[]; selectSeriesIndexes: number[] } => {
  const { bars, stacks, currentBucketIndex, enabled, palette, hasWarnBars } = params;
  const shared = {
    type: 'bar' as const,
    stack: 'measured',
    barMaxWidth: 18,
    emphasis: { disabled: true },
    blur: { disabled: true },
    selectedMode: 'single' as const,
    select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
  };
  const selectable: SeriesOption[] = [
    // Stacked managed/background attribution (mirrors the Budget hourly
    // chart's Background-bottom / Managed-top stack). The three stack
    // series always exist so series indexes stay stable for the readout's
    // column select dispatch; hours without a split simply carry zeros here
    // and render through the Measured fallback series instead. Within a
    // stacked column, only the bottom-most segment's per-item select style
    // paints the border (see `buildStackSegmentData`).
    {
      ...shared,
      name: SPLIT_BACKGROUND_LABEL,
      data: buildStackSegmentData({
        stacks, kind: 'background', color: palette.background, currentBucketIndex, enabled, palette,
      }),
      itemStyle: { color: palette.background },
    },
    {
      ...shared,
      name: SPLIT_MANAGED_LABEL,
      data: buildStackSegmentData({
        stacks, kind: 'managed', color: palette.managed, currentBucketIndex, enabled, palette,
      }),
      itemStyle: { color: palette.managed },
    },
    // Measured remainder the split does not attribute. Kept OFF the legend
    // (rare tracking-gap artifact; the readout carries the exact numbers) —
    // rendered in a neutral surface tone one step above the disabled-bar
    // fill so a claim-free region is visible without claiming a meaning.
    {
      ...shared,
      name: 'Unattributed',
      data: buildStackSegmentData({
        stacks, kind: 'unattributed', color: palette.unattributed, currentBucketIndex, enabled, palette,
      }),
      itemStyle: { color: palette.unattributed },
    },
    {
      ...shared,
      name: 'Measured',
      data: buildMeasuredData({ bars, stacks, currentBucketIndex, enabled, palette }),
      barMinHeight: 2,
      itemStyle: { color: palette.measured },
    },
  ];
  const series: SeriesOption[] = [
    ...selectable,
    // Zero-data dummy series so the legend's "Warning" entry has a real
    // series to bind to. The "Measured" series colours warning bars
    // per-item, so without this stub ECharts silently drops the legend
    // label (TODO 1122 — fixed v2.7.0). Empty `data` produces no bars, so
    // adding the series only affects the legend; the `barMaxWidth` cap on
    // every series prevents any width competition. Only added when warn
    // bars exist so the legend stays terse in the common case.
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
  ];
  return { series, selectSeriesIndexes: selectable.map((_, index) => index) };
};

const buildOption = (params: UsageDayChartEchartsParams): {
  option: EChartsOption;
  selectSeriesIndexes: number[];
} => {
  const {
    bars,
    splits = [],
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
  const stacks = bars.map((bar, index) => resolveUsageDayStackSegments({
    measuredKWh: bar.value,
    split: splits[index] ?? null,
    warn: isWarnBar(bar),
  }));
  const { series, selectSeriesIndexes } = buildBarSeries({
    bars, stacks, currentBucketIndex, enabled, palette, hasWarnBars,
  });

  const option: EChartsOption = {
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
      data: buildLegendData({ bars, stacks, hasWarnBars }),
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
    series,
  };
  return { option, selectSeriesIndexes };
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
    const { option, selectSeriesIndexes } = buildOption(params);
    chart.setOption(option, { notMerge: true });
    if (plotReadout && plotReadoutHost) {
      plotReadoutHost.hidden = false;
      plotReadout.update({
        itemCount: bars.length,
        defaultIndex: defaultReadoutIndex,
        // Dispatch the column select to every selectable bar series; within a
        // stacked column the per-item select style paints the border on the
        // bottom-most segment only (see `buildStackSegmentData`).
        selectSeriesIndexes,
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
