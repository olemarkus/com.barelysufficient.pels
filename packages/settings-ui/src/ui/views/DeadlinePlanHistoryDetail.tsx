import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import {
  formatPlanHistoryDeadlineLine,
  formatPlanHistoryObservedCoverage,
  formatPlanHistoryProgressLine,
  formatPlanHistoryReachedAtLine,
  resolveHistoryDetailChartData,
  type DeferredPlanHistoryChartData,
  type DeferredPlanHistoryChartPoint,
} from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { deadlineLabels } from '../../../../shared-domain/src/deadlineLabels.ts';
import {
  buildHistoryDetailHero,
  type DeadlinePlanHistoryHeroPayload,
} from '../deadlinePlanHistoryDetailHero.ts';
import { encodeHtml, initEcharts, type EChartsOption } from '../echartsRegistry.ts';
import { attachTabShownResize } from '../chartVisibilityResize.ts';

type Props = {
  entry: DeferredObjectivePlanHistoryEntry;
  timeZone: string;
  // Cost-unit suffix carried through from the boot prices (e.g. `kr`). Empty
  // string when unavailable — the history-detail mount doesn't fetch live
  // prices (bookmarked URLs work without them), so this is left empty by
  // default; the secondary line collapses to the kWh-only form.
  costUnit?: string;
};

// ─── Legacy kWh-bar chart (v3 fallback) ───────────────────────────────────────
//
// Kept intact so entries that predate PR 1's recorder (no `progressSamples`,
// no `kwhPerUnitMean` on either snapshot) still render a chart instead of an
// empty card. The producer returns `mode: 'legacy_kwh'` for these entries and
// the view falls through to `LegacyKwhChart` below.

type HourRow = {
  // `startsAtMs` is the row identity (sort + de-dupe key when both original
  // and final reference the same hour). `displayLabel` is the localized
  // string used only for chart axis rendering — keep them separate so the
  // dedupe logic can never accidentally key off a localized string.
  startsAtMs: number;
  displayLabel: string;
  originalKWh: number;
  finalKWh: number;
  observed: boolean;
};

const ONE_HOUR_MS = 3_600_000;

const formatHourLabel = (startsAtMs: number, timeZone: string): string => (
  new Date(startsAtMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  })
);

const floorToHour = (ms: number): number => Math.floor(ms / ONE_HOUR_MS) * ONE_HOUR_MS;
const ceilToHour = (ms: number): number => Math.ceil(ms / ONE_HOUR_MS) * ONE_HOUR_MS;

export const buildHistoryDetailRows = (
  original: DeferredObjectivePlanHistoryRevisionSnapshot | null,
  final: DeferredObjectivePlanHistoryRevisionSnapshot | null,
  observedIntervals: DeferredObjectivePlanHistoryEntry['observedIntervals'],
  timeZone: string,
  window: { startedAtMs: number; deadlineAtMs: number },
): HourRow[] => {
  // `finalKWh` is the planner's last word and the "primary" bar series the
  // chart fills. When only one snapshot was recorded we fall back to it so a
  // partial recording still renders bars instead of an empty chart. The
  // `originalKWh` column then mirrors the same source so the
  // "revisions differ" comparison in DeadlinePlanHistoryDetail short-circuits
  // cleanly and the overlay series stays suppressed.
  const primary = final ?? original;
  const overlay = final ? original : null;
  const byStart = new Map<number, { original: number; final: number }>();
  const upsert = (startsAtMs: number, key: 'original' | 'final', kwh: number): void => {
    const existing = byStart.get(startsAtMs) ?? { original: 0, final: 0 };
    existing[key] = kwh;
    byStart.set(startsAtMs, existing);
  };
  primary?.hours.forEach((hour) => {
    upsert(hour.startsAtMs, 'final', hour.plannedKWh);
    if (!overlay) upsert(hour.startsAtMs, 'original', hour.plannedKWh);
  });
  overlay?.hours.forEach((hour) => upsert(hour.startsAtMs, 'original', hour.plannedKWh));
  // Seed every hour in the deadline window so the chart x-axis spans
  // `[startedAtMs, deadlineAtMs]` even when the recorded plan only covers a
  // subset. Without this, a degenerate 1-hour plan renders as a single
  // floating bar with no temporal context. Iterate in absolute ms so DST
  // 23/25-hour windows produce the right hour count automatically.
  const windowStart = floorToHour(window.startedAtMs);
  const windowEnd = Math.max(ceilToHour(window.deadlineAtMs), windowStart + ONE_HOUR_MS);
  for (let ms = windowStart; ms < windowEnd; ms += ONE_HOUR_MS) {
    if (!byStart.has(ms)) byStart.set(ms, { original: 0, final: 0 });
  }
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  return starts.map((startsAtMs) => {
    const values = byStart.get(startsAtMs)!;
    const hourEnd = startsAtMs + ONE_HOUR_MS;
    const observed = observedIntervals.some((interval) => (
      interval.fromMs < hourEnd && interval.toMs > startsAtMs
    ));
    return {
      startsAtMs,
      displayLabel: formatHourLabel(startsAtMs, timeZone),
      originalKWh: values.original,
      finalKWh: values.final,
      observed,
    };
  });
};

