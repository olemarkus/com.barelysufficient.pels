// ECharts option builders for the Budget-tab chart (progress + hourly-plan
// modes). Pure option assembly: the chart lifecycle (instance cache, resize,
// readout wiring) lives in `budgetRedesignChart.ts`; the data derivations in
// `budgetRedesignChartData.ts`.
import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import type { EChartsOption, SeriesOption } from './echartsRegistry.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import { formatHourAxisLabel, readChartPalette, resolveLabelEvery } from './dayViewChart.ts';
import { resolvePriceUnitLabel } from './priceUnit.ts';
import { priceRateLabelToAmountUnit } from '../../../shared-domain/src/price/priceUnitLabel.ts';
import { prefersCoarsePointer } from './chartReadout.ts';
import {
  buildChartTooltipBase,
  readoutToTooltipHtml,
  resolveTooltipDataIndex,
  type ChartReadoutContent,
} from './chartTooltipFormat.ts';
import {
  normalizePriceValues,
  resolveActualUpToIndex,
  resolveProgressMoneySeriesData,
  resolveProgressSeriesData,
  type BudgetChartUnit,
  type BudgetRedesignDayView,
} from './budgetRedesignChartData.ts';

export type BudgetChartPalette = {
  actual: string;
  plan: string;
  planFill: string;
  background: string;
  managed: string;
  forecast: string;
  priceLine: string;
  priceFill: string;
  muted: string;
  grid: string;
  // Warn tone for the dashed daily-budget mark line (same token the Usage
  // tab's daily-history budget line uses).
  overBudget: string;
  // On-surface high-contrast tone for the selected column's identity — the
  // hourly bars' select border and the progress lines' selection marker
  // symbol (same selection identity as the Usage-tab charts).
  text: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

const BUDGET_CHART_PALETTE_VARS = {
  actual: '--pels-chart-actual',
  plan: '--pels-chart-plan',
  planFill: '--pels-chart-plan-fill',
  background: '--pels-chart-background',
  managed: '--pels-chart-managed',
  forecast: '--pels-chart-forecast',
  priceLine: '--pels-chart-price-line',
  priceFill: '--pels-chart-price-fill',
  muted: '--pels-chart-muted',
  grid: '--pels-chart-grid',
  overBudget: '--pels-chart-warn',
  text: '--text',
  tooltipBackground: '--pels-chart-tooltip-bg',
  tooltipText: '--pels-chart-tooltip-text',
  tooltipBorder: '--pels-chart-tooltip-border',
} as const satisfies Record<keyof BudgetChartPalette, string>;

export const resolveBudgetChartPalette = (container: HTMLElement): BudgetChartPalette => (
  readChartPalette<BudgetChartPalette>(container, BUDGET_CHART_PALETTE_VARS)
);

// Stable series id for the progress-mode selection marker so the readout's
// `onSelectionApplied` merge `setOption` targets the same (initially empty)
// series the base option declares.
export const READOUT_MARKER_SERIES_ID = 'readout-marker';

type ChartScaleKind = 'progress' | 'hourly';

const resolveYAxisScale = (dataMax: number, kind: ChartScaleKind): { max: number; interval: number } => {
  const safeMax = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
  if (kind === 'hourly') {
    const interval = safeMax <= 1.2 ? 0.3 : 0.5;
    const max = Math.max(interval, Math.ceil(safeMax / interval) * interval);
    return {
      max: Number(max.toFixed(1)),
      interval,
    };
  }
  const interval = safeMax <= 20 ? 5 : 10;
  return {
    max: Math.max(interval, Math.ceil(safeMax / interval) * interval),
    interval,
  };
};

const resolvePriceYAxisScale = (prices: number[]): { min: number; max: number; interval: number } => {
  if (prices.length === 0) return { min: 0, max: 1, interval: 0.5 };
  const dataMin = Math.min(...prices);
  const dataMax = Math.max(...prices);
  const span = Math.max(0.01, dataMax - dataMin);
  const pad = span * 0.1;
  const interval = span <= 1.2 ? 0.3 : 0.5;
  const minPadded = Math.max(0, Math.floor((dataMin - pad) / interval) * interval);
  const maxPadded = Math.ceil((dataMax + pad) / interval) * interval;
  return {
    min: Number(minPadded.toFixed(2)),
    max: Number(maxPadded.toFixed(2)),
    interval,
  };
};

const resolvePriceAxisUnit = (display: CostDisplay): string => (
  display.unit.trim() ? resolvePriceUnitLabel(display) : 'Price'
);

const buildReadoutTooltipFormatter = (readouts: ChartReadoutContent[]) => (
  (rawParams: unknown): string => {
    const index = resolveTooltipDataIndex(rawParams);
    if (index < 0 || index >= readouts.length) return '';
    return readoutToTooltipHtml(readouts[index]);
  }
);

const buildBaseOption = (params: {
  labels: string[];
  palette: BudgetChartPalette;
  dataMax: number;
  scaleKind: ChartScaleKind;
  readouts: ChartReadoutContent[];
}): EChartsOption => {
  const {
    labels,
    palette,
    dataMax,
    scaleKind,
    readouts,
  } = params;
  const labelEvery = resolveLabelEvery(labels.length);
  const yScale = resolveYAxisScale(dataMax, scaleKind);
  return {
    animation: false,
    stateAnimation: { duration: 0 },
    grid: { left: 8, right: 8, top: 12, bottom: 26, containLabel: true },
    // One content source for both caption surfaces: the desktop hover
    // tooltip renders the same structured readout the pinned row shows;
    // touch disables the floating box (the row replaces it).
    tooltip: {
      ...buildChartTooltipBase(palette),
      show: !prefersCoarsePointer(),
      formatter: buildReadoutTooltipFormatter(readouts),
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (_label: string, index: number) => {
          if (index % labelEvery !== 0 && index !== labels.length - 1) return '';
          return formatHourAxisLabel(labels[index] ?? '');
        },
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yScale.max,
      interval: yScale.interval,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (value: number) => (
          scaleKind === 'hourly' ? value.toFixed(1) : String(Math.round(value))
        ),
      },
      splitLine: { lineStyle: { color: palette.grid, width: 1 } },
    },
  };
};

