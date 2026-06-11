import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  ResolvedDeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import {
  formatPlanHistoryDeadlineLine,
  resolveHistoryDetailChartData,
  resolveHistoryDetailHourlyStrip,
  historyDetailChartLabels,
  type DeferredPlanHistoryChartData,
  type DeferredPlanHistoryChartPoint,
  type DeferredPlanHistoryHourlyStripData,
  type HourlyStripBucket,
  type HistoryDetailChartLabels,
  formatPlanHistoryRevisionEntry,
  type PlanHistoryRevisionLogRow,
  formatPlanHistoryUsageDayLinkLabel,
} from '../../../../shared-domain/src/deferredPlanHistory.ts';
import {
  formatHistoryTrajectoryLegendTarget,
  resolveHistoryPlanChangeMarker,
  resolveHistoryRunBands,
  resolveHistoryStripReadout,
  resolveHistoryTrajectoryReadout,
  HISTORY_COMPARE_INITIAL_PLAN_LABEL,
  HISTORY_STRIP_LEGEND_PRICE_HIGH,
  HISTORY_STRIP_LEGEND_PRICE_LOW,
  HISTORY_STRIP_LEGEND_PRICE_NORMAL,
  HISTORY_STRIP_LEGEND_SKIPPED,
  HISTORY_TRAJECTORY_LEGEND_MEASURED,
  HISTORY_TRAJECTORY_LEGEND_PLANNED,
  SMART_TASK_HISTORY_STRIP_TITLE,
  type HistoryHourReadout,
  type HistoryPlanChangeMarker,
  type HistoryRunBand,
  type HistoryStripReadout,
} from '../../../../shared-domain/src/deferredPlanHistoryDetailInteraction.ts';
import {
  deadlineLabels,
  formatProgressValueForUnit,
  REVISION_REASON_FALLBACK_WITH_DETAIL,
  SMART_TASK_READOUT_SCRUB_HINT,
  SMART_TASK_USAGE_RETURN_LABEL,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import {
  buildHistoryDetailHero,
  type DeadlinePlanHistoryHeroPayload,
} from '../deadlinePlanHistoryDetailHero.ts';
import { attachHourScrub, resolveScrubHourIndex } from '../deadlineChartScrub.ts';
import { buildUsageDayHref } from '../deadlineUrls.ts';
import { encodeHtml, useEchartsMount, type EChartsOption, type EChartsType } from '../echartsRegistry.ts';
import { MdSwitch } from './materialWebJSX.tsx';

type Props = {
  entry: ResolvedDeferredObjectivePlanHistoryEntry;
  timeZone: string;
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
  observedIntervals: ResolvedDeferredObjectivePlanHistoryEntry['observedIntervals'],
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
  // Accent series colour for the trajectory's measured line + run bands —
  // same `--color-role-accent` the live trajectory card uses so the two
  // surfaces read as one chart family.
  accent: string;
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
  accent: cssVar(element, '--color-role-accent'),
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
    // labels under containLabel. `top: 60` reserves vertical headroom for a
    // two-line legend wrap at 320 px (the trajectory legend can carry up to
    // 4 entries — "Planned trajectory" / "Revised trajectory" / "Measured
    // Heating" / "Target" — and wraps to two rows inside narrow containers).
    // The legacy bar chart's 3-entry legend stays single-line at every
    // supported width, but we keep the same reserve so a future series
    // addition can't silently crowd the chart-top edge here either.
    grid: { top: 60, left: 8, right: 16, bottom: 32, containLabel: true },
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

// ─── Trajectory chart (v2.7.2 PR 4; receipt-first redesign Phase 1B) ──────────
//
// Renders the planned staircase + observed-progress line on a single grid with
// the y-axis in unit space (°C / %). The producer in shared-domain resolves
// the staircase from `originalPlan.hours × kwhPerUnitMean`; this layer is a
// renderer that never inspects the raw entry.
//
// Phase 1B: the default view shows ONLY the final plan staircase; on a
// revised run a vertical "Plan changed HH:MM" marker pins the replan and the
// "Compare with initial plan" toggle reveals the dashed original. The ECharts
// legend + floating tooltip are gone — a compact DOM legend row sits above
// the chart and a pinned readout (the live page's primitive) handles taps.

// Series names are renderer-internal identifiers (nothing renders them once
// the legend + tooltip are DOM-side); kept stable for tests.
const PLANNED_SERIES_NAME = 'Planned trajectory';
const INITIAL_PLAN_SERIES_NAME = 'Initial plan';
const TARGET_SERIES_NAME = 'Target';
const MEASURED_SERIES_NAME = 'Measured';
const MET_MARK_NAME = 'Reached target';

// Axis values delegate to the shared `formatProgressValueForUnit` so the
// y-axis renders "45%" exactly like the hero / readout lines (the previous
// view-local formatter spaced the percent — "45 %" — and drifted from every
// other surface; review round 2 P2 #7).
const formatTrajectoryValue = formatProgressValueForUnit;

// `h23` keeps midnight as "00:00" (a bare `hour12: false` can pick `h24` →
// "24:00" in some locales), matching the shared-domain readout/axis clocks.
const formatTrajectoryClock = (atMs: number, timeZone: string): string => (
  new Date(atMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
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
// gives the observed/planned series a bit of headroom. Fits the domain to the
// series that actually DRAW — the visible staircase, the dashed original only
// while the compare toggle shows it, and the measured line — never to hidden
// series (an undrawn re-anchored staircase or a suppressed measured point
// would otherwise stretch the axis and crush the visible staircase into a
// sliver; review round 2 P0 #1). Floors at 0 for `%` (SoC can't go below
// zero) but lets °C dip below 0 since cold-storage thermostats can
// legitimately span sub-zero. The 5 %/2 °C padding keeps the observed line
// from hugging the chart edge.
const resolveTrajectoryYRange = (
  data: DeferredPlanHistoryChartData,
  showOriginalOverlay: boolean,
): { min: number | 'dataMin'; max: number | 'dataMax' } => {
  const values: number[] = [];
  if (data.target !== null) values.push(data.target);
  for (const point of data.plannedVisible) values.push(point.value);
  if (showOriginalOverlay) for (const point of data.plannedOriginal) values.push(point.value);
  for (const point of data.observed) values.push(point.value);
  if (values.length === 0) return { min: 'dataMin', max: 'dataMax' };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = data.unit === '%' ? 5 : 2;
  const lowerBound = data.unit === '%' ? Math.max(0, Math.floor(min - pad)) : Math.floor(min - pad);
  const upperBound = Math.ceil(max + pad);
  return { min: lowerBound, max: upperBound };
};

// Inputs for the trajectory option. Grouped so the builder stays inside the
// parameter budget; every field is producer-resolved.
export type HistoryTrajectoryOptionParams = {
  data: DeferredPlanHistoryChartData;
  marker: HistoryPlanChangeMarker | null;
  runBands: HistoryRunBand[];
  // When true (the "Compare with initial plan" toggle), the dashed original
  // staircase renders behind the final one.
  showInitialPlan: boolean;
  palette: Palette;
  timeZone: string;
  // Rendered width — drives the time-axis label cadence (~5 hour-aligned
  // labels at full card width, ~3 at ≤360 px). 0 falls back to the wide
  // cadence. Same idiom as the live trajectory chart.
  chartWidth: number;
};

export const buildHistoryDetailTrajectoryOption = (
  params: HistoryTrajectoryOptionParams,
): EChartsOption => {
  const { data, marker, runBands, showInitialPlan, palette, timeZone, chartWidth } = params;
  // Trajectory-mode payloads always carry a unit; a `null` unit means a
  // caller wired a `legacy_kwh` payload through this builder, which would
  // silently render °C labels on a kWh dataset. Assert at the boundary.
  if (data.unit === null) {
    throw new Error('buildHistoryDetailTrajectoryOption requires a trajectory-mode payload (unit must be set)');
  }
  const unit: '°C' | '%' = data.unit;
  // The DEFAULT view shows only the planner's last word — the producer-
  // resolved `plannedVisible` staircase (`replanned` gates the overlay), the
  // same semantic source the pinned readout and the strip's skip attribution
  // read. The original is the on-demand comparison layer.
  const plannedVisible = data.plannedVisible;
  const showOriginalOverlay = showInitialPlan && data.replanned && data.plannedOriginal.length > 0;
  const hasObserved = data.observed.length > 0;
  const yRange = resolveTrajectoryYRange(data, showOriginalOverlay);
  const yMin = typeof yRange.min === 'number' ? yRange.min : null;
  const yMax = typeof yRange.max === 'number' ? yRange.max : null;
  const yMid = yMin !== null && yMax !== null ? (yMin + yMax) / 2 : null;
  // Explicit, width-aware tick cadence (the live trajectory chart's idiom):
  // ECharts' time axis defaults + `hideOverlap` still crowd HH:MM labels into
  // an unreadable run at 320–480 px, so the formatter blanks every label that
  // doesn't sit on the chosen hour cadence. The cadence is anchored at the
  // first whole hour inside the window — an epoch-aligned modulo would skip
  // the window-start hour whenever it isn't a multiple of the interval from
  // the epoch (an 18:00 window opened with 20:00 as its leftmost label at
  // 320 px; review round 2 P2 #12).
  const xSpanMs = data.windowEndMs - data.windowStartMs;
  const targetTickCount = chartWidth > 0 && chartWidth <= 360 ? 3 : 5;
  const tickIntervalMs = Math.max(1, Math.ceil(xSpanMs / ONE_HOUR_MS / targetTickCount)) * ONE_HOUR_MS;
  const tickAnchorMs = ceilToHour(data.windowStartMs);
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    // No ECharts legend (the compact DOM legend row above the chart carries
    // Measured / Planned / Target) and no floating tooltip — the pinned
    // readout below the chart is the only tap/scrub surface, matching the
    // live page's interaction grammar. `top: 28` reserves headroom for the
    // "Plan changed HH:MM" marker label.
    grid: { top: 28, left: 8, right: 34, bottom: 22, containLabel: true },
    xAxis: {
      type: 'time',
      min: data.windowStartMs,
      max: data.windowEndMs,
      // Force hourly tick generation so the window-anchored cadence below
      // always has a tick to label at the anchor hour (ECharts would
      // otherwise pick a sparser epoch-aligned tick set on long windows).
      maxInterval: ONE_HOUR_MS,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      splitLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        hideOverlap: true,
        formatter: (ms: number): string => (
          ms >= tickAnchorMs && (ms - tickAnchorMs) % tickIntervalMs === 0
            ? formatTrajectoryClock(ms, timeZone)
            : ''
        ),
      },
    },
    yAxis: {
      type: 'value',
      min: yRange.min,
      max: yRange.max,
      // Two intervals → ticks at floor / mid / ceiling; only floor + mid
      // carry labels. The target value is carried by the legend's
      // "Target 65.0 °C" item, never an axis tick — this is the fix for the
      // 67.0/65.0 label collision the redesign was signed off on.
      ...(yMin !== null && yMax !== null && yMax > yMin
        ? { interval: (yMax - yMin) / 2 }
        : { splitNumber: 2 }),
      splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (value: number) => {
          if (yMin !== null && Math.abs(value - yMin) < 0.001) return formatTrajectoryValue(value, unit);
          if (yMid !== null && Math.abs(value - yMid) < 0.001) return formatTrajectoryValue(value, unit);
          return '';
        },
      },
    },
    series: [
      // Scheduled-run bands behind everything — solid accent tint, kind-verb
      // label on the first band only (the live trajectory card's idiom; the
      // dashed grammar stays reserved for "planned but didn't run" on the
      // strip below).
      {
        id: 'run-bands',
        type: 'line' as const,
        data: [],
        silent: true,
        markArea: {
          silent: true,
          itemStyle: { color: palette.accent, opacity: 0.08 },
          label: {
            show: true,
            color: palette.accent,
            fontSize: 11,
            position: 'insideBottom' as const,
          },
          data: runBands.map((band) => ([
            { name: band.label ?? '', xAxis: band.fromMs },
            { xAxis: band.toMs },
          ])),
        },
      },
      // Dashed original staircase — only when the compare toggle is on.
      ...(showOriginalOverlay ? [{
        name: INITIAL_PLAN_SERIES_NAME,
        type: 'line' as const,
        step: 'end' as const,
        silent: true,
        showSymbol: false,
        lineStyle: { color: palette.muted, width: 1.5, type: 'dashed' as const, opacity: 0.8 },
        itemStyle: { color: palette.muted },
        data: toEchartsData(data.plannedOriginal),
      }] : []),
      // The visible planned staircase (final plan when revised). Carries the
      // "Plan changed HH:MM" markLine so the marker participates in the time
      // scale without a synthetic series.
      ...(plannedVisible.length > 0 ? [{
        name: PLANNED_SERIES_NAME,
        type: 'line' as const,
        step: 'end' as const,
        silent: true,
        showSymbol: false,
        lineStyle: { color: palette.muted, width: 1.5 },
        itemStyle: { color: palette.muted },
        data: toEchartsData(plannedVisible),
        markLine: marker !== null
          ? {
            silent: true,
            symbol: 'none',
            lineStyle: { color: palette.muted, width: 1, type: 'solid' as const, opacity: 0.5 },
            label: {
              show: true,
              formatter: marker.label,
              color: palette.muted,
              fontSize: 10,
              // Horizontal label above the vertical line's top — the grid's
              // `top: 28` reserves the headroom (the live deadline marker's
              // idiom).
              position: 'end' as const,
              distance: 6,
            },
            data: [{ xAxis: marker.atMs }],
          }
          : undefined,
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
      // Measured line — the accent hero series, smoothed like the live page.
      ...(hasObserved ? [{
        name: MEASURED_SERIES_NAME,
        type: 'line' as const,
        silent: true,
        showSymbol: false,
        smooth: 0.4,
        lineStyle: { color: palette.accent, width: 2.5 },
        itemStyle: { color: palette.accent },
        data: toEchartsData(data.observed),
      }] : []),
      // Met marker: an accent ring at the moment the target was reached.
      // `metMarkerValue` is producer-resolved (target for target-reached
      // runs, the frozen plateau for stalled ones) so the ring sits ON the
      // measured line — the hero's "Ready 00:42" row and this dot must
      // reconcile.
      ...(data.metAtMs !== null && data.metMarkerValue !== null ? [{
        name: MET_MARK_NAME,
        type: 'scatter' as const,
        silent: true,
        symbolSize: 10,
        itemStyle: { color: 'transparent', borderColor: palette.accent, borderWidth: 2 },
        data: [[data.metAtMs, data.metMarkerValue]] as TrajectorySeriesData,
      }] : []),
      // Selection hairline, fed imperatively from the scrub state (same
      // primitive as the live page).
      {
        id: 'selection-hairline',
        type: 'line' as const,
        data: [],
        silent: true,
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: palette.text, width: 1, opacity: 0.5 },
          label: { show: false },
          data: [],
        },
      },
    ],
  };
};

// ─── Chart React wrapper ──────────────────────────────────────────────────────
//
// Both chart wrappers route through the shared `useEchartsMount` primitive in
// `echartsRegistry.ts` — it owns the init/setOption/ResizeObserver/tab-shown/
// dispose lifecycle. The option builders run lazily inside `buildOption` so the
// closure captures the fresh palette read off the live container at mount time;
// `resolveChartSize` is this view's container-specific sizer.

const LegacyKwhChart = ({ rows, hasOriginalSeries, hasFinalSeries, observedSeriesName }: {
  rows: HourRow[];
  hasOriginalSeries: boolean;
  hasFinalSeries: boolean;
  observedSeriesName: string;
}) => {
  const chartRef = useEchartsMount({
    buildOption: (container) => buildHistoryDetailChartOption(
      rows,
      resolvePalette(container),
      hasOriginalSeries,
      hasFinalSeries,
      observedSeriesName,
    ),
    resolveSize: resolveChartSize,
    deps: [rows, hasOriginalSeries, hasFinalSeries, observedSeriesName],
  });
  return (
    <div
      ref={chartRef}
      class="deadline-horizon-chart"
      role="img"
      aria-label="Initial schedule vs revised schedule charging hours"
    />
  );
};

// History trajectory container is shorter than the legacy 240 px chart — no
// ECharts legend rows to hold. Must match `.deadline-history-trajectory-chart`
// in style.css (the cold-mount fallback size).
const HISTORY_TRAJECTORY_CHART_HEIGHT = 180;
const resolveHistoryTrajectoryChartSize = (element: HTMLElement): { height: number; width: number } => ({
  ...resolveChartSize(element),
  height: element.clientHeight > 0 ? element.clientHeight : HISTORY_TRAJECTORY_CHART_HEIGHT,
});

const HistoryTrajectoryChart = ({
  data, marker, runBands, showInitialPlan, timeZone, hours, selectedHourMs, onSelect, ariaLabel,
}: {
  data: DeferredPlanHistoryChartData;
  marker: HistoryPlanChangeMarker | null;
  runBands: HistoryRunBand[];
  showInitialPlan: boolean;
  timeZone: string;
  // Hour-bucket grid backing the pinned readout; the scrub snaps to it.
  hours: ReadonlyArray<{ startsAtMs: number }>;
  // Hour-start ms of an EXPLICIT selection; null at the default state so the
  // hairline doesn't crowd the chart at rest (live-page contract).
  selectedHourMs: number | null;
  onSelect: (index: number | null) => void;
  ariaLabel: string;
}) => {
  const chartHandle = useRef<EChartsType | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const chartRef = useEchartsMount({
    buildOption: (container) => buildHistoryDetailTrajectoryOption({
      data,
      marker,
      runBands,
      showInitialPlan,
      palette: resolvePalette(container),
      timeZone,
      // Width drives the time-axis label cadence (~3 labels at ≤360 px).
      // Same sizer the mount hook uses, so the cadence matches the rendered
      // width even on a cold mount inside a hidden panel.
      chartWidth: resolveHistoryTrajectoryChartSize(container).width,
    }),
    resolveSize: resolveHistoryTrajectoryChartSize,
    deps: [data, marker, runBands, showInitialPlan, timeZone],
    onChartInit: (chart) => {
      chartHandle.current = chart;
      attachHourScrub(
        chart,
        (x, y) => {
          if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return null;
          // Scalar pixel for the single-axis finder (see the live page's
          // ScheduleChart note — an `[x, y]` pair makes ECharts return null).
          const raw = chart.convertFromPixel({ xAxisIndex: 0 }, x);
          const ms = Array.isArray(raw) ? raw[0] : raw;
          if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
          return resolveScrubHourIndex(hours, ms);
        },
        (index) => onSelectRef.current(index),
      );
    },
  });
  // Selection hairline at the selected hour's centre, merged onto the
  // `selection-hairline` series by id — the live page's exact idiom.
  useEffect(() => {
    const chart = chartHandle.current;
    if (!chart || chart.isDisposed()) return;
    chart.setOption({
      series: [{
        id: 'selection-hairline',
        markLine: {
          data: selectedHourMs === null ? [] : [{ xAxis: selectedHourMs + ONE_HOUR_MS / 2 }],
        },
      }],
    });
  }, [selectedHourMs, data]);
  return (
    <div
      ref={chartRef}
      class="deadline-history-trajectory-chart"
      role="img"
      aria-label={ariaLabel}
    />
  );
};

// Compact DOM legend row above the trajectory chart — Measured / Planned /
// Target {value}. Owner-requested (direct end-labels collide when the lines
// converge on the target near the deadline). Token-styled swatches; wraps
// cleanly at 320 px. The Measured item renders only while a measured series
// actually draws — advertising a swatch for a line that isn't there reads as
// a data bug (review round 2 P0 #1).
const HistoryTrajectoryLegend = ({ target, unit, showMeasured }: {
  target: number | null;
  unit: '°C' | '%';
  showMeasured: boolean;
}) => (
  <div class="deadline-history-legend">
    {showMeasured && (
      <span class="deadline-history-legend__item">
        <span class="deadline-history-legend__swatch" data-series="measured" aria-hidden="true" />
        {HISTORY_TRAJECTORY_LEGEND_MEASURED}
      </span>
    )}
    <span class="deadline-history-legend__item">
      <span class="deadline-history-legend__swatch" data-series="planned" aria-hidden="true" />
      {HISTORY_TRAJECTORY_LEGEND_PLANNED}
    </span>
    {target !== null && (
      <span class="deadline-history-legend__item">
        <span class="deadline-history-legend__swatch" data-series="target" aria-hidden="true" />
        {formatHistoryTrajectoryLegendTarget({ targetValue: target, targetUnit: unit })}
      </span>
    )}
  </div>
);

// Trajectory card body: legend row → chart → pinned readout → compare
// toggle (revised runs only). Selection state is local — the strip below
// keeps its own (the two readouts answer different questions, and the mock
// shows them selected independently).
const HistoryTrajectorySection = ({ data, entry, timeZone, ariaLabel }: {
  data: DeferredPlanHistoryChartData;
  entry: ResolvedDeferredObjectivePlanHistoryEntry;
  timeZone: string;
  ariaLabel: string;
}) => {
  const [selected, setSelected] = useState<number | null>(null);
  const [showInitialPlan, setShowInitialPlan] = useState(false);
  const marker = resolveHistoryPlanChangeMarker(entry, data, timeZone);
  // Labelled bands decorate the chart payload's own producer-resolved spans —
  // one geometry source shared with the widget chart.
  const runBands = resolveHistoryRunBands(entry, data);
  const readout: HistoryHourReadout = resolveHistoryTrajectoryReadout(data, marker, timeZone);
  const effectiveIndex = selected !== null && selected >= 0 && selected < readout.rows.length
    ? selected
    : readout.defaultIndex;
  const row = readout.rows[effectiveIndex];
  const hours = readout.rows.map((readoutRow) => ({ startsAtMs: readoutRow.atMs }));
  // The hour's own narrative (the plan-change sentence) wins when present;
  // otherwise the scrub hint keeps the row two lines tall and teaches the
  // gesture. The default selection is the plan-change hour, so the marker's
  // "why" is the first thing a visitor reads — by design.
  const secondary = row?.secondary ?? SMART_TASK_READOUT_SCRUB_HINT;
  // Same producer-resolved gate as the marker + chart overlay: a genuine
  // replan with a drawable original to compare against.
  const hasCompareToggle = data.replanned && data.plannedOriginal.length > 0;
  return (
    <>
      <HistoryTrajectoryLegend
        target={data.target}
        unit={data.unit ?? '°C'}
        showMeasured={data.observed.length > 0}
      />
      <HistoryTrajectoryChart
        data={data}
        marker={marker}
        runBands={runBands}
        showInitialPlan={showInitialPlan}
        timeZone={timeZone}
        hours={hours}
        selectedHourMs={selected !== null ? (row?.atMs ?? null) : null}
        onSelect={setSelected}
        ariaLabel={ariaLabel}
      />
      <div class="deadline-readout" aria-live="polite">
        <div class="deadline-readout__primary">{row?.primary}</div>
        <div class="deadline-readout__secondary">{secondary}</div>
      </div>
      {hasCompareToggle && (
        <label class="md-switch-row plan-history-detail__compare-row">
          <MdSwitch
            aria-label={HISTORY_COMPARE_INITIAL_PLAN_LABEL}
            {...(showInitialPlan ? { selected: true } : {})}
            onChange={() => setShowInitialPlan((current) => !current)}
          />
          <span class="md-switch-row__content">
            <span class="md-switch-row__label pels-text-settings-label">
              {HISTORY_COMPARE_INITIAL_PLAN_LABEL}
            </span>
          </span>
        </label>
      )}
    </>
  );
};

// Hero block — outcome-asymmetric. Branches on the resolved `tone` from the
// producer so the only condition the view layer reads is the recourse
// presence (which the producer already gates on outcome). The "Why" line
// is rendered separately from the postmortem because the postmortem is the
// outcome-shape sentence (PR 3) and the missed-reason is the action-oriented
// one (PR #856 P2 fold-in) — both useful on Missed, neither on Succeeded.
//
// The overshoot line is muted secondary text rendered under the secondary
// cost/delivered row on Succeeded entries whose final reading exceeded the
// target by > 5 °C / > 10 %. Producer resolves `null` for the other outcomes
// so the view layer never branches on `outcome` itself.
//
// The Usage cross-link is a one-line footer below the hero body. Sits below
// the hero's other secondary lines so the page mission ("did this run miss,
// and what should I do next?") still leads, with the asymmetric link to
// Usage / Insights as a follow-up affordance.
const HistoryDetailHero = ({
  hero,
  revisionUpdatesLine,
  usageLink,
}: {
  hero: DeadlinePlanHistoryHeroPayload;
  revisionUpdatesLine: string | null;
  usageLink: { href: string; label: string; deviceId: string; returnContext: string } | null;
}) => (
  <section
    class="plan-hero pels-hero plan-history-detail__hero"
    data-tone={hero.tone}
  >
    <p class="eyebrow plan-history-detail__eyebrow">{hero.eyebrow}</p>
    <p class="plan-history-detail__outcome">
      <span class={`plan-chip plan-chip--${hero.chip.tone} plan-history-detail__outcome-chip`}>{hero.chip.text}</span>
    </p>
    <header class="plan-history-detail__hero-header">
      <h1 class="plan-card__title plan-history-detail__heading">
        {hero.heading.deviceName !== null && `${formatDisplayDeviceName(hero.heading.deviceName)} — `}
        <span class="plan-history-detail__heading-when">{hero.heading.deadlineLine}</span>
      </h1>
    </header>
    {/* Outcome headline — the answer to "what happened on this run?".
      * Promoted in v2.7.2/PR10 from a muted-supporting paragraph to a
      * display-tier headline, visually equivalent to the live deadline-plan
      * page's hero headline. The producer
      * (`buildHistoryDetailHero` → `resolvePostmortem` in
      * `packages/shared-domain/src/deferredPlanHistory.ts`) emits the
      * sentence; the `data-variant` hook stays for future variant-specific
      * copy tuning without re-resolving in the view. */}
    <p
      class="plan-history-detail__outcome-headline"
      data-variant={hero.lead.variant}
    >
      {hero.lead.sentence}
    </p>
    {/* v2.7.3 — receipt-shaped 3-row timeline below the outcome line on
      * Succeeded heroes. Producer suppresses the timeline when fewer than two
      * rows could be composed honestly; the view never inspects row count. */}
    {hero.receiptTimeline !== null && hero.receiptTimeline.length > 0 && (
      <ol class="plan-history-detail__receipt" aria-label="Run receipt">
        {hero.receiptTimeline.map((row) => (
          <li key={`${row.label}-${row.time}`} class="plan-history-detail__receipt-row">
            <span class="plan-history-detail__receipt-dot" aria-hidden="true" />
            <span class="plan-history-detail__receipt-time">{row.time}</span>
            <span class="plan-history-detail__receipt-label">{row.label}</span>
            {row.detail !== null && (
              <span class="plan-history-detail__receipt-detail">{row.detail}</span>
            )}
          </li>
        ))}
      </ol>
    )}
    {hero.secondary !== null && (
      <p class="plan-history-detail__secondary">{hero.secondary}</p>
    )}
    {/* Cost narrative chip — rendered on Succeeded + Missed, suppressed on
      * Abandoned. Tone is muted/info (never red) per
      * `notes/v2-7-2/postmortem-chart-policy.md` v2.7.3 update. */}
    {hero.costNarrative !== null && (
      <p class="plan-history-detail__cost-narrative">
        <span class="plan-chip plan-chip--muted plan-history-detail__cost-narrative-chip">
          {hero.costNarrative}
        </span>
      </p>
    )}
    {hero.overshootLine !== null && (
      <p class="plan-history-detail__overshoot">{hero.overshootLine}</p>
    )}
    {hero.whyLine !== null && (
      <p class="plan-history-detail__missed-reason">Why: {hero.whyLine}</p>
    )}
    {/* Shortfall chip — blameless summary below the diagnosis sentence on
      * Missed heroes. Tone is muted (info-shaped, never red) per the
      * v2.7.3 history-loveable spec. */}
    {hero.shortfallChip !== null && (
      <p class="plan-history-detail__shortfall">
        <span class="plan-chip plan-chip--muted plan-history-detail__shortfall-chip">
          {hero.shortfallChip}
        </span>
      </p>
    )}
    {/* Abandoned <details> — collapsed by default, Material disclosure idiom
      * (Android chevron). Renders the producer-resolved body lines inside the
      * disclosure so the hero stays a single sentence + expansion. */}
    {hero.abandonedDetails !== null && (
      <details class="plan-history-detail__abandoned-details">
        <summary class="plan-history-detail__abandoned-summary">What we know</summary>
        <ul class="plan-history-detail__abandoned-body">
          {hero.abandonedDetails.finalizedClock !== null && (
            <li class="plan-history-detail__abandoned-line">
              Finalized at {hero.abandonedDetails.finalizedClock}.
            </li>
          )}
          {hero.abandonedDetails.lines.map((line) => (
            <li key={line} class="plan-history-detail__abandoned-line">{line}</li>
          ))}
        </ul>
      </details>
    )}
    {hero.recourse !== null && (
      <div class="plan-hero__recourse plan-history-detail__recourse">
        <button
          type="button"
          class="pels-button hy-nostyle"
          data-deadline-recourse-tab={hero.recourse.targetTab}
          data-deadline-recourse-device-id={hero.recourse.deviceId ?? ''}
        >
          {hero.recourse.label}
        </button>
      </div>
    )}
    {hero.progressLine !== null && (
      <p class="plan-history-detail__progress">
        {hero.progressLine}
        {hero.reachedAtLine !== null && <span class="plan-history-detail__reached">  ·  {hero.reachedAtLine}</span>}
      </p>
    )}
    {/* On Missed, progressLine is suppressed but reachedAtLine still carries
      * signal (when did the device actually hit / give up); render it on its
      * own line so the Why + recourse stack still has the time cue. */}
    {hero.progressLine === null && hero.reachedAtLine !== null && (
      <p class="plan-history-detail__progress">{hero.reachedAtLine}</p>
    )}
    {hero.coverageLine !== null && <p class="pels-card-supporting">{hero.coverageLine}</p>}
    {revisionUpdatesLine !== null && <p class="pels-card-supporting">{revisionUpdatesLine}</p>}
    {usageLink !== null && (
      <p class="plan-history-detail__usage-link">
        <a
          class="plan-history-detail__usage-link-anchor"
          href={usageLink.href}
          data-deadline-usage-link={usageLink.deviceId}
          data-deadline-usage-return-label={SMART_TASK_USAGE_RETURN_LABEL}
          data-deadline-usage-return-context={usageLink.returnContext}
        >
          {usageLink.label}
        </a>
      </p>
    )}
  </section>
);

// Hero fallback when no per-revision log entries are recorded (legacy v3 entries,
// or v4 entries whose run finalized before any replan). v4 entries with a real
// `revisions` array suppress this line and render the dedicated Revisions card
// below the chart instead — the card carries the same information at more
// detail, so keeping the hero line would just duplicate the count.
const formatRevisionUpdatesLine = (revisionCount: number | undefined): string | null => {
  if (typeof revisionCount !== 'number' || revisionCount <= 1) return null;
  const count = revisionCount - 1;
  return `Schedule updated ${count} ${count === 1 ? 'time' : 'times'}.`;
};

// Card-title + fallback-note copy is resolved by the shared-domain helper
// `historyDetailChartLabels(mode)` so runtime log breadcrumbs render identical
// strings (`feedback_ui_text_shared_with_logs`). Trajectory mode reads as
// "Progress history" so it isn't confused with the live Smart-task price
// horizon; legacy mode keeps the prior "Scheduled vs observed" + fallback
// note so v3 entries land on the same wording they did before PR 4.

// Sort revisions chronologically (oldest → newest). The recorder writes them
// in-order today but we don't want the view to depend on persistence order,
// since a future producer could batch / replay events out of order without
// breaking the contract. Returns a new array — the input is never mutated.
const sortRevisionsByAtMs = (
  revisions: readonly DeferredObjectivePlanHistoryRevisionLogEntry[],
): DeferredObjectivePlanHistoryRevisionLogEntry[] => (
  [...revisions].sort((a, b) => a.atMs - b.atMs)
);

type RevisionsCardRow = PlanHistoryRevisionLogRow & { atMs: number };

const RevisionsCard = ({ rows }: { rows: RevisionsCardRow[] }) => (
  <section class="pels-surface-card budget-redesign-card plan-history-detail__revisions-card">
    {/* Eyebrow distinguishes the post-finalization surface ("After this
        task ran") from the live-task panel's "Live" eyebrow; the row
        markup (`.plan-revision-row`) stays shared per `pels-m3-critic`'s
        contract so both surfaces look identical when narrating the same
        revision shape. */}
    <p class="eyebrow">After this task ran</p>
    <div class="budget-card-header">
      <h2 class="plan-card__title">What changed</h2>
    </div>
    <ol class="plan-revision-log">
      {rows.map((row) => (
        // `atMs` is the recorder-issued timestamp at which the revision was
        // written; revisions are at-most-one-per-replan and the recorder
        // guarantees monotonic ordering, so this is a stable per-row key
        // without us inventing a synthetic id field on the contract.
        <li key={row.atMs} class="plan-revision-row">
          <span class="plan-revision-time">{row.timeLabel}</span>
          <span class="plan-revision-reason">
            {row.isFallback ? REVISION_REASON_FALLBACK_WITH_DETAIL : row.reason}
          </span>
          {/* Suppress the diff chip on fallback rows for the same reason
              the live panel does — the `+/−Nh` would otherwise misattribute
              the diff to a vague "Plan refreshed" line. */}
          {row.hourDiff !== null && !row.isFallback && (
            <span
              class="plan-revision-diff"
              title={row.hourDiffAriaLabel ?? undefined}
              aria-label={row.hourDiffAriaLabel ?? undefined}
            >
              {row.hourDiff}
            </span>
          )}
        </li>
      ))}
    </ol>
  </section>
);

// Day-only date for the Usage cross-link label. Locale-pinned to `en-GB` so the
// day-of-month-then-month ordering ("16 May") matches the existing
// `formatSmartTaskListDateTime` shape — keeps the cross-link wording aligned
// with the past-list timestamps the user clicked through.
const formatUsageLinkDate = (ms: number, timeZone: string): string => {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'this day';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
  }).format(date);
};