type Palette = {
  device: string;
  deviceMuted: string;
  observed: string;
  text: string;
  muted: string;
  grid: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

const cssVar = (element: HTMLElement, name: string, fallback = ''): string => (
  getComputedStyle(element).getPropertyValue(name).trim() || fallback
);

const resolvePalette = (element: HTMLElement): Palette => ({
  device: cssVar(element, '--color-base-accent-default'),
  deviceMuted: cssVar(element, '--pels-surface-container-high'),
  observed: cssVar(element, '--color-role-good'),
  text: cssVar(element, '--text'),
  muted: cssVar(element, '--pels-text-supporting-color'),
  grid: cssVar(element, '--pels-surface-outline'),
  tooltipBackground: cssVar(element, '--color-overlay-toast'),
  tooltipText: cssVar(element, '--color-semantic-text-primary'),
  tooltipBorder: cssVar(element, '--color-border-medium'),
});

const resolveChartSize = (element: HTMLElement): { height: number; width: number } => {
  const parent = element.parentElement;
  const width = element.clientWidth > 0
    ? element.clientWidth
    : (parent?.clientWidth ?? Math.min(480, document.documentElement?.clientWidth ?? 360));
  // Default height matches `.deadline-horizon-chart` in style.css (240 px) so
  // a cold-mount inside a hidden panel sizes the chart consistently with the
  // post-resize value.
  return { width: Math.max(240, width), height: element.clientHeight > 0 ? element.clientHeight : 240 };
};

const INITIAL_SERIES_NAME = 'Initial schedule';
const REVISED_SERIES_NAME = 'Revised schedule';

const buildTooltip = (
  rows: HourRow[],
  hasOriginalSeries: boolean,
  hasFinalSeries: boolean,
  observedSeriesName: string,
) => (
  (rawParams: unknown): string => {
    const params = Array.isArray(rawParams) ? rawParams : [rawParams];
    const first = params.find((item): item is { dataIndex: number } => (
      Boolean(item) && typeof item === 'object' && Number.isInteger((item as { dataIndex?: unknown }).dataIndex)
    ));
    const row = first ? rows[first.dataIndex] : null;
    if (!row) return '';
    const lines = [`<strong>${encodeHtml(row.displayLabel)}</strong>`];
    if (hasOriginalSeries) lines.push(`${INITIAL_SERIES_NAME} ${row.originalKWh.toFixed(2)} kWh`);
    if (hasFinalSeries) lines.push(`${REVISED_SERIES_NAME} ${row.finalKWh.toFixed(2)} kWh`);
    lines.push(`${observedSeriesName} ${row.observed ? 'yes' : 'no'}`);
    return lines.join('<br>');
  }
);

export const buildHistoryDetailChartOption = (
  rows: HourRow[],
  palette: Palette,
  hasOriginalSeries: boolean,
  hasFinalSeries: boolean,
  observedSeriesName: string,
): EChartsOption => {
  const labels = rows.map((row) => row.displayLabel);
  const hasObservedSeries = rows.some((row) => row.observed);
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    legend: {
      top: 0,
      left: 0,
      // Pin the legend to the chart's full width and let ECharts wrap onto
      // additional lines as needed. Without `width: '100%'`, the legend would
      // assume an unbounded layout and labels like "Measured Heating" would
      // truncate to "Measured Heati…" inside a 320–480 px container. Matches
      // the legend behavior of the live deadline-plan chart.
      width: '100%',
      // The initial-schedule series renders as a `transparent` fill + dashed
      // device-coloured border. Pin its legend swatch to that same border so
      // the swatch is visible and matches the bar shown on the chart.
      data: [
        ...(hasOriginalSeries
          ? [{
            name: INITIAL_SERIES_NAME,
            itemStyle: {
              color: 'transparent',
              borderColor: palette.device,
              borderWidth: 2,
              borderType: 'dashed' as const,
            },
          }]
          : []),
        ...(hasFinalSeries ? [{ name: REVISED_SERIES_NAME, itemStyle: { color: palette.device } }] : []),
        ...(hasObservedSeries ? [{ name: observedSeriesName, itemStyle: { color: palette.observed } }] : []),
      ],
      itemWidth: 12,
      itemHeight: 8,
      icon: 'roundRect',
      textStyle: { color: palette.muted, fontSize: 11 },
      inactiveColor: palette.grid,
    },
    // `containLabel: true` lets ECharts auto-expand the grid to fit the
    // y-axis label width ("1.2 kWh" needs ~50 px, which a fixed `left: 36`
    // can't hold — the leading digit was rendering under the chart container's
    // left edge as `.2 kWh` on every history-detail row). `left: 8` is the
    // padding inside the auto-expanded grid; ECharts adds the label width on
    // top of it. `bottom: 32` makes equivalent room for the x-axis tick
    // labels under containLabel. `top: 44` matches the live `DeadlinePlan.tsx`
    // chart so a two-line legend (`width: '100%'`) has the same vertical
    // headroom on both surfaces.
    grid: { top: 44, left: 8, right: 16, bottom: 32, containLabel: true },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: true,
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.tooltipText },
      formatter: buildTooltip(rows, hasOriginalSeries, hasFinalSeries, observedSeriesName),
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        // Show roughly every-other-hour label for short windows and every third
        // for long windows so the axis stays readable at 480px. Always keep
        // the first and last labels so the chart's temporal extent is obvious.
        interval: (index: number) => (
          index === 0
          || index === labels.length - 1
          || index % (labels.length > 12 ? 3 : 2) === 0
        ),
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      splitNumber: 4,
      splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.text,
        fontSize: 11,
        formatter: (value: number) => (value === 0 ? '' : `${value.toFixed(1)} kWh`),
      },
    },
    series: [
      ...(hasOriginalSeries ? [{
        name: INITIAL_SERIES_NAME,
        type: 'bar' as const,
        barMaxWidth: 18,
        barGap: '-100%',
        itemStyle: {
          color: 'transparent',
          borderColor: palette.device,
          borderWidth: 2,
          borderType: 'dashed' as const,
          borderRadius: [3, 3, 0, 0] as [number, number, number, number],
        },
        data: rows.map((row) => row.originalKWh),
      }] : []),
      ...(hasFinalSeries ? [{
        name: REVISED_SERIES_NAME,
        type: 'bar' as const,
        barMaxWidth: 18,
        itemStyle: {
          color: palette.device,
          borderRadius: [3, 3, 0, 0] as [number, number, number, number],
        },
        data: rows.map((row) => row.finalKWh),
      }] : []),
      {
        name: observedSeriesName,
        type: 'scatter' as const,
        symbol: 'rect',
        symbolSize: [12, 4],
        symbolOffset: [0, 16],
        itemStyle: { color: palette.observed },
        data: rows.map((row, index) => (row.observed ? [index, 0] : null)).filter(Boolean),
      },
    ],
  };
};

