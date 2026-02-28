import type { CombinedPriceData } from '../dailyBudget/dailyBudgetMath';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import {
  buildLegendTexts,
  buildMetaLines,
  buildPriceStats,
  escapeText,
  formatNumber,
  normalizeSeriesLength,
  resolvePlanIsToday,
  resolvePlanSnapshotDay,
  resolveCurrentPlanInfo,
  resolveActualSeries,
  resolveLabel,
  resolveLabelEvery,
  resolvePriceSeries,
} from './planPriceImageUtils';
import {
  PLAN_PRICE_COLORS as COLORS,
  PLAN_PRICE_FONT_SIZES as FONT_SIZES,
  PLAN_PRICE_LAYOUT,
  PLAN_PRICE_VIEWPORT,
} from './planPriceImageTheme';
import { buildActualSeries, buildLegendOption } from './planPriceImageEchartsSeries';
import { startRuntimeSpan } from '../utils/runtimeTrace';

type BarSeriesOption = Record<string, unknown>;
type LineSeriesOption = Record<string, unknown>;
type EChartsOption = Record<string, unknown>;
type EChartsType = {
  setOption: (option: EChartsOption, opts?: Record<string, unknown>) => void;
  renderToSVGString: (opts?: { useViewBox?: boolean }) => string;
  dispose: () => void;
};

type PlanPriceEchartsParams = {
  snapshot: DailyBudgetUiPayload | null;
  dayKey?: string | null;
  combinedPrices?: CombinedPriceData | null;
  width: number;
  height: number;
  fontFamily: string;
};

type EchartsRuntime = {
  init: (
    dom: HTMLElement | null,
    theme: string | object | null | undefined,
    opts: { renderer: 'svg'; ssr: true; width: number; height: number },
  ) => EChartsType;
};

let echartsRuntime: EchartsRuntime | null = null;

const getEchartsRuntime = (): EchartsRuntime => {
  if (!echartsRuntime) {
    echartsRuntime = require('./echartsRuntimeBundle.cjs') as unknown as EchartsRuntime;
  }
  return echartsRuntime;
};

export type PlanPriceEchartsContext = {
  bucketCount: number;
  bucketLabels: string[];
  bucketStartUtc: string[];
  plannedKWh: number[];
  maxPlan: number;
  actualKWh: Array<number | null>;
  showActual: boolean;
  priceSeries: Array<number | null>;
  priceValues: number[];
  priceMin: number;
  priceMax: number;
  priceUnit: string;
  currentIndex: number;
  currentPrice: number | null;
  showNow: boolean;
  ariaDescription: string;
  labelEvery: number;
};

const PADDING = PLAN_PRICE_LAYOUT.padding;
const HEADER_HEIGHT = PLAN_PRICE_LAYOUT.headerHeight;
const LEGEND_HEIGHT = PLAN_PRICE_LAYOUT.legendHeight;
const GRID_LINES = PLAN_PRICE_LAYOUT.gridLines;
const PRICE_LINE_WIDTH = PLAN_PRICE_LAYOUT.priceLineWidth;
const BAR_RADIUS = PLAN_PRICE_LAYOUT.barRadius;
const DOT_RADIUS = PLAN_PRICE_LAYOUT.dotRadius;
const Y_AXIS_FONT_SIZE = Math.max(12, FONT_SIZES.axis - 2);

const buildTextMarkup = (params: {
  x: number;
  y: number;
  text: string;
  size: number;
  fontFamily: string;
  weight?: number;
  fill?: string;
}) => {
  const {
    x,
    y,
    text,
    size,
    fontFamily,
    weight = 500,
    fill = COLORS.text,
  } = params;
  return [
    `<text x="${x}" y="${y}"`,
    ` font-family="${fontFamily}" font-size="${size}" font-weight="${weight}"`,
    ` fill="${fill}">`,
    `${escapeText(text)}</text>`,
  ].join('');
};

const buildEmptySvg = (params: {
  width: number;
  height: number;
  fontFamily: string;
  title: string;
  subtitle: string;
}) => {
  const {
    width,
    height,
    fontFamily,
    title,
    subtitle,
  } = params;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeText(title)}">`,
    `<rect width="${width}" height="${height}" fill="${COLORS.background}"/>`,
    buildTextMarkup({
      x: PADDING,
      y: PADDING + 46,
      text: title,
      size: FONT_SIZES.title,
      fontFamily,
      weight: 600,
      fill: COLORS.text,
    }),
    buildTextMarkup({
      x: PADDING,
      y: PADDING + 86,
      text: subtitle,
      size: FONT_SIZES.meta,
      fontFamily,
      weight: 500,
      fill: COLORS.muted,
    }),
    '</svg>',
  ].join('');
};