// The single green reference is the stable budget-pace curve; it ends AT the cap
// (energy) or its fully-priced cost (money), so an end-stop dot carries the
// terminal number — no separate flat line, which would double-encode it. Energy
// gates the dot on a positive configured budget (preserved behaviour); money on
// a positive priced terminal (no cost view renders for a 0-kr day).
const resolveProgressEndStop = (params: {
  payload: DailyBudgetDayPayload;
  labels: string[];
  planCumulative: number[];
  referenceFloor: number;
  isMoney: boolean;
  costDisplay: CostDisplay;
}): { show: boolean; label: string; paceTerminal: number } => {
  const { payload, labels, planCumulative, referenceFloor, isMoney, costDisplay } = params;
  const paceTerminal = planCumulative.length
    ? (planCumulative[planCumulative.length - 1] ?? referenceFloor)
    : referenceFloor;
  const budgetConfigured = Number.isFinite(payload.budget.dailyBudgetKWh) && payload.budget.dailyBudgetKWh > 0;
  const show = labels.length > 0 && Number.isFinite(paceTerminal) && paceTerminal > 0 && (isMoney || budgetConfigured);
  const label = isMoney
    ? `Budget ${paceTerminal.toFixed(2)} ${priceRateLabelToAmountUnit(costDisplay.unit)}`.trimEnd()
    : `Budget ${paceTerminal.toFixed(1)} kWh`;
  return { show, label, paceTerminal };
};