// ─── Trajectory chart (v2.7.2 PR 4) ───────────────────────────────────────────
//
// Renders the planned staircase + observed-progress line on a single grid with
// the y-axis in unit space (°C / %). The producer in shared-domain resolves
// the staircase from `originalPlan.hours × kwhPerUnitMean`; this layer is a
// renderer that never inspects the raw entry.

const PLANNED_SERIES_NAME = 'Planned trajectory';
const PLANNED_REVISED_SERIES_NAME = 'Revised trajectory';
const TARGET_SERIES_NAME = 'Target';
const MET_MARK_NAME = 'Reached target';

const formatTrajectoryValue = (value: number, unit: '°C' | '%'): string => (
  unit === '°C' ? `${value.toFixed(1)} °C` : `${Math.round(value)} %`
);

const formatTrajectoryClock = (atMs: number, timeZone: string): string => (
  new Date(atMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  })
);

// Each line series carries `[ms, value]` tuples. ECharts' `time` xAxis maps
// these to clock positions automatically, so the legend / line ordering does
// not depend on a category-axis category index.
type TrajectorySeriesData = Array<[number, number]>;

const toEchartsData = (points: readonly DeferredPlanHistoryChartPoint[]): TrajectorySeriesData => (
  points.map((point) => [point.atMs, point.value])
);

