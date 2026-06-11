// Shared chart tooltip/readout content layer (chart-overhaul Phase 3).
//
// One interaction grammar, two presentations: the desktop hover tooltip and
// the pinned readout row under the chart must show IDENTICAL information, so
// each chart resolves its data point into a structured `ChartReadoutContent`
// once and feeds BOTH surfaces from it. The tooltip base style is shared here
// too, absorbing the per-chart copies of the background/border/padding/shadow
// block so the floating boxes look the same on every chart.
import { encodeHtml } from './echartsRegistry.ts';
import {
  composeKWhOverBudget,
  composeWithinBudgetOf,
} from '../../../shared-domain/src/dailyBudgetHeroStrings.ts';

export type ChartReadoutValue = {
  text: string;
  // 'warn' renders in the warning tone (readout span class / tooltip colour).
  tone?: 'warn';
};

// Structured content for one selected/hovered point: `when` names the time
// bucket (primary line), `values` are the measurements (secondary line in the
// readout, one line each in the tooltip).
export type ChartReadoutContent = {
  when: string;
  values: ChartReadoutValue[];
};

type ChartTooltipPalette = {
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

// Shared visual base for every ECharts floating tooltip in the settings UI.
// Call sites spread this and add `show` (touch disables the floating box —
// see `prefersCoarsePointer` in `chartReadout.ts`) plus their `formatter`.
export const buildChartTooltipBase = (palette: ChartTooltipPalette) => ({
  trigger: 'axis' as const,
  axisPointer: { type: 'none' as const },
  confine: true,
  backgroundColor: palette.tooltipBackground,
  borderColor: palette.tooltipBorder,
  borderWidth: 1,
  padding: [8, 10] as [number, number],
  extraCssText: 'opacity:1;backdrop-filter:none;box-shadow:var(--shadow-md);',
  textStyle: {
    color: palette.tooltipText,
    fontSize: 12,
    fontWeight: 500,
  },
});

// Resolve the hovered data index out of ECharts' axis-trigger formatter
// params (single object or array of per-series params).
export const resolveTooltipDataIndex = (rawParams: unknown): number => {
  const first: unknown = Array.isArray(rawParams) ? rawParams[0] : rawParams;
  if (!first || typeof first !== 'object') return -1;
  const candidate = first as { dataIndex?: number };
  // `Number.isFinite` rejects NaN/Infinity, which would slip past the bare
  // typeof check and defeat callers' `index < 0 || index >= length` guards.
  return typeof candidate.dataIndex === 'number' && Number.isFinite(candidate.dataIndex)
    ? candidate.dataIndex
    : -1;
};

// Render the structured content as tooltip HTML: `when` on the first line,
// each value on its own line. Warn-toned values take the chart's warn colour
// so the tooltip carries the same emphasis as the readout row.
export const readoutToTooltipHtml = (
  content: ChartReadoutContent,
  options: { warnColor?: string } = {},
): string => {
  const lines = [
    encodeHtml(content.when),
    ...content.values.map((value) => (
      value.tone === 'warn' && options.warnColor
        ? `<span style="color:${options.warnColor};">${encodeHtml(value.text)}</span>`
        : encodeHtml(value.text)
    )),
  ];
  return lines.join('<br/>');
};

const padHour = (hour: number): string => String(hour).padStart(2, '0');

// Measurement segments join their tokens with NBSP so a narrow readout row
// never orphans a unit ("Managed 0.19 kWh" must not break before "kWh") —
// line wrapping happens only at the ` · ` separators between segments. Prose
// segments (the unreliable warning) keep normal spaces: they carry no units
// and must stay wrappable at 320 px.
const NBSP = ' ';
const nonBreaking = (text: string): string => text.split(' ').join(NBSP);

// Consequence-language warning for an hour with gaps in its samples — names
// what went wrong instead of the bare "Unreliable data" verdict. The chart
// legend / stat strip keep their established one-word "Unreliable"/"Warnings"
// labels; this is the readout's reason line.
const UNRELIABLE_HOUR_WARNING = 'Unreliable — some readings missing this hour';

// Typical-day chart: `13:00–14:00` / `Average 1.24 kWh`.
export const buildHourlyPatternReadout = (
  point: { hour: number; avg: number },
): ChartReadoutContent => ({
  when: `${padHour(point.hour)}:00–${padHour((point.hour + 1) % 24)}:00`,
  values: [{ text: nonBreaking(`Average ${point.avg.toFixed(2)} kWh`) }],
});

// Daily-history chart: `Thu 4 Jun` / `12.6 kWh` plus budget context when a
// daily budget is configured — `1.2 kWh over budget` (warn) or
// `Within budget of 14.0 kWh` (stems shared with the Budget hero via
// `dailyBudgetHeroStrings.ts`). `partialDay` marks the window-clipped oldest
// day of the 14-day history so a low bar reads as incomplete, not as a
// genuinely thrifty day.
export const buildDailyHistoryReadout = (params: {
  dateLabel: string;
  kWh: number;
  budgetKWh: number | null;
  partialDay?: boolean;
}): ChartReadoutContent => {
  const { dateLabel, kWh, budgetKWh, partialDay = false } = params;
  const values: ChartReadoutValue[] = [
    { text: nonBreaking(`${kWh.toFixed(1)} kWh${partialDay ? ' (partial day)' : ''}`) },
  ];
  if (budgetKWh !== null && Number.isFinite(budgetKWh) && budgetKWh > 0) {
    if (kWh > budgetKWh) {
      values.push({ text: nonBreaking(composeKWhOverBudget(kWh - budgetKWh)), tone: 'warn' });
    } else {
      values.push({ text: nonBreaking(composeWithinBudgetOf(budgetKWh)) });
    }
  }
  return { when: dateLabel, values };
};

// Usage-day chart: `13:00–14:00` / `Measured 1.31 kWh`, plus the
// Managed/Background split on one line when both halves exist, plus the
// unreliable-hour warning when the hour is flagged. `inProgress` marks the
// current hour on the Today view: its bucket is still accumulating, so the
// measurement reads `Measured 0.45 kWh so far`.
export const buildUsageDayReadout = (params: {
  hourRange: string;
  measuredKWh: number;
  managedKWh: number | null;
  backgroundKWh: number | null;
  unreliable: boolean;
  inProgress?: boolean;
}): ChartReadoutContent => {
  const suffix = params.inProgress ? ' so far' : '';
  const values: ChartReadoutValue[] = [
    { text: nonBreaking(`Measured ${params.measuredKWh.toFixed(2)} kWh${suffix}`) },
  ];
  if (params.managedKWh !== null && params.backgroundKWh !== null) {
    const managed = nonBreaking(`Managed ${params.managedKWh.toFixed(2)} kWh`);
    const background = nonBreaking(`Background ${params.backgroundKWh.toFixed(2)} kWh`);
    values.push({ text: `${managed} · ${background}` });
  }
  if (params.unreliable) values.push({ text: UNRELIABLE_HOUR_WARNING, tone: 'warn' });
  return { when: params.hourRange, values };
};
