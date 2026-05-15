import { useEffect, useRef } from 'preact/hooks';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import {
  formatPlanHistoryDeadlineLine,
  formatPlanHistoryObservedCoverage,
  formatPlanHistoryProgressLine,
  formatPlanHistoryReachedAtLine,
  getPlanHistoryOutcomeLabel,
  getPlanHistoryOutcomeTone,
} from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { encodeHtml, initEcharts, type EChartsOption, type EChartsType } from '../echartsRegistry.ts';
import { attachTabShownResize } from '../chartVisibilityResize.ts';

type Props = {
  entry: DeferredObjectivePlanHistoryEntry;
  timeZone: string;
};

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
  return { width: Math.max(240, width), height: element.clientHeight > 0 ? element.clientHeight : 220 };
};

const buildTooltip = (rows: HourRow[], hasOriginalSeries: boolean, hasFinalSeries: boolean) => (
  (rawParams: unknown): string => {
    const params = Array.isArray(rawParams) ? rawParams : [rawParams];
    const first = params.find((item): item is { dataIndex: number } => (
      Boolean(item) && typeof item === 'object' && Number.isInteger((item as { dataIndex?: unknown }).dataIndex)
    ));
    const row = first ? rows[first.dataIndex] : null;
    if (!row) return '';
    const lines = [`<strong>${encodeHtml(row.displayLabel)}</strong>`];
    if (hasOriginalSeries) lines.push(`Original ${row.originalKWh.toFixed(2)} kWh`);
    if (hasFinalSeries) lines.push(`Final ${row.finalKWh.toFixed(2)} kWh`);
    lines.push(`Observed charging ${row.observed ? 'yes' : 'no'}`);
    return lines.join('<br>');
  }
);

export const buildHistoryDetailChartOption = (
  rows: HourRow[],
  palette: Palette,
  hasOriginalSeries: boolean,
  hasFinalSeries: boolean,
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
      // The "Original plan" series renders as a `transparent` fill + dashed
      // device-coloured border. Pin its legend swatch to that same border so
      // the swatch is visible and matches the bar shown on the chart.
      data: [
        ...(hasOriginalSeries
          ? [{
            name: 'Original plan',
            itemStyle: {
              color: 'transparent',
              borderColor: palette.device,
              borderWidth: 2,
              borderType: 'dashed' as const,
            },
          }]
          : []),
        ...(hasFinalSeries ? [{ name: 'Final plan', itemStyle: { color: palette.device } }] : []),
        ...(hasObservedSeries ? [{ name: 'Observed charging', itemStyle: { color: palette.observed } }] : []),
      ],
      itemWidth: 12,
      itemHeight: 8,
      icon: 'roundRect',
      textStyle: { color: palette.muted, fontSize: 11 },
      inactiveColor: palette.grid,
    },
    grid: { top: 40, left: 36, right: 16, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: true,
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.tooltipText },
      formatter: buildTooltip(rows, hasOriginalSeries, hasFinalSeries),
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
        name: 'Original plan',
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
        name: 'Final plan',
        type: 'bar' as const,
        barMaxWidth: 18,
        itemStyle: {
          color: palette.device,
          borderRadius: [3, 3, 0, 0] as [number, number, number, number],
        },
        data: rows.map((row) => row.finalKWh),
      }] : []),
      {
        name: 'Observed charging',
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

const PlanComparisonChart = ({ rows, hasOriginalSeries, hasFinalSeries }: {
  rows: HourRow[];
  hasOriginalSeries: boolean;
  hasFinalSeries: boolean;
}) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const container = chartRef.current;
    if (!container) return undefined;
    const chart = initEcharts(container, undefined, {
      renderer: 'svg',
      ...resolveChartSize(container),
    });
    chartInstanceRef.current = chart;
    chart.setOption(
      buildHistoryDetailChartOption(rows, resolvePalette(container), hasOriginalSeries, hasFinalSeries),
      { notMerge: true },
    );
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => chart.resize(resolveChartSize(container)))
      : null;
    resizeObserver?.observe(container);
    // Cold-mount path: the chart may be initialized while its panel is still
    // `display:none`, so `clientWidth` was the 480 px fallback. Resize on the
    // next `pels:tab-shown` so the SVG settles to the real visible width.
    const detachTabShown = attachTabShownResize({ container, chart, resolveSize: resolveChartSize });
    return () => {
      resizeObserver?.disconnect();
      detachTabShown();
      chart.dispose();
      if (chartInstanceRef.current === chart) chartInstanceRef.current = null;
    };
  }, [rows, hasOriginalSeries, hasFinalSeries]);

  return (
    <div
      ref={chartRef}
      class="deadline-horizon-chart"
      role="img"
      aria-label="Original plan vs final plan charging hours"
    />
  );
};