// ─── Per-hour bar strip (v2.7.3) ──────────────────────────────────────────────
//
// Renders one bar per hour aligned on the same window as the trajectory
// chart above, answering "when did each hour run, and what did each hour
// cost?" — owner walk #11 + #14 concerns. Every conditional (cheap-hour
// glow, planned-but-skipped outline, kWh fallback) is resolved by the
// producer (`resolveHistoryDetailHourlyStrip`); this component is a pure
// mapper.

const resolveBarHeightPercent = (
  bucket: HourlyStripBucket,
  maxKwh: number,
): number => {
  if (maxKwh <= 0) return 0;
  if (bucket.kwh <= 0) return 0;
  // Floor at 8 % so a tiny bar is still visible against the strip baseline.
  // Planned-but-skipped buckets render their dashed outline at the PLANNED
  // kWh height (`bucket.kwh` carries the planned energy for outline buckets)
  // so a dropped 1.0 kWh hour reads as a 1.0 kWh-sized dashed box, not a
  // baseline sliver (review round 2 P1 #3) — the outline-vs-fill distinction
  // is carried by CSS (`data-outline`), not by zeroing the height.
  const ratio = bucket.kwh / maxKwh;
  return Math.max(8, Math.round(ratio * 100));
};

const HourlyStripLegend = () => (
  // Legend-as-sample-chips. Three price-tier `.plan-chip` instances plus the
  // dashed "planned, didn’t run" sample explaining the outline grammar. A
  // visually-hidden caption announces the tiers to screen readers. Per
  // `feedback_design_tokens.md`, all colour / spacing tokens are inherited
  // from `.plan-chip` + the `--pels-chart-hour-tone-*` family.
  <div class="hourly-strip__legend">
    <span class="visually-hidden">
      Bars are shaded by price level: low, normal, or high.
    </span>
    <span class="plan-chip plan-chip--muted hourly-strip__legend-item">
      <span class="hourly-strip__legend-bar" data-tone="cheap" aria-hidden="true" />
      <span class="hourly-strip__legend-label">{HISTORY_STRIP_LEGEND_PRICE_LOW}</span>
    </span>
    <span class="plan-chip plan-chip--muted hourly-strip__legend-item">
      <span class="hourly-strip__legend-bar" data-tone="normal" aria-hidden="true" />
      <span class="hourly-strip__legend-label">{HISTORY_STRIP_LEGEND_PRICE_NORMAL}</span>
    </span>
    <span class="plan-chip plan-chip--muted hourly-strip__legend-item">
      <span class="hourly-strip__legend-bar" data-tone="expensive" aria-hidden="true" />
      <span class="hourly-strip__legend-label">{HISTORY_STRIP_LEGEND_PRICE_HIGH}</span>
    </span>
    <span class="plan-chip plan-chip--muted hourly-strip__legend-item">
      <span class="hourly-strip__legend-bar" data-tone="skipped" aria-hidden="true" />
      <span class="hourly-strip__legend-label">{HISTORY_STRIP_LEGEND_SKIPPED}</span>
    </span>
  </div>
);

