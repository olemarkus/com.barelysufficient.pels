import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  DeferredObjectivePlanHistoryEntry,
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
  deadlineLabels,
  SMART_TASK_USAGE_RETURN_LABEL,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import {
  buildHistoryDetailHero,
  type DeadlinePlanHistoryHeroPayload,
} from '../deadlinePlanHistoryDetailHero.ts';
import { buildUsageDayHref } from '../deadlineUrls.ts';
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
  // Neutral on-good fill used by the trajectory chart's "Reached target"
  // markPoint. Pinned to a status-neutral token so the marker stays legible
  // even if a future variant attaches `metAtMs` to a non-`good` hero tone
  // (today the marker only renders on `good` heroes, but the planner-state
  // colour `palette.observed` would silently mis-contrast under a warn-tone
  // gradient). Paired with `palette.text` (= `--pels-text-primary`) for the
  // stroke so the dot reads as a hero-agnostic ring + dot.
  statusOnGood: string;
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
  statusOnGood: cssVar(element, '--pels-status-on-good'),
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

// ─── Trajectory chart (v2.7.2 PR 4) ───────────────────────────────────────────
//
// Renders the planned staircase + observed-progress line on a single grid with
// the y-axis in unit space (°C / %). The producer in shared-domain resolves
// the staircase from `originalPlan.hours × kwhPerUnitMean`; this layer is a
// renderer that never inspects the raw entry.