// Resolve a min/max for the y-axis that always contains the target line and
// gives the observed/planned series a bit of headroom. Floors at 0 for `%`
// (SoC can't go below zero) but lets °C dip below 0 since cold-storage
// thermostats can legitimately span sub-zero. The 5 %/2 °C padding keeps the
// observed line from hugging the chart edge.
const resolveTrajectoryYRange = (
  data: DeferredPlanHistoryChartData,
): { min: number | 'dataMin'; max: number | 'dataMax' } => {
  const values: number[] = [];
  if (data.target !== null) values.push(data.target);
  for (const point of data.plannedOriginal) values.push(point.value);
  if (data.plannedFinal) for (const point of data.plannedFinal) values.push(point.value);
  for (const point of data.observed) values.push(point.value);
  if (values.length === 0) return { min: 'dataMin', max: 'dataMax' };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = data.unit === '%' ? 5 : 2;
  const lowerBound = data.unit === '%' ? Math.max(0, Math.floor(min - pad)) : Math.floor(min - pad);
  const upperBound = Math.ceil(max + pad);
  return { min: lowerBound, max: upperBound };
};

type TrajectoryTooltipPart = {
  seriesName: string;
  data?: unknown;
  value?: unknown;
  axisValue?: unknown;
};

// Pull the timestamp from the first tooltip part. ECharts emits `axisValue`
// for axis-triggered tooltips on a `time` xAxis; otherwise fall back to the
// first series' `[ms, value]` payload. Returns `null` only when both shapes
// fail, which the caller treats as "no hover position resolved".
const resolveTooltipAxisMs = (first: TrajectoryTooltipPart): number | null => {
  const candidateAxis = first.axisValue;
  if (typeof candidateAxis === 'number') return candidateAxis;
  if (Array.isArray(first.data)) {
    const ms = (first.data as unknown[])[0];
    if (typeof ms === 'number') return ms;
  }
  return null;
};

const resolveTooltipYValue = (part: TrajectoryTooltipPart): number | null => {
  if (Array.isArray(part.data)) {
    const y = (part.data as unknown[])[1];
    if (typeof y === 'number') return y;
  }
  if (typeof part.value === 'number') return part.value;
  return null;
};

const buildTrajectoryTooltip = (
  data: DeferredPlanHistoryChartData,
  timeZone: string,
  unit: '°C' | '%',
  observedSeriesName: string,
): ((raw: unknown) => string) => (raw: unknown): string => {
  const parts = Array.isArray(raw) ? (raw as TrajectoryTooltipPart[]) : [raw as TrajectoryTooltipPart];
  const first = parts[0];
  if (!first) return '';
  const axisMs = resolveTooltipAxisMs(first);
  if (axisMs === null) return '';
  const lines = [`<strong>${encodeHtml(formatTrajectoryClock(axisMs, timeZone))}</strong>`];
  for (const part of parts) {
    // Hide the target reference line from the tooltip — it's a fixed
    // horizontal guide, not a data series, so listing "Target 65.0 °C" at
    // every hover would be noise.
    if (part.seriesName === TARGET_SERIES_NAME) continue;
    const yValue = resolveTooltipYValue(part);
    if (yValue === null) continue;
    lines.push(`${encodeHtml(part.seriesName)} ${encodeHtml(formatTrajectoryValue(yValue, unit))}`);
  }
  // If the user is hovering over the planned line but no observed point lies
  // at this hour, surface that explicitly so the absence is honest (rather
  // than letting the tooltip silently omit the observed series).
  if (data.observed.length === 0 && data.plannedOriginal.length > 0) {
    lines.push(`${encodeHtml(observedSeriesName)} — not recorded`);
  }
  return lines.join('<br>');
};