// Hourly strip + its pinned readout. The strip stays DOM-based; the old
// hover/focus tooltips are gone — tapping a bucket drives the readout below
// (one interaction grammar with the trajectory chart and the live page).
// Selection is strip-local and never empty: it defaults to the most
// informative bucket (the tallest delivered bar).
const HourlyStripSection = ({ data, entry, chart, timeZone }: {
  data: Extract<DeferredPlanHistoryHourlyStripData, { mode: 'present' }>;
  entry: ResolvedDeferredObjectivePlanHistoryEntry;
  // Trajectory payload for the same entry — the producer-resolved `replanned`
  // gate the strip's skip attribution shares with the chart above.
  chart: Pick<DeferredPlanHistoryChartData, 'replanned'>;
  timeZone: string;
}) => {
  const [selected, setSelected] = useState<number | null>(null);
  const readout: HistoryStripReadout = resolveHistoryStripReadout(data, entry, chart, timeZone);
  const effectiveIndex = selected !== null && selected >= 0 && selected < readout.rows.length
    ? selected
    : readout.defaultIndex;
  const row = readout.rows[effectiveIndex];
  const maxKwh = data.buckets.reduce((acc, bucket) => Math.max(acc, bucket.kwh), 0);
  return (
    <>
      <h3 class="plan-card__title plan-history-detail__strip-title">
        {SMART_TASK_HISTORY_STRIP_TITLE}
      </h3>
      <div class="hourly-strip">
        <HourlyStripLegend />
        <ol class="hourly-strip__bars">
          {data.buckets.map((bucket, index) => {
            const heightPercent = resolveBarHeightPercent(bucket, maxKwh);
            const bucketRow = readout.rows[index];
            const label = bucketRow?.secondary !== null && bucketRow?.secondary !== undefined
              ? `${bucketRow.primary} · ${bucketRow.secondary}`
              : bucketRow?.primary;
            return (
              <li
                key={bucket.atMs}
                class="hourly-strip__bucket"
                data-tone={bucket.tone ?? 'gap'}
                data-outline={bucket.outlinePresent ? 'true' : 'false'}
                data-cheapest={bucket.cheapestDeliveredHighlight ? 'true' : 'false'}
                data-planned={bucket.planned ? 'true' : 'false'}
                data-delivered={bucket.delivered ? 'true' : 'false'}
                data-selected={index === effectiveIndex ? 'true' : 'false'}
                tabIndex={0}
                aria-label={label}
                onClick={() => setSelected(index)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelected(index);
                  }
                }}
              >
                <span
                  class="hourly-strip__bar"
                  style={`height: ${heightPercent}%;`}
                />
              </li>
            );
          })}
        </ol>
        {/* Hour labels under the buckets (mock-style "19 … 00"). Same flex
          * distribution as the bars so each label centres under its bucket;
          * the producer thins the cadence (first/last/every-2nd) when the
          * buckets get narrow, emitting `null` for unlabelled buckets. The
          * row is decorative — the readout's primary line carries the full
          * HH:MM for assistive tech. */}
        <div class="hourly-strip__axis" aria-hidden="true">
          {readout.rows.map((axisRow) => (
            <span key={axisRow.atMs} class="hourly-strip__axis-label">
              {axisRow.axisLabel ?? ''}
            </span>
          ))}
        </div>
      </div>
      <div class="deadline-readout" aria-live="polite">
        <div class="deadline-readout__primary">{row?.primary}</div>
        <div class="deadline-readout__secondary">{row?.secondary ?? ''}</div>
      </div>
    </>
  );
};

