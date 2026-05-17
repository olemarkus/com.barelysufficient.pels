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
} from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { deadlineLabels } from '../../../../shared-domain/src/deadlineLabels.ts';
import {
  buildHistoryDetailHero,
  type DeadlinePlanHistoryHeroPayload,
} from '../deadlinePlanHistoryDetailHero.ts';
import { encodeHtml, initEcharts, type EChartsOption, type EChartsType } from '../echartsRegistry.ts';
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

const PlanComparisonChart = ({ rows, hasOriginalSeries, hasFinalSeries, observedSeriesName }: {
  rows: HourRow[];
  hasOriginalSeries: boolean;
  hasFinalSeries: boolean;
  observedSeriesName: string;
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
      buildHistoryDetailChartOption(
        rows,
        resolvePalette(container),
        hasOriginalSeries,
        hasFinalSeries,
        observedSeriesName,
      ),
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
  }, [rows, hasOriginalSeries, hasFinalSeries, observedSeriesName]);

  return (
    <div
      ref={chartRef}
      class="deadline-horizon-chart"
      role="img"
      aria-label="Initial schedule vs revised schedule charging hours"
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
  // Reset on entry change so navigating Missed (expanded) → Succeeded
  // (collapsed) doesn't carry the previous entry's expanded state forward
  // when the parent reuses this component instance.
  // Initial state mirrors the hero's per-outcome default (Succeeded =
  // collapsed receipt; Missed = expanded diagnosis; Abandoned = collapsed
  // log). State reset across entry navigation is handled by the parent's
  // `key={entry.id}` prop, which remounts this component on entry change
  // rather than us managing reset-via-useEffect inside.
  const [chartCollapsed, setChartCollapsed] = useState(hero.chartCollapsedByDefault);
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
  // Resolve the observed-series noun once per entry. `deadlineLabels` maps
  // `temperature` → "Measured Heating" and `ev_soc` → "Measured Charging" so
  // the legend, tooltip, and scatter series all read correctly for the
  // device kind instead of always saying "Observed charging".
  const observedSeriesName = deadlineLabels(entry.objectiveKind).actualDeviceSeriesName;
  // Screen-reader label mirrors the visible heading shape: scoping eyebrow
  // ("Smart task") → device name (when present) → timestamp.
  const ariaHeading = entry.deviceName
    ? `${entry.deviceName} — ${deadlineLine}`
    : deadlineLine;
  const hasChartData = entry.originalPlan !== null || entry.finalPlan !== null;
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
            <h2 class="plan-card__title">Scheduled vs observed</h2>
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
          {!chartCollapsed && (
            <PlanComparisonChart
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