export const buildHistoryDetailTrajectoryOption = (
  data: DeferredPlanHistoryChartData,
  palette: Palette,
  timeZone: string,
  observedSeriesName: string,
): EChartsOption => {
  // Trajectory-mode payloads always carry a unit; a `null` unit means a
  // caller wired a `legacy_kwh` payload through this builder, which would
  // silently render °C labels on a kWh dataset. Assert at the boundary.
  if (data.unit === null) {
    throw new Error('buildHistoryDetailTrajectoryOption requires a trajectory-mode payload (unit must be set)');
  }
  const unit: '°C' | '%' = data.unit;
  const hasPlannedOriginal = data.plannedOriginal.length > 0;
  const hasPlannedFinal = data.plannedFinal !== null && data.plannedFinal.length > 0;
  const hasObserved = data.observed.length > 0;
  const yRange = resolveTrajectoryYRange(data);
  // Pre-compose the legend label names — the original-staircase swatch reads
  // as "Planned" when there is no second revision, and "Initial plan"
  // (matching the legacy chart vocabulary) once the user has both lines on
  // the chart to compare.
  const originalLabel = hasPlannedFinal ? INITIAL_SERIES_NAME : PLANNED_SERIES_NAME;
  const revisedLabel = PLANNED_REVISED_SERIES_NAME;
  const legendData = [
    ...(hasPlannedOriginal
      ? [{
        name: originalLabel,
        itemStyle: { color: hasPlannedFinal ? 'transparent' : palette.device, borderColor: palette.device, borderWidth: 2 },
      }]
      : []),
    ...(hasPlannedFinal ? [{ name: revisedLabel, itemStyle: { color: palette.device } }] : []),
    ...(hasObserved ? [{ name: observedSeriesName, itemStyle: { color: palette.observed } }] : []),
    ...(data.target !== null
      ? [{ name: TARGET_SERIES_NAME, itemStyle: { color: 'transparent', borderColor: palette.muted, borderWidth: 1, borderType: 'dashed' as const } }]
      : []),
  ];
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    legend: {
      top: 0,
      left: 0,
      width: '100%',
      data: legendData,
      itemWidth: 12,
      itemHeight: 8,
      icon: 'roundRect',
      textStyle: { color: palette.muted, fontSize: 11 },
      inactiveColor: palette.grid,
    },
    grid: { top: 44, left: 8, right: 16, bottom: 32, containLabel: true },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: true,
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.tooltipText },
      formatter: buildTrajectoryTooltip(data, timeZone, unit, observedSeriesName),
    },
    xAxis: {
      type: 'time',
      min: data.windowStartMs,
      max: data.windowEndMs,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        hideOverlap: true,
        formatter: (ms: number): string => formatTrajectoryClock(ms, timeZone),
      },
    },
    yAxis: {
      type: 'value',
      min: yRange.min,
      max: yRange.max,
      splitNumber: 4,
      splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.text,
        fontSize: 11,
        formatter: (value: number) => formatTrajectoryValue(value, unit),
      },
    },
    series: [
      ...(hasPlannedOriginal ? [{
        name: originalLabel,
        type: 'line' as const,
        step: 'end' as const,
        showSymbol: false,
        // The original staircase is the planner's intent. When a revised
        // staircase overlays it, render the original as dashed-muted (the
        // "what we set out to do") so the eye lands on the revised one.
        lineStyle: hasPlannedFinal
          ? { color: palette.device, width: 2, type: 'dashed' as const, opacity: 0.7 }
          : { color: palette.device, width: 2 },
        itemStyle: { color: palette.device },
        data: toEchartsData(data.plannedOriginal),
        // The metAtMs marker sits on the planned staircase — the postmortem
        // sentence "Hit 65 °C at 11:57" lands here. Only attached to the
        // original series so a revised overlay doesn't double-mark.
        markPoint: data.metAtMs !== null && data.target !== null && !hasPlannedFinal
          ? {
            symbol: 'circle',
            symbolSize: 10,
            itemStyle: { color: palette.observed, borderColor: palette.text, borderWidth: 1 },
            label: { show: false },
            data: [{
              name: MET_MARK_NAME,
              coord: [data.metAtMs, data.target],
            }],
          }
          : undefined,
      }] : []),
      ...(hasPlannedFinal ? [{
        name: revisedLabel,
        type: 'line' as const,
        step: 'end' as const,
        showSymbol: false,
        lineStyle: { color: palette.device, width: 2 },
        itemStyle: { color: palette.device },
        data: toEchartsData(data.plannedFinal!),
        markPoint: data.metAtMs !== null && data.target !== null
          ? {
            symbol: 'circle',
            symbolSize: 10,
            itemStyle: { color: palette.observed, borderColor: palette.text, borderWidth: 1 },
            label: { show: false },
            data: [{
              name: MET_MARK_NAME,
              coord: [data.metAtMs, data.target],
            }],
          }
          : undefined,
      }] : []),
      ...(hasObserved ? [{
        name: observedSeriesName,
        type: 'line' as const,
        showSymbol: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { color: palette.observed, width: 2 },
        itemStyle: { color: palette.observed },
        data: toEchartsData(data.observed),
      }] : []),
      // Target reference as a dashed horizontal line. Rendered as a
      // single-segment line series spanning the window so it picks up the
      // x-axis time scale automatically (mark-lines on a `time` axis can
      // misbehave when the only y datum is `target`).
      ...(data.target !== null ? [{
        name: TARGET_SERIES_NAME,
        type: 'line' as const,
        showSymbol: false,
        silent: true,
        lineStyle: { color: palette.muted, width: 1, type: 'dashed' as const },
        data: [
          [data.windowStartMs, data.target],
          [data.windowEndMs, data.target],
        ] as TrajectorySeriesData,
      }] : []),
    ],
  };
};