export const buildProgressOption = (params: {
  payload: DailyBudgetDayPayload;
  view: BudgetRedesignDayView;
  palette: BudgetChartPalette;
  readouts: ChartReadoutContent[];
  dataMaxOverride?: number;
  // The cumulative unit. 'money' reads the producer cost series scaled through
  // the CostDisplay divisor; defaults to 'energy' so existing callers (and the
  // Adjust comparison charts) keep the kWh view unchanged. `costDisplay` is
  // required (never defaulted) so the money path can't silently assume a
  // currency/divisor — the øre→kr 100× trap if a caller forgot to pass it.
  unit?: BudgetChartUnit;
  costDisplay: CostDisplay;
}): EChartsOption => {
  const {
    payload,
    view,
    palette,
    readouts,
    dataMaxOverride,
    unit = 'energy',
    costDisplay,
  } = params;
  const isMoney = unit === 'money';
  const { labels, planCumulative, actualCumulative, projection } = isMoney
    ? resolveProgressMoneySeriesData(payload, view, costDisplay)
    : resolveProgressSeriesData(payload, view);
  const values = [
    ...planCumulative,
    ...actualCumulative.filter((value): value is number => Number.isFinite(value)),
    ...projection.filter((value): value is number => Number.isFinite(value)),
  ];
  // Energy floors the axis at the configured cap so the end-stop sits on-scale;
  // money has no configured cost target, so the series themselves set the max.
  const referenceFloor = isMoney ? 0 : payload.budget.dailyBudgetKWh;
  const computedMax = Math.max(...values, referenceFloor);
  const dataMax = dataMaxOverride !== undefined ? Math.max(computedMax, dataMaxOverride) : computedMax;
  const option = buildBaseOption({
    labels,
    palette,
    dataMax,
    scaleKind: 'progress',
    readouts,
  });
  const endStop = resolveProgressEndStop({ payload, labels, planCumulative, referenceFloor, isMoney, costDisplay });
  const series: SeriesOption[] = [
    {
      type: 'line',
      name: 'Budget',
      data: planCumulative,
      showSymbol: false,
      smooth: true,
      lineStyle: { color: palette.plan, width: 3 },
      areaStyle: { color: palette.planFill },
      emphasis: { disabled: true },
      ...(endStop.show
        ? {
          markPoint: {
            symbol: 'circle',
            symbolSize: 5,
            silent: true,
            animation: false,
            itemStyle: { color: palette.plan },
            label: {
              show: true,
              position: 'left' as const,
              formatter: endStop.label,
              color: palette.muted,
              fontSize: 10,
            },
            data: [{ coord: [labels[labels.length - 1], endStop.paceTerminal] }],
          },
        }
        : {}),
    },
  ];
  if (view !== 'tomorrow') {
    series.unshift({
      type: 'line',
      name: 'Actual',
      data: actualCumulative,
      showSymbol: false,
      smooth: true,
      connectNulls: false,
      lineStyle: { color: palette.actual, width: 3 },
      emphasis: { disabled: true },
    });
  }
  if (projection.some((value) => Number.isFinite(value))) {
    series.push({
      type: 'line',
      name: 'Projection',
      data: projection,
      showSymbol: false,
      smooth: true,
      connectNulls: false,
      lineStyle: { color: palette.forecast, width: 2, type: 'dashed', opacity: 0.7 },
      emphasis: { disabled: true },
    });
  }
  // Native ECharts select is invisible on symbol-less line series, so the
  // selected column's identity is carried by this single-symbol marker
  // series instead: the readout's `onSelectionApplied` hook merges the
  // selected `[index, cumulativeKWh]` point into its (initially empty)
  // data. Appended LAST so the axis-trigger tooltip formatter's first
  // param keeps belonging to a real data series. `silent` keeps it from
  // swallowing the zr-level taps that drive the selection.
  series.push({
    id: READOUT_MARKER_SERIES_ID,
    type: 'scatter',
    data: [] as Array<[number, number]>,
    symbolSize: 9,
    itemStyle: { color: palette.text },
    silent: true,
    z: 10,
    emphasis: { disabled: true },
  });
  return { ...option, series };
};

type BuildHourlyParams = {
  payload: DailyBudgetDayPayload;
  view: BudgetRedesignDayView;
  palette: BudgetChartPalette;
  priceReliable: boolean;
  costDisplay: CostDisplay;
  readouts: ChartReadoutContent[];
  dataMaxOverride?: number;
};