// User-visible series names + mark label come from the shared-domain helper
// (`historyDetailChartLabels`) so runtime log breadcrumbs and the chart legend
// stay on identical strings per `feedback_ui_text_shared_with_logs`. Aliased
// to local consts here so the option-builder body keeps reading naturally.
// `'trajectory'` is passed because these particular fields are mode-agnostic;
// the mode-aware fields (cardTitle / fallbackNote) are resolved at the call
// site with the live chart mode.
const TRAJECTORY_LABELS = historyDetailChartLabels('trajectory');
const PLANNED_SERIES_NAME = TRAJECTORY_LABELS.plannedSeriesName;
const PLANNED_REVISED_SERIES_NAME = TRAJECTORY_LABELS.plannedRevisedSeriesName;
const TARGET_SERIES_NAME = TRAJECTORY_LABELS.targetSeriesName;
const MET_MARK_NAME = TRAJECTORY_LABELS.metMarkName;

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
    lines.push(encodeHtml(TRAJECTORY_LABELS.formatObservedNotRecorded(observedSeriesName)));
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
    // `top: 60` matches the legacy bar chart; reserves vertical headroom
    // for a 2-line legend wrap at 320 px when the trajectory carries the
    // full 4-entry legend (Planned / Revised / Measured / Target).
    grid: { top: 60, left: 8, right: 16, bottom: 32, containLabel: true },
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
        // Marker style is pinned to neutral tokens (`statusOnGood` fill +
        // `text` stroke) rather than `palette.observed`/`palette.text` taken
        // together as a planner-state pair. Today the marker only renders
        // when the hero tone is `good`; the neutral pinning means a future
        // variant that attaches `metAtMs` to a non-`good` hero (e.g. a
        // hypothetical `met-with-overshoot` reclassified to `warn`) still
        // reads correctly without threading hero tone into the option
        // builder.
        markPoint: data.metAtMs !== null && data.metMarkerValue !== null && !hasPlannedFinal
          ? {
            symbol: 'circle',
            symbolSize: 10,
            itemStyle: { color: palette.statusOnGood, borderColor: palette.text, borderWidth: 1 },
            label: { show: false },
            data: [{
              name: MET_MARK_NAME,
              coord: [data.metAtMs, data.metMarkerValue],
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
        // See note above on the original-series markPoint — same tone-neutral
        // pinning applies on the revised overlay.
        markPoint: data.metAtMs !== null && data.metMarkerValue !== null
          ? {
            symbol: 'circle',
            symbolSize: 10,
            itemStyle: { color: palette.statusOnGood, borderColor: palette.text, borderWidth: 1 },
            label: { show: false },
            data: [{
              name: MET_MARK_NAME,
              coord: [data.metAtMs, data.metMarkerValue],
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
    class="pels-surface-card plan-history-detail__hero"
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
          class="pels-button"
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
    <div class="budget-card-header">
      <h2 class="plan-card__title">What changed</h2>
    </div>
    <ol class="plan-history-detail__revision-log">
      {rows.map((row) => (
        // `atMs` is the recorder-issued timestamp at which the revision was
        // written; revisions are at-most-one-per-replan and the recorder
        // guarantees monotonic ordering, so this is a stable per-row key
        // without us inventing a synthetic id field on the contract.
        <li key={row.atMs} class="plan-history-detail__revision-row">
          <span class="plan-history-detail__revision-time">{row.timeLabel}</span>
          <span class="plan-history-detail__revision-reason">{row.reason}</span>
          {row.hourDiff !== null && (
            <span class="plan-history-detail__revision-diff">{row.hourDiff}</span>
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

const formatStripHourLabel = (atMs: number, timeZone: string): string => (
  new Date(atMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  })
);

// Price in the user's display unit. `priceValue` is already the same
// currency-major value the recorder sums into `totalCost`, so we render it
// straight through with the page-level `costUnit` qualifier (e.g. "kr",
// "EUR") — no minor-unit conversion. Empty `costUnit` (the prop default
// before a currency is resolved) drops the qualifier rather than fabricate
// one. Whole-øre/öre/cent display follows the money convention used
// elsewhere in PELS: minor-unit denominations render as integers (no
// fractional øre); major-unit denominations keep two decimals.
const formatStripPrice = (priceValue: number | null, costUnit: string): string | null => {
  if (priceValue === null || !Number.isFinite(priceValue)) return null;
  const isMinorUnit = costUnit === 'øre' || costUnit === 'öre' || costUnit === 'cent';
  const decimals = isMinorUnit ? 0 : 2;
  const value = priceValue.toFixed(decimals);
  return costUnit === '' ? value : `${value} ${costUnit}`;
};

const formatStripKWh = (kwh: number): string | null => {
  if (!Number.isFinite(kwh) || kwh <= 0) return null;
  return `${kwh.toFixed(2)} kWh`;
};

const buildStripTooltip = (
  bucket: HourlyStripBucket,
  timeZone: string,
  costUnit: string,
): string => {
  // "time · 0.42 kWh · 0.18 kr · planned" / "time · skipped". Skipped means
  // the hour was scheduled but never delivered — we suppress kWh and price
  // on those buckets so the tooltip doesn't contradict itself (the bucket's
  // `kwh` field carries the planned fallback for bar-height context, not
  // for the tooltip). Planned-and-delivered keeps the kWh + price + marker.
  // No exclamation marks, no emoji — per the voice constraint.
  const parts: string[] = [formatStripHourLabel(bucket.atMs, timeZone)];
  if (bucket.outlinePresent) {
    parts.push('skipped');
    return parts.join(' · ');
  }
  const kwhText = formatStripKWh(bucket.kwh);
  if (kwhText !== null) parts.push(kwhText);
  const priceText = formatStripPrice(bucket.priceValue, costUnit);
  if (priceText !== null) parts.push(priceText);
  if (bucket.planned && bucket.delivered) {
    parts.push('planned');
  }
  return parts.join(' · ');
};

const resolveBarHeightPercent = (
  bucket: HourlyStripBucket,
  maxKwh: number,
): number => {
  if (maxKwh <= 0) return 0;
  if (bucket.kwh <= 0) return 0;
  // Floor at 8 % so a tiny delivered bar is still visible against the
  // strip baseline; outlined-only buckets stay at 0 so the dashed outline
  // floats at the baseline without a visible fill.
  const ratio = bucket.kwh / maxKwh;
  if (bucket.outlinePresent) return 0;
  return Math.max(8, Math.round(ratio * 100));
};

const HourlyStripLegend = () => (
  // Legend-as-sample-chips (design synthesis loveable touch #2). Three
  // `.plan-chip` instances with embedded tone-coloured bars consume the
  // same chip primitive Overview hero uses — keeps chip sizing/spacing
  // tokens in one place. A visually-hidden caption announces the three
  // tiers to screen readers (the chips themselves carry their tier label
  // as visible text). Per `feedback_design_tokens.md`, all colour /
  // spacing tokens are inherited from `.plan-chip` + the
  // `--pels-chart-hour-tone-*` family.
  <div class="hourly-strip__legend">
    <span class="visually-hidden">
      Bars are shaded by price tier: cheap, normal, or peak.
    </span>
    <span class="plan-chip plan-chip--muted hourly-strip__legend-item">
      <span class="hourly-strip__legend-bar" data-tone="cheap" aria-hidden="true" />
      <span class="hourly-strip__legend-label">cheap</span>
    </span>
    <span class="plan-chip plan-chip--muted hourly-strip__legend-item">
      <span class="hourly-strip__legend-bar" data-tone="normal" aria-hidden="true" />
      <span class="hourly-strip__legend-label">normal</span>
    </span>
    <span class="plan-chip plan-chip--muted hourly-strip__legend-item">
      <span class="hourly-strip__legend-bar" data-tone="expensive" aria-hidden="true" />
      <span class="hourly-strip__legend-label">peak</span>
    </span>
  </div>
);

const HourlyStrip = ({ data, timeZone, costUnit }: {
  data: Extract<DeferredPlanHistoryHourlyStripData, { mode: 'present' }>;
  timeZone: string;
  costUnit: string;
}) => {
  const maxKwh = data.buckets.reduce((acc, bucket) => Math.max(acc, bucket.kwh), 0);
  return (
    <div class="hourly-strip" role="img" aria-label="Per-hour delivery and price">
      <HourlyStripLegend />
      <ol class="hourly-strip__bars">
        {data.buckets.map((bucket) => {
          const heightPercent = resolveBarHeightPercent(bucket, maxKwh);
          const tooltip = buildStripTooltip(bucket, timeZone, costUnit);
          return (
            <li
              key={bucket.atMs}
              class="hourly-strip__bucket"
              data-tone={bucket.tone ?? 'gap'}
              data-outline={bucket.outlinePresent ? 'true' : 'false'}
              data-cheapest={bucket.cheapestDeliveredHighlight ? 'true' : 'false'}
              data-planned={bucket.planned ? 'true' : 'false'}
              data-delivered={bucket.delivered ? 'true' : 'false'}
              data-tooltip={tooltip}
              tabIndex={0}
              aria-label={tooltip}
            >
              <span
                class="hourly-strip__bar"
                style={`height: ${heightPercent}%;`}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export const DeadlinePlanHistoryDetail = ({ entry, timeZone, costUnit = '' }: Props) => {
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
  const chartLabels: HistoryDetailChartLabels = historyDetailChartLabels(chartData.mode);
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
            <HourlyStrip data={hourlyStrip} timeZone={timeZone} costUnit={costUnit} />
          )}
        </section>
      ) : (
        <section class="pels-surface-card budget-redesign-card deadline-horizon-card">
          <div class="budget-card-header">
            <h2 class="plan-card__title">{chartCardTitle}</h2>
            {hero.chartCollapsedByDefault && (
              <button
                type="button"
                class="pels-button plan-history-detail__chart-toggle"
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
          {/* Per-hour bar strip lives inside the chart card so the time
            * axis reads continuous with the trajectory above. Suppressed
            * for entries without `hourlyContributions` (producer returns
            * `absent`) and while the chart is collapsed (receipt-shape
            * on Succeeded). Owner walk #11 + #14: answers "when did each
            * hour run, and what did each hour cost?" at a glance. */}
          {!chartCollapsed && hourlyStrip.mode === 'present' && (
            <HourlyStrip data={hourlyStrip} timeZone={timeZone} costUnit={costUnit} />
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