// ─── Chart React wrapper ──────────────────────────────────────────────────────

// Shared ECharts mount: builds the option lazily (so the closure captures the
// fresh palette), wires the ResizeObserver + tab-shown resize, and disposes on
// unmount. `deps` controls when the chart re-renders; legacy vs trajectory
// callers pass their own data shape.
const useEchartsMount = (
  buildOption: (palette: Palette) => EChartsOption,
  deps: ReadonlyArray<unknown>,
): RefObject<HTMLDivElement> => {
  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = chartRef.current;
    if (!container) return undefined;
    const chart = initEcharts(container, undefined, {
      renderer: 'svg',
      ...resolveChartSize(container),
    });
    chart.setOption(buildOption(resolvePalette(container)), { notMerge: true });
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => chart.resize(resolveChartSize(container)))
      : null;
    resizeObserver?.observe(container);
    const detachTabShown = attachTabShownResize({ container, chart, resolveSize: resolveChartSize });
    return () => {
      resizeObserver?.disconnect();
      detachTabShown();
      chart.dispose();
    };
    // `buildOption` closes over the caller-supplied deps already; including
    // it here would re-mount on every render because the arrow recreates.
  }, deps);
  return chartRef;
};

const LegacyKwhChart = ({ rows, hasOriginalSeries, hasFinalSeries, observedSeriesName }: {
  rows: HourRow[];
  hasOriginalSeries: boolean;
  hasFinalSeries: boolean;
  observedSeriesName: string;
}) => {
  const chartRef = useEchartsMount(
    (palette) => buildHistoryDetailChartOption(
      rows,
      palette,
      hasOriginalSeries,
      hasFinalSeries,
      observedSeriesName,
    ),
    [rows, hasOriginalSeries, hasFinalSeries, observedSeriesName],
  );
  return (
    <div
      ref={chartRef}
      class="deadline-horizon-chart"
      role="img"
      aria-label="Initial schedule vs revised schedule charging hours"
    />
  );
};

const TrajectoryChart = ({ data, timeZone, observedSeriesName, ariaLabel }: {
  data: DeferredPlanHistoryChartData;
  timeZone: string;
  observedSeriesName: string;
  ariaLabel: string;
}) => {
  const chartRef = useEchartsMount(
    (palette) => buildHistoryDetailTrajectoryOption(data, palette, timeZone, observedSeriesName),
    [data, timeZone, observedSeriesName],
  );
  return (
    <div
      ref={chartRef}
      class="deadline-horizon-chart"
      role="img"
      aria-label={ariaLabel}
    />
  );
};