export const DeadlinePlanHistoryDetail = ({ entry, timeZone }: Props) => {
  const deadlineLine = formatPlanHistoryDeadlineLine(entry, timeZone);
  // Resolve the per-revision rows once. A non-empty array switches the surface
  // from the hero fallback line to the dedicated `RevisionsCard` below the
  // chart — see comment on `formatRevisionUpdatesLine` for the legacy v3
  // fallback contract.
  const revisionRows: RevisionsCardRow[] = Array.isArray(entry.revisions) && entry.revisions.length > 0
    ? sortRevisionsByAtMs(entry.revisions).map((revision) => ({
      atMs: revision.atMs,
      ...formatPlanHistoryRevisionEntry(revision, timeZone, entry.objectiveKind),
    }))
    : [];
  const revisionUpdatesLine = revisionRows.length > 0
    ? null
    : formatRevisionUpdatesLine(entry.revisionCount);
  const usageDateLabel = formatUsageLinkDate(entry.deadlineAtMs, timeZone);
  // Cross-link to the same-day Usage chart. Per
  // `notes/smart-task-ui/README.md` "Cross-surface: vs Usage / Insights",
  // the asymmetric link helps users investigating a miss compare the run with
  // the household day context. Pinned to the deadline timestamp's date so the
  // user lands on the day the run was *supposed* to finish.
  const usageLink = {
    href: buildUsageDayHref(entry.deviceId, entry.deadlineAtMs),
    label: formatPlanHistoryUsageDayLinkLabel(
      entry.deviceName ?? null,
      usageDateLabel,
    ),
    deviceId: entry.deviceId,
    returnContext: `Showing household usage for ${usageDateLabel}.`,
  };
  // Producer-resolved hero payload. The view layer never branches on outcome
  // / planStatus / `dailyBudgetExhaustedBucketCount` — all of that resolution
  // lives in `buildHistoryDetailHero`.
  const hero = buildHistoryDetailHero({
    entry,
    timeZone,
    deadlineLine,
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
  // Per-hour bar strip data resolved at the producer; the view layer never
  // inspects `hourlyContributions` or the snapshot's planned hours. When
  // the producer returns `absent` the strip is suppressed.
  const hourlyStrip = resolveHistoryDetailHourlyStrip(entry);
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
  // Trim trailing/leading whitespace so screen readers don't pause on the
  // padded name; whitespace-only names collapse to the timestamp-only branch.
  const displayHeadingName = entry.deviceName ? formatDisplayDeviceName(entry.deviceName) : '';
  const ariaHeading = displayHeadingName !== ''
    ? `${displayHeadingName} — ${deadlineLine}`
    : deadlineLine;
  const chartLabels: HistoryDetailChartLabels = historyDetailChartLabels(
    chartData.mode,
    entry.objectiveKind,
    // Trajectory mode without a drawable measured series surfaces the
    // absent-observations caption (`fallbackNote`) instead of implying the
    // staircase was measured.
    chartData.observed.length > 0,
  );
  const trajectoryAriaLabel = chartLabels.formatTrajectoryAriaLabel(
    displayHeadingName !== '' ? displayHeadingName : 'this smart task',
  );
  const hasChartData = chartData.mode === 'trajectory'
    ? (chartData.plannedOriginal.length > 0 || chartData.observed.length > 0)
    : (entry.originalPlan !== null || entry.finalPlan !== null);
  const chartCardTitle = chartLabels.cardTitle;
  const chartFallbackNote = chartLabels.fallbackNote;
  return (
    <article class="plan-history-detail" aria-label={`${hero.eyebrow} ${ariaHeading}`}>
      <HistoryDetailHero
        hero={hero}
        revisionUpdatesLine={revisionUpdatesLine}
        usageLink={usageLink}
      />
      {hero.quietAbandoned ? null : !hasChartData ? (
        <section class="pels-surface-card">
          <p class="pels-card-supporting">
            No hourly schedule was saved for this run.
          </p>
          {/* When no schedule was recorded but the runtime did feed
            * hourly delivery contributions, the postmortem still has a
            * useful answer to "when did each hour run, and what did each
            * hour cost?" — render the strip inside the empty-state card so
            * the surface isn't a dead end. */}
          {hourlyStrip.mode === 'present' && (
            <HourlyStripSection data={hourlyStrip} entry={entry} chart={chartData} timeZone={timeZone} />
          )}
        </section>
      ) : (
        <section class="pels-surface-card budget-redesign-card deadline-horizon-card">
          <div class="budget-card-header">
            <h2 class="plan-card__title">{chartCardTitle}</h2>
            {hero.chartCollapsedByDefault && (
              <button
                type="button"
                class="pels-button plan-history-detail__chart-toggle hy-nostyle"
                aria-expanded={!chartCollapsed}
                onClick={() => setChartCollapsed(!chartCollapsed)}
              >
                {chartCollapsed ? chartLabels.expandToggleLabel : chartLabels.collapseToggleLabel}
              </button>
            )}
          </div>
          {!chartCollapsed && chartFallbackNote !== null && (
            <p class="pels-card-supporting">{chartFallbackNote}</p>
          )}
          {!chartCollapsed && chartData.mode === 'trajectory' && (
            <HistoryTrajectorySection
              data={chartData}
              entry={entry}
              timeZone={timeZone}
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
          {/* Per-hour bar strip lives inside the chart card so the time
            * axis reads continuous with the trajectory above. Suppressed
            * for entries without `hourlyContributions` (producer returns
            * `absent`) and while the chart is collapsed — "View details"
            * expands/collapses the trajectory AND the strip together
            * (receipt-shape on Succeeded). Owner walk #11 + #14: answers
            * "when did each hour run, and what did each hour cost?". */}
          {!chartCollapsed && hourlyStrip.mode === 'present' && (
            <HourlyStripSection data={hourlyStrip} entry={entry} chart={chartData} timeZone={timeZone} />
          )}
        </section>
      )}
      {/* The revision log is the "what changed" companion to the chart's "what
        * was planned" — they explain the same machinery from two angles, so we
        * gate the card on the chart-expanded state. Succeeded entries default
        * chart-collapsed (receipt shape, per `notes/smart-task-ui/README.md`
        * §"Asymmetric treatment of failure"); the card stays hidden until the
        * user opts into the schedule view via the chart toggle. Missed
        * entries default chart-expanded so the card shows automatically.
        * Unknown-with-plan entries default collapsed; the RevisionsCard
        * opens on demand via the same toggle. Abandoned and Replaced stay
        * quiet (`quietAbandoned: true`) — no toggle renders, `chartCollapsed`
        * never flips, so this card never shows for those outcomes. */}
      {revisionRows.length > 0 && !chartCollapsed && <RevisionsCard rows={revisionRows} />}
    </article>
  );
};
