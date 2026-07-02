// Daily-history chart option builder for the Usage tab. Split out of
// `usageStatsChartsEcharts.ts` so that file stays under the max-lines ceiling;
// this module owns every daily-history-side resolution: the honest over-budget
// encoding (mint base capped at the budget + an amber remainder for ONLY the
// portion above the line), the ~15% axis headroom, and the budget-reference
// pill pinned in the reserved right margin. The palette + point types stay in
// the sibling (type-only imports back, erased by the cruiser) so the shared
// `UsageStatsPalette` reads as one type across both usage charts.
import type { EChartsOption } from './echartsRegistry.ts';
import {
  BUDGET_REFERENCE_MARGIN_PX,
  buildBudgetReferencePillLabel,
  formatAxisTick,
  resolveLabelEvery,
  roundedAxisMaxToInterval,
  Y_AXIS_SPLIT_NUMBER,
} from './dayViewChart.ts';
import {
  buildChartTooltipBase,
  readoutToTooltipHtml,
  resolveTooltipDataIndex,
  type ChartReadoutContent,
} from './chartTooltipFormat.ts';
import { prefersCoarsePointer } from './chartReadout.ts';
import { formatDateInTimeZone, getDateKeyStartMs } from './timezone.ts';
import type { DailyHistoryPoint, UsageStatsPalette } from './usageStatsChartsEcharts.ts';

const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];

// Daily-history `date` keys are LOCAL calendar days (`YYYY-MM-DD` in the
// configured zone). Anchoring them at UTC midnight (`T00:00:00.000Z`) makes
// negative-offset zones (America/*) format the PREVIOUS local day, so axis
// labels, the readout, and the tooltip would all be one day off. Resolve the
// key's local day start in the configured zone before formatting.
export const formatDateKeyLabel = (
  dateKey: string,
  options: Intl.DateTimeFormatOptions,
  timeZone: string,
): string => formatDateInTimeZone(new Date(getDateKeyStartMs(dateKey, timeZone)), options, timeZone);

// Honest over-budget encoding: each day splits into a mint base capped at the
// budget plus an amber remainder for ONLY the portion above the line — a
// mostly-over fortnight reads as information (how much over), not a wall of
// alarm. Exported for the option-level suite so the partial-tint math is
// pinned where it is computed.
export const resolveDailyHistorySegments = (
  values: number[],
  budgetKWh: number | null,
): { base: number[]; over: number[] } => {
  // Resolve the cap once — hoisting the null/finite/positive check out of the
  // loop keeps TS strictNullChecks narrowing `limit` to a plain number across
  // the map callback (it cannot re-narrow `budgetKWh` per iteration) and makes
  // the per-day math a single branch-free expression.
  const limit = budgetKWh !== null && Number.isFinite(budgetKWh) && budgetKWh > 0 ? budgetKWh : null;
  if (limit === null) {
    return { base: [...values], over: values.map(() => 0) };
  }
  const base = values.map((value) => Math.min(value, limit));
  const over = values.map((value) => Math.max(0, Number((value - limit).toFixed(3))));
  return { base, over };
};

const buildBudgetMarkLine = (budgetKWh: number, palette: UsageStatsPalette) => ({
  symbol: 'none',
  silent: true,
  animation: false,
  // Pill chip pinned in the reserved right margin at the line's end — never
  // over the bars (see `BUDGET_REFERENCE_MARGIN_PX`).
  label: {
    ...buildBudgetReferencePillLabel({
      text: `Budget\n${budgetKWh.toFixed(1)} kWh`,
      borderColor: palette.budgetReference,
      backgroundColor: palette.tooltipBackground,
      textColor: palette.tooltipText,
    }),
    position: 'end' as const,
    distance: 6,
  },
  lineStyle: {
    color: palette.budgetReference,
    type: 'dashed' as const,
    width: 1,
  },
  data: [{ yAxis: budgetKWh }],
});