// Hero block — outcome-asymmetric. Branches on the resolved `tone` from the
// producer so the only condition the view layer reads is the recourse
// presence (which the producer already gates on outcome). The "Why" line
// is rendered separately from the postmortem because the postmortem is the
// outcome-shape sentence (PR 3) and the missed-reason is the action-oriented
// one (PR #856 P2 fold-in) — both useful on Missed, neither on Succeeded.
const HistoryDetailHero = ({
  hero,
  progressLine,
  reachedAtLine,
  coverageLine,
  revisionUpdatesLine,
}: {
  hero: DeadlinePlanHistoryHeroPayload;
  progressLine: string | null;
  reachedAtLine: string | null;
  coverageLine: string | null;
  revisionUpdatesLine: string | null;
}) => (
  <section
    class="pels-surface-card plan-history-detail__hero"
    data-tone={hero.tone}
  >
    <p class="eyebrow plan-history-detail__eyebrow">{hero.eyebrow}</p>
    <p class="plan-history-detail__outcome">
      <span class={`plan-chip plan-chip--${hero.chip.tone} plan-history-detail__outcome-chip`}>{hero.chip.text}</span>
    </p>
    <header class="plan-history-detail__hero-header">
      <h1 class="plan-card__title plan-history-detail__heading">
        {hero.heading.deviceName !== null && `${hero.heading.deviceName} — `}
        <span class="plan-history-detail__heading-when">{hero.heading.deadlineLine}</span>
      </h1>
    </header>
    <p class="plan-history-detail__postmortem" data-variant={hero.lead.variant}>{hero.lead.sentence}</p>
    {hero.secondary !== null && (
      <p class="plan-history-detail__secondary">{hero.secondary}</p>
    )}
    {hero.whyLine !== null && (
      <p class="plan-history-detail__missed-reason">Why: {hero.whyLine}</p>
    )}
    {hero.recourse !== null && (
      <div class="plan-hero__recourse plan-history-detail__recourse">
        <button
          type="button"
          class="plan-hero__recourse-button"
          data-deadline-recourse-tab={hero.recourse.targetTab}
        >
          {hero.recourse.label}
        </button>
      </div>
    )}
    {progressLine !== null && (
      <p class="plan-history-detail__progress">
        {progressLine}
        {reachedAtLine !== null && <span class="plan-history-detail__reached">  ·  {reachedAtLine}</span>}
      </p>
    )}
    {coverageLine !== null && <p class="pels-card-supporting">{coverageLine}</p>}
    {revisionUpdatesLine !== null && <p class="pels-card-supporting">{revisionUpdatesLine}</p>}
  </section>
);

const formatRevisionUpdatesLine = (revisionCount: number | undefined): string | null => {
  if (typeof revisionCount !== 'number' || revisionCount <= 1) return null;
  const count = revisionCount - 1;
  return `Schedule updated ${count} ${count === 1 ? 'time' : 'times'}.`;
};

// Card-title copy. Trajectory mode reads as "Progress vs schedule" — the
// chart shows the actual progression against the planned trajectory. Legacy
// mode keeps the existing "Scheduled vs observed" so the v3 fallback path
// reads consistently across surfaces.
const resolveChartCardTitle = (mode: DeferredPlanHistoryChartData['mode']): string => (
  mode === 'trajectory' ? 'Progress vs schedule' : 'Scheduled vs observed'
);

// Subtext shown under the chart card title for the legacy fallback. The
// trajectory chart's y-axis unit + line shapes carry the same information
// implicitly, so the line is suppressed there.
const LEGACY_FALLBACK_NOTE = 'Schedule only — observations not recorded for this run.';

