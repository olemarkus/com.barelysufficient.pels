// Option-level coverage for the Usage tab's daily-history chart: the honest
// over-budget encoding (mint base + amber remainder ONLY above the budget
// line), the ~15% axis headroom, and the budget-reference pill pinned in the
// reserved right margin.
import {
  buildDailyHistoryOption,
  resolveDailyHistorySegments,
} from '../src/ui/usageDailyHistoryOption.ts';

const palette = {
  bar: '#c1',
  muted: '#c2',
  grid: '#c3',
  text: '#c4',
  tooltipBackground: '#c5',
  tooltipText: '#c6',
  tooltipBorder: '#c7',
  overBudget: '#c8',
  budgetReference: '#c9',
};

type DailyOptionShape = {
  grid: { right?: number };
  yAxis: { max?: number };
  series: Array<{
    name?: string;
    stack?: string;
    data: Array<{ value: number; itemStyle: { color?: string; borderRadius?: unknown } } | null>;
    markLine?: {
      lineStyle?: { color?: string; type?: string };
      label?: { formatter?: string; backgroundColor?: string; borderColor?: string; position?: string };
      data?: Array<{ yAxis: number }>;
    };
  }>;
};

const buildOption = (params: {
  kWhByDay: number[];
  budgetKWh?: number | null;
}): DailyOptionShape => buildDailyHistoryOption({
  ordered: params.kWhByDay.map((kWh, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, '0')}`,
    kWh,
  })),
  readouts: [],
  timeZone: 'UTC',
  palette,
  budgetKWh: params.budgetKWh ?? null,
}) as unknown as DailyOptionShape;

describe('resolveDailyHistorySegments', () => {
  it('tints ONLY the portion above the budget line amber', () => {
    const { base, over } = resolveDailyHistorySegments([9, 13.6, 12], 12);
    expect(base).toEqual([9, 12, 12]);
    expect(over).toEqual([0, 1.6, 0]);
  });

  it('renders plain full-height bars when no budget is configured', () => {
    const { base, over } = resolveDailyHistorySegments([9, 13.6], null);
    expect(base).toEqual([9, 13.6]);
    expect(over).toEqual([0, 0]);
  });
});

describe('buildDailyHistoryOption', () => {
  it('splits over-budget days into a mint base plus an amber remainder segment', () => {
    const option = buildOption({ kWhByDay: [9, 13.6, 12], budgetKWh: 12 });
    const [baseSeries, overSeries] = option.series;
    expect(baseSeries?.stack).toBe('day');
    expect(overSeries?.name).toBe('Over budget');
    expect(overSeries?.stack).toBe('day');
    // Base capped at the budget; remainder carries only the overage.
    expect(baseSeries?.data.map((d) => d?.value)).toEqual([9, 12, 12]);
    expect(overSeries?.data[1]).toMatchObject({ value: 1.6 });
    expect(overSeries?.data[1]?.itemStyle.color).toBe(palette.overBudget);
    // Under-budget days carry a null datum on the over series — no stub ink.
    expect(overSeries?.data[0]).toBeNull();
    expect(overSeries?.data[2]).toBeNull();
    // The base bar hands its rounded top to the amber segment when one sits
    // above it, keeping a single-bar silhouette.
    expect(baseSeries?.data[1]?.itemStyle.borderRadius).toEqual([0, 0, 0, 0]);
    expect(baseSeries?.data[0]?.itemStyle.borderRadius).toEqual([4, 4, 0, 0]);
  });

  it('renders a single mint series when every day is within budget', () => {
    const option = buildOption({ kWhByDay: [9, 10], budgetKWh: 12 });
    expect(option.series).toHaveLength(1);
    expect(option.series[0]?.data.map((d) => d?.value)).toEqual([9, 10]);
    expect(option.series[0]?.data[0]?.itemStyle.color).toBe(palette.bar);
  });

  it('keeps ~15% headroom above the tallest bar so nothing clips the plot top', () => {
    const option = buildOption({ kWhByDay: [16.8, 20], budgetKWh: 12 });
    // 20 × 1.15 = 23 → nice-rounded axis max strictly above the tallest bar.
    expect(option.yAxis.max).toBeGreaterThanOrEqual(23);
  });

  it('lifts the axis ceiling to include the budget line when it sits above every bar', () => {
    // All days well under budget: the reference must still render inside the
    // frame, so the budget (12) is folded into the axis max even though no bar
    // reaches it (2 / 3 × 1.15 alone would cap the axis around 3–4).
    const option = buildOption({ kWhByDay: [2, 3], budgetKWh: 12 });
    expect(option.yAxis.max).toBeGreaterThanOrEqual(12);
  });

  it('pins the budget label as a pill chip in the reserved right margin', () => {
    const option = buildOption({ kWhByDay: [9, 13.6], budgetKWh: 12 });
    const markLine = option.series[0]?.markLine;
    expect(markLine?.data?.[0]?.yAxis).toBe(12);
    // Slate reference, never amber — amber is reserved for the over portion.
    expect(markLine?.lineStyle).toMatchObject({ color: palette.budgetReference, type: 'dashed' });
    // Two-line pill at the line's right end, in the reserved gutter.
    expect(markLine?.label?.formatter).toBe('Budget\n12.0 kWh');
    expect(markLine?.label?.position).toBe('end');
    expect(markLine?.label?.backgroundColor).toBe(palette.tooltipBackground);
    expect(markLine?.label?.borderColor).toBe(palette.budgetReference);
    expect(option.grid.right).toBe(72);
  });

  it('reserves no gutter and draws no reference without a configured budget', () => {
    const option = buildOption({ kWhByDay: [9, 13.6], budgetKWh: null });
    expect(option.series[0]?.markLine).toBeUndefined();
    expect(option.grid.right).toBe(10);
  });
});