const buildPriceYAxis = (priceValues: number[], priceAxisUnit: string, palette: BudgetChartPalette) => {
  const priceScale = resolvePriceYAxisScale(priceValues);
  return {
    type: 'value' as const,
    min: priceScale.min,
    max: priceScale.max,
    interval: priceScale.interval,
    name: priceAxisUnit,
    nameGap: 8,
    nameTextStyle: { color: palette.muted, fontSize: 10, padding: [0, 0, 4, 0] as [number, number, number, number] },
    axisTick: { show: false },
    axisLine: { show: false },
    axisLabel: {
      color: palette.muted,
      fontSize: 11,
      formatter: (value: number) => value.toFixed(1),
    },
    splitLine: { show: false },
  };
};

export const buildHourlyOption = (params: BuildHourlyParams): EChartsOption => {
  const {
    payload,
    view,
    palette,
    priceReliable,
    costDisplay,
    readouts,
    dataMaxOverride,
  } = params;
  const planned = payload.buckets.plannedKWh || [];
  const actual = payload.buckets.actualKWh || [];
  const labels = payload.buckets.startLocalLabels || [];
  const actualUpToIndex = resolveActualUpToIndex(payload, view);
  const actualVisible = actual.map((value, index) => (
    index <= actualUpToIndex && Number.isFinite(value) ? value : null
  ));
  const allActual = actualVisible.filter((value): value is number => Number.isFinite(value));
  const computedMax = Math.max(0, ...planned, ...allActual);
  const dataMax = dataMaxOverride !== undefined ? Math.max(computedMax, dataMaxOverride) : computedMax;
  const priceAxisUnit = resolvePriceAxisUnit(costDisplay);
  const option = buildBaseOption({
    labels,
    palette,
    dataMax,
    scaleKind: 'hourly',
    readouts,
  });
  const priceValues = priceReliable
    ? normalizePriceValues(payload.buckets.price, labels.length, costDisplay)
    : [];
  if (priceValues.length === labels.length) {
    option.grid = { ...(option.grid as Record<string, unknown>), right: 48, top: 26 };
    option.yAxis = [option.yAxis, buildPriceYAxis(priceValues, priceAxisUnit, palette)];
  }
  const plannedBackground = payload.buckets.plannedUncontrolledKWh || [];
  const plannedManaged = payload.buckets.plannedControlledKWh || [];
  const hasSplit = plannedBackground.length === labels.length
    && plannedManaged.length === labels.length;
  // On-surface select border — the Usage-tab charts' selection identity.
  // The pinned readout dispatches `select` to every bar series of the
  // stacked column so the whole column carries the mark.
  const barSelect = {
    selectedMode: 'single' as const,
    select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } },
  };
  const series: SeriesOption[] = hasSplit
    ? [
      {
        type: 'bar',
        name: 'Background',
        data: plannedBackground,
        stack: 'planned',
        z: 2,
        barMaxWidth: 10,
        itemStyle: { color: palette.background },
        emphasis: { disabled: true },
        ...barSelect,
      },
      {
        type: 'bar',
        name: 'Managed',
        data: plannedManaged,
        stack: 'planned',
        z: 2,
        barMaxWidth: 10,
        itemStyle: { color: palette.managed, borderRadius: [4, 4, 0, 0] },
        emphasis: { disabled: true },
        ...barSelect,
      },
    ]
    : [
      {
        type: 'bar',
        name: 'Budget',
        data: planned,
        z: 2,
        barMaxWidth: 10,
        itemStyle: { color: palette.plan, borderRadius: [4, 4, 0, 0] },
        emphasis: { disabled: true },
        ...barSelect,
      },
    ];
  if (priceValues.length === labels.length) {
    series.push({
      type: 'line',
      name: 'Price',
      data: priceValues,
      yAxisIndex: 1,
      z: 5,
      showSymbol: false,
      smooth: false,
      step: 'middle',
      lineStyle: { color: palette.priceLine, width: 3 },
      areaStyle: { color: palette.priceFill },
      emphasis: { disabled: true },
    });
  }
  if (view !== 'tomorrow') {
    series.push({
      type: 'line',
      name: 'Actual',
      data: actualVisible,
      z: 4,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { color: palette.actual, width: 2 },
      emphasis: { disabled: true },
    });
  }
  return { ...option, series };
};