export const DeadlinePlanHistoryDetail = ({ entry, timeZone, costUnit = '' }: Props) => {
  const deadlineLine = formatPlanHistoryDeadlineLine(entry, timeZone);
  const progressLine = formatPlanHistoryProgressLine(entry);
  const reachedAtLine = formatPlanHistoryReachedAtLine(entry, timeZone);
  const coverageLine = formatPlanHistoryObservedCoverage(entry);
  const revisionUpdatesLine = formatRevisionUpdatesLine(entry.revisionCount);
  // Producer-resolved hero payload. The view layer never branches on outcome
  // / planStatus / `dailyBudgetExhaustedBucketCount` — all of that resolution
  // lives in `buildHistoryDetailHero`.
  const hero = buildHistoryDetailHero({
    entry,
    timeZone,
    deadlineLine,
    costUnit,
  });
  // Succeeded heroes default the chart collapsed (`receipt-shape`); the view
  // toggles via `useState`. Missed heroes pass `chartCollapsedByDefault: false`
  // so the chart renders expanded and the user sees the diagnosis context.
  // Initial state mirrors the hero's per-outcome default; state reset across
  // entry navigation is handled by the parent's `key={entry.id}` prop, which
  // remounts this component on entry change rather than us managing
  // reset-via-useEffect inside.
  const [chartCollapsed, setChartCollapsed] = useState(hero.chartCollapsedByDefault);
  const chartData = resolveHistoryDetailChartData(entry);
  const labels = deadlineLabels(entry.objectiveKind);
  const observedSeriesName = labels.actualDeviceSeriesName;
  // Legacy mode also drives the row builder so the existing kWh-bar fallback
  // keeps rendering for v3 entries. Built unconditionally so the empty-chart
  // guard below sees a consistent shape; row computation is cheap.
  const rows = buildHistoryDetailRows(
    entry.originalPlan,
    entry.finalPlan,
    entry.observedIntervals,
    timeZone,
    { startedAtMs: entry.startedAtMs, deadlineAtMs: entry.deadlineAtMs },
  );
  const hasFinalSeries = Boolean(entry.finalPlan ?? entry.originalPlan);
  const hasOriginalSeries = Boolean(entry.originalPlan)
    && Boolean(entry.finalPlan)
    && rows.some((row) => Math.abs(row.originalKWh - row.finalKWh) > 0.001);
  // Screen-reader label mirrors the visible heading shape: scoping eyebrow
  // ("Smart task") → device name (when present) → timestamp.
  const ariaHeading = entry.deviceName
    ? `${entry.deviceName} — ${deadlineLine}`
    : deadlineLine;
  const trajectoryAriaLabel = `Progress trajectory for ${entry.deviceName ?? 'this smart task'}`;
  const hasChartData = chartData.mode === 'trajectory'
    ? (chartData.plannedOriginal.length > 0 || chartData.observed.length > 0)
    : (entry.originalPlan !== null || entry.finalPlan !== null);
  const chartCardTitle = resolveChartCardTitle(chartData.mode);
  const chartFallbackNote = chartData.mode === 'legacy_kwh' ? LEGACY_FALLBACK_NOTE : null;
  return (
    <article class="plan-history-detail" aria-label={`${hero.eyebrow} ${ariaHeading}`}>
      <HistoryDetailHero
        hero={hero}
        progressLine={progressLine}
        reachedAtLine={reachedAtLine}
        coverageLine={coverageLine}
        revisionUpdatesLine={revisionUpdatesLine}
      />
      {!hasChartData ? (
        <section class="pels-surface-card">
          <p class="pels-card-supporting">
            No hourly schedule was saved for this run.
          </p>
        </section>
      ) : (
        <section class="pels-surface-card budget-redesign-card deadline-horizon-card">
          <div class="budget-card-header">
            <h2 class="plan-card__title">{chartCardTitle}</h2>
            {hero.chartCollapsedByDefault && (
              <button
                type="button"
                class="plan-history-detail__chart-toggle"
                aria-expanded={!chartCollapsed}
                onClick={() => setChartCollapsed(!chartCollapsed)}
              >
                {chartCollapsed ? 'View schedule' : 'Hide schedule'}
              </button>
            )}
          </div>
          {!chartCollapsed && chartFallbackNote !== null && (
            <p class="pels-card-supporting">{chartFallbackNote}</p>
          )}
          {!chartCollapsed && chartData.mode === 'trajectory' && (
            <TrajectoryChart
              data={chartData}
              timeZone={timeZone}
              observedSeriesName={observedSeriesName}
              ariaLabel={trajectoryAriaLabel}
            />
          )}
          {!chartCollapsed && chartData.mode === 'legacy_kwh' && (
            <LegacyKwhChart
              rows={rows}
              hasOriginalSeries={hasOriginalSeries}
              hasFinalSeries={hasFinalSeries}
              observedSeriesName={observedSeriesName}
            />
          )}
        </section>
      )}
    </article>
  );
};