// Exported for the option-level suite (headroom, partial amber tint, budget
// pill placement).
export const buildDailyHistoryOption = (params: {
  ordered: DailyHistoryPoint[];
  readouts: ChartReadoutContent[];
  timeZone: string;
  palette: UsageStatsPalette;
  budgetKWh: number | null;
}): EChartsOption => {
  const { ordered, readouts, timeZone, palette, budgetKWh } = params;
  const values = ordered.map((point) => point.kWh);
  const labels = ordered.map((point) => (
    formatDateKeyLabel(point.date, { month: 'short', day: 'numeric' }, timeZone)
  ));
  const labelEvery = resolveLabelEvery(labels.length);
  // ~15% headroom above the tallest bar so no column clips the plot top; when
  // the budget line would sit above every bar, include it in the axis ceiling
  // so the reference still renders inside the chart frame.
  const showBudgetLine = budgetKWh !== null && Number.isFinite(budgetKWh) && budgetKWh > 0;
  const maxValue = Math.max(1, Math.max(...values, 0) * 1.15, showBudgetLine ? (budgetKWh as number) : 0);
  const yAxis = roundedAxisMaxToInterval(maxValue, Y_AXIS_SPLIT_NUMBER);
  const { base, over } = resolveDailyHistorySegments(values, showBudgetLine ? (budgetKWh as number) : null);
  const hasOver = over.some((value) => value > 0);

  return {
    animation: false,
    stateAnimation: { duration: 0 },
    grid: {
      left: 8,
      // Reserve the right gutter for the budget pill so the annotation sits
      // entirely off the data at 320 and 480 px.
      right: showBudgetLine ? BUDGET_REFERENCE_MARGIN_PX : 10,
      top: 8,
      bottom: 30,
      containLabel: true,
    },
    tooltip: {
      ...buildChartTooltipBase(palette),
      show: !prefersCoarsePointer(),
      formatter: (rawParams: unknown) => {
        const index = resolveTooltipDataIndex(rawParams);
        if (index < 0 || index >= readouts.length) return '';
        return readoutToTooltipHtml(readouts[index], { warnColor: palette.overBudget });
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
      max: yAxis.max,
      interval: yAxis.interval,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (value: number) => formatAxisTick(value, yAxis.interval),
      },
      splitLine: {
        lineStyle: {
          color: palette.grid,
          width: 1,
        },
      },
    },
    series: [
      // Base segment: the day's usage up to the budget line, mint. Days with
      // an over-budget remainder hand their rounded top corners to the amber
      // segment stacked above so the column keeps a single-bar silhouette.
      {
        name: 'Daily total',
        type: 'bar',
        stack: 'day',
        data: base.map((value, index) => ({
          value,
          itemStyle: {
            color: palette.bar,
            borderRadius: over[index] > 0 ? ([0, 0, 0, 0] as const) : BAR_RADIUS,
          },
        })),
        barMaxWidth: 16,
        barMinHeight: 2,
        emphasis: { disabled: true },
        blur: { disabled: true },
        selectedMode: 'single',
        select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
        ...(showBudgetLine ? { markLine: buildBudgetMarkLine(budgetKWh as number, palette) } : {}),
      },
      // Amber remainder: ONLY the portion above the budget line — the honest
      // over-budget encoding. Days at or under budget carry a null datum (no
      // zero-stub ink on top of the base column). Selectable so the tapped
      // column's border wraps the WHOLE bar, amber cap included (the readout
      // dispatches select to both stack series).
      ...(hasOver
        ? [{
          name: 'Over budget',
          type: 'bar' as const,
          stack: 'day',
          data: over.map((value) => (value > 0
            ? { value, itemStyle: { color: palette.overBudget, borderRadius: BAR_RADIUS } }
            : null)),
          barMaxWidth: 16,
          emphasis: { disabled: true },
          blur: { disabled: true },
          selectedMode: 'single' as const,
          select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
        }]
        : []),
    ],
  };
};