const buildContext = (params: {
  day: DailyBudgetDayPayload | null;
  isToday: boolean;
  combinedPrices?: CombinedPriceData | null;
  plannedKWh: number[];
  bucketCount: number;
}): PlanPriceEchartsContext => {
  const {
    day,
    isToday,
    combinedPrices,
    plannedKWh,
    bucketCount,
  } = params;
  const { actualKWh, showActual } = resolveActualSeries(params);
  const bucketLabels = day?.buckets?.startLocalLabels ?? [];
  const bucketStartUtc = day?.buckets?.startUtc ?? [];
  const priceUnit = combinedPrices?.priceUnit?.trim() || 'øre/kWh';
  const priceSeries = normalizeSeriesLength(
    resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: day?.buckets?.price,
      combinedPrices,
    }),
    bucketCount,
  );
  const priceStats = buildPriceStats(priceSeries);
  const current = resolveCurrentPlanInfo({
    day,
    plannedKWh,
    priceSeries,
    bucketLabels,
    bucketStartUtc,
    bucketCount,
    isToday,
    priceUnit,
  });
  const lines = buildMetaLines({
    day,
    currentPlan: current.currentPlan,
    currentPriceLabel: current.currentPriceLabel,
    isToday,
    hasPriceData: priceStats.priceValues.length > 0,
    showNow: current.showNow,
  });
  return {
    bucketCount,
    bucketLabels,
    bucketStartUtc,
    plannedKWh,
    maxPlan: Math.max(1, ...plannedKWh),
    actualKWh,
    showActual,
    priceSeries,
    priceValues: priceStats.priceValues,
    priceMin: priceStats.priceMin,
    priceMax: priceStats.priceMax,
    priceUnit,
    currentIndex: current.currentIndex,
    currentPrice: current.currentPrice,
    showNow: current.showNow,
    ariaDescription: [lines.metaLine, lines.nowLine].filter(Boolean).join('. '),
    labelEvery: resolveLabelEvery(bucketCount),
  };
};

const resolvePriceAxisBounds = (context: PlanPriceEchartsContext) => {
  if (context.priceValues.length === 0) return { min: 0, max: 1 };
  if (Math.abs(context.priceMax - context.priceMin) < 0.001) {
    return {
      min: context.priceMin - 1,
      max: context.priceMax + 1,
    };
  }
  return { min: context.priceMin, max: context.priceMax };
};

const buildPlanSeries = (params: {
  legendText: string;
  context: PlanPriceEchartsContext;
  barWidth: number;
}): BarSeriesOption => {
  const { legendText, context, barWidth } = params;
  const markLine = context.showNow
    ? {
      symbol: ['none', 'none'] as ['none', 'none'],
      silent: true,
      lineStyle: {
        color: COLORS.nowStroke,
        width: 2,
        opacity: 0.85,
      },
      label: {
        show: true,
        formatter: 'Now',
        color: COLORS.nowStroke,
      },
      data: [{ xAxis: context.currentIndex }],
    }
    : undefined;

  return {
    name: legendText,
    type: 'bar',
    yAxisIndex: 0,
    data: context.plannedKWh,
    barWidth: Math.max(6, barWidth),
    itemStyle: {
      color: COLORS.plan,
      borderRadius: [BAR_RADIUS, BAR_RADIUS, 0, 0],
    },
    emphasis: { disabled: true },
    ...(markLine ? { markLine } : {}),
  };
};

const buildPriceSeries = (params: {
  legendText: string;
  context: PlanPriceEchartsContext;
}): LineSeriesOption => {
  const { legendText, context } = params;
  const markPoint = context.showNow && typeof context.currentPrice === 'number' && Number.isFinite(context.currentPrice)
    ? {
      symbol: 'circle',
      symbolSize: DOT_RADIUS * 2,
      itemStyle: {
        color: COLORS.price,
        borderColor: COLORS.background,
        borderWidth: 2,
      },
      label: { show: false },
      data: [{ name: 'Now', coord: [context.currentIndex, context.currentPrice] }],
    }
    : undefined;

  return {
    name: legendText,
    type: 'line',
    yAxisIndex: 1,
    data: context.priceSeries.map((value) => (
      Number.isFinite(value) ? value : null
    )),
    connectNulls: false,
    smooth: false,
    symbol: 'circle',
    symbolSize: 6,
    lineStyle: {
      color: COLORS.price,
      width: PRICE_LINE_WIDTH,
      shadowColor: COLORS.priceShadow,
      shadowBlur: 6,
    },
    itemStyle: {
      color: COLORS.price,
    },
    z: 3,
    ...(markPoint ? { markPoint } : {}),
  };
};

const buildXAxisOption = (params: {
  context: PlanPriceEchartsContext;
  categories: string[];
}): NonNullable<EChartsOption['xAxis']> => {
  const { context, categories } = params;
  return {
    type: 'category',
    boundaryGap: true,
    data: categories,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: COLORS.grid } },
    axisLabel: {
      color: COLORS.muted,
      fontSize: FONT_SIZES.axis,
      formatter: (value: string, index: number) => (
        index % context.labelEvery !== 0 && index !== context.bucketCount - 1 ? '' : value
      ),
    },
  };
};