export const DeadlinePlanHistoryDetail = ({ entry, timeZone }: Props) => {
  const tone = getPlanHistoryOutcomeTone(entry.outcome);
  const outcomeLabel = getPlanHistoryOutcomeLabel(entry.outcome);
  const deadlineLine = formatPlanHistoryDeadlineLine(entry, timeZone);
  const progressLine = formatPlanHistoryProgressLine(entry);
  const reachedAtLine = formatPlanHistoryReachedAtLine(entry, timeZone);
  const coverageLine = formatPlanHistoryObservedCoverage(entry);
  const rows = buildHistoryDetailRows(
    entry.originalPlan,
    entry.finalPlan,
    entry.observedIntervals,
    timeZone,
    { startedAtMs: entry.startedAtMs, deadlineAtMs: entry.deadlineAtMs },
  );
  // The chart always shows the final/as-executed plan when one exists,
  // falling back to the original when the run finalized before the planner
  // could revise. The original-plan series is only overlaid when the run
  // actually replanned — otherwise the two series would render identical
  // bars on top of each other and clutter the legend.
  const hasFinalSeries = Boolean(entry.finalPlan ?? entry.originalPlan);
  const hasOriginalSeries = Boolean(entry.originalPlan)
    && Boolean(entry.finalPlan)
    && rows.some((row) => Math.abs(row.originalKWh - row.finalKWh) > 0.001);
  return (
    <article class="plan-history-detail" aria-label={`Past plan ${deadlineLine}`}>
      <section class="pels-surface-card plan-history-detail__hero">
        <header class="plan-history-detail__hero-header">
          <h1 class="plan-card__title">{deadlineLine}</h1>
          <span class={`plan-chip plan-chip--${tone}`}>{outcomeLabel}</span>
        </header>
        {entry.deviceName && (
          <p class="plan-history-detail__device">{entry.deviceName}</p>
        )}
        {progressLine && (
          <p class="plan-history-detail__progress">
            {progressLine}
            {reachedAtLine && <span class="plan-history-detail__reached">  ·  {reachedAtLine}</span>}
          </p>
        )}
        {coverageLine && <p class="pels-card-supporting">{coverageLine}</p>}
        {typeof entry.revisionCount === 'number' && entry.revisionCount > 1 && (
          <p class="pels-card-supporting">Replanned {entry.revisionCount - 1} {entry.revisionCount === 2 ? 'time' : 'times'}.</p>
        )}
      </section>
      {entry.originalPlan === null && entry.finalPlan === null ? (
        <section class="pels-surface-card">
          <p class="pels-card-supporting">
            No plan detail was recorded for this run. It may have finalized before the planner produced a revision, or it predates plan-snapshot tracking.
          </p>
        </section>
      ) : (
        <section class="pels-surface-card budget-redesign-card deadline-horizon-card">
          <div class="budget-card-header">
            <h2 class="plan-card__title">Plan vs observed</h2>
          </div>
          <PlanComparisonChart
            rows={rows}
            hasOriginalSeries={hasOriginalSeries}
            hasFinalSeries={hasFinalSeries}
          />
        </section>
      )}
    </article>
  );
};