const buildYAxisOption = (params: {
  context: PlanPriceEchartsContext;
  priceBounds: { min: number; max: number };
}): NonNullable<EChartsOption['yAxis']> => {
  const { context, priceBounds } = params;
  return [
    {
      type: 'value',
      min: 0,
      max: Math.max(1, context.maxPlan * 1.08),
      splitNumber: GRID_LINES,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: COLORS.text, fontSize: Y_AXIS_FONT_SIZE, fontWeight: 600, formatter: (value: number) => formatNumber(value, 1) },
      splitLine: { lineStyle: { color: COLORS.grid, width: 1 } },
    },
    {
      type: 'value',
      min: priceBounds.min,
      max: priceBounds.max,
      splitNumber: GRID_LINES,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: COLORS.text, fontSize: Y_AXIS_FONT_SIZE, fontWeight: 600, formatter: (value: number) => formatNumber(value, 0) },
      splitLine: { show: false },
    },
  ];
};

const buildGraphicElements = (params: {
  context: PlanPriceEchartsContext;
  fontFamily: string;
  chartWidth: number;
  chartTop: number;
  chartHeight: number;
}): NonNullable<EChartsOption['graphic']> => {
  const { context, fontFamily, chartWidth, chartTop, chartHeight } = params;
  const panel = {
    type: 'rect',
    left: PADDING,
    top: chartTop,
    z: -10,
    silent: true,
    shape: {
      width: chartWidth,
      height: chartHeight,
      r: 12,
    },
    style: {
      fill: COLORS.panel,
      stroke: COLORS.panelBorder,
      lineWidth: 1,
    },
  } as const;
  if (context.priceValues.length > 0) return [panel];
  return [
    panel,
    {
      type: 'text',
      right: PADDING + 10,
      top: chartTop + 10,
      silent: true,
      style: {
        text: 'Price data missing',
        fill: COLORS.muted,
        fontSize: FONT_SIZES.meta,
        fontFamily,
      },
    },
  ];
};

const buildChartOption = (params: {
  width: number;
  height: number;
  fontFamily: string;
  context: PlanPriceEchartsContext;
}): EChartsOption => {
  const { width, height, fontFamily, context } = params;
  const legendTexts = buildLegendTexts();
  const chartWidth = Math.max(1, width - PADDING * 2);
  const chartTop = PADDING + HEADER_HEIGHT;
  const chartBottom = LEGEND_HEIGHT + PADDING;
  const chartHeight = Math.max(1, height - chartTop - chartBottom);
  const barWidth = Math.floor((chartWidth / Math.max(1, context.bucketCount)) * 0.78);
  const priceBounds = resolvePriceAxisBounds(context);
  const categories = Array.from({ length: context.bucketCount }, (_value, index) => (
    resolveLabel(context.bucketLabels, context.bucketStartUtc, index)
  ));

  return {
    animation: false,
    aria: {
      enabled: true,
      description: context.ariaDescription,
    },
    backgroundColor: COLORS.background,
    textStyle: { fontFamily },
    legend: buildLegendOption({
      legendTexts,
      showActual: context.showActual,
    }),
    grid: { left: PADDING, right: PADDING, top: chartTop, bottom: chartBottom, containLabel: false },
    xAxis: buildXAxisOption({ context, categories }),
    yAxis: buildYAxisOption({ context, priceBounds }),
    graphic: buildGraphicElements({
      context,
      fontFamily,
      chartWidth,
      chartTop,
      chartHeight,
    }),
    series: [
      buildPlanSeries({ legendText: legendTexts.plan, context, barWidth }),
      ...(context.showActual ? [buildActualSeries({ context })] : []),
      buildPriceSeries({ legendText: legendTexts.price, context }),
    ],
  };
};

export async function buildPlanPriceSvgWithEcharts(params: PlanPriceEchartsParams): Promise<string> {
  const stopSpan = startRuntimeSpan('camera_svg_echarts');
  try {
    const {
      snapshot,
      dayKey,
      combinedPrices,
      width: requestedWidth,
      height: requestedHeight,
      fontFamily,
    } = params;
    const width = PLAN_PRICE_VIEWPORT.width;
    const height = PLAN_PRICE_VIEWPORT.height;
    const day = resolvePlanSnapshotDay(snapshot, dayKey);
    const plannedRaw = day?.buckets?.plannedKWh ?? [];
    const plannedKWh = plannedRaw.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
    const bucketCount = plannedKWh.length;
    if (!bucketCount || requestedWidth <= 0 || requestedHeight <= 0) {
      const subtitle = day?.budget?.enabled === false
        ? 'Daily budget disabled'
        : 'No plan data available';
      return buildEmptySvg({
        width,
        height,
        fontFamily,
        title: 'Budget and Price',
        subtitle,
      });
    }

    const context = buildContext({
      day,
      isToday: resolvePlanIsToday(snapshot, dayKey),
      combinedPrices,
      plannedKWh,
      bucketCount,
    });
    const chart = getEchartsRuntime().init(null, null, {
      renderer: 'svg',
      ssr: true,
      width,
      height,
    });
    try {
      chart.setOption(buildChartOption({
        width,
        height,
        fontFamily,
        context,
      }), {
        notMerge: true,
        lazyUpdate: false,
      });
      return chart.renderToSVGString({ useViewBox: true });
    } finally {
      chart.dispose();
    }
  } finally {
    stopSpan();
  }
}
