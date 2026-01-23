import fs from 'node:fs';
import path from 'node:path';

import type { CombinedPriceData } from '../dailyBudget/dailyBudgetMath';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { clamp } from '../utils/mathUtils';
import {
  buildMetaLines,
  buildPricePath,
  buildPriceStats,
  escapeText,
  formatNumber,
  normalizeSeriesLength,
  resolveCurrentPlanInfo,
  resolveLabel,
  resolveLabelEvery,
  resolvePriceSeries,
} from './planPriceImageUtils';

type PlanPriceImageParams = {
  snapshot: DailyBudgetUiPayload | null;
  dayKey?: string | null;
  combinedPrices?: CombinedPriceData | null;
  width?: number;
  height?: number;
};

type Layout = {
  width: number;
  height: number;
  chartWidth: number;
  chartHeight: number;
  chartLeft: number;
  chartTop: number;
  axisLabelY: number;
  legendTop: number;
  slotWidth: number;
  barWidth: number;
  barOffset: number;
};

type PlanPriceContext = {
  bucketCount: number;
  bucketLabels: string[];
  bucketStartUtc: string[];
  plannedKWh: number[];
  maxPlan: number;
  priceSeries: Array<number | null>;
  priceValues: number[];
  priceMin: number;
  priceMax: number;
  priceSpan: number;
  priceUnit: string;
  currentIndex: number;
  currentLabel: string;
  currentPlan: number;
  currentPrice: number | null;
  currentPriceLabel: string;
  showNow: boolean;
  metaLine: string;
  nowLine: string;
  labelEvery: number;
};

type TextAnchor = 'start' | 'middle' | 'end';

const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 1000;
const PADDING = 32;
const HEADER_HEIGHT = 140;
const AXIS_LABEL_HEIGHT = 32;
const LEGEND_HEIGHT = 84;
const GRID_LINES = 4;
const BAR_RADIUS = 4;
const DOT_RADIUS = 5;
const PRICE_LINE_WIDTH = 4;
const PRICE_LINE_OUTLINE_WIDTH = 7;

const FONT_SIZES = {
  title: 36,
  meta: 24,
  now: 26,
  axis: 20,
  legend: 22,
  label: 20,
};

const COLORS = {
  background: '#101614',
  panel: '#151F1B',
  grid: '#24312B',
  text: '#E6EFE8',
  muted: '#9FB2A7',
  plan: '#5CCB6B',
  price: '#F2A13E',
  priceShadow: '#0D1512',
  nowFill: '#22342D',
  nowStroke: '#E6EFE8',
};

const FONT_FILES = resolveFontFiles();
const DEFAULT_FONT_FAMILY = FONT_FILES.length > 0 ? 'IBM Plex Sans' : 'sans-serif';
let resvgPromise: Promise<typeof import('@resvg/resvg-js')> | null = null;

export function buildPlanPriceSvg(params: PlanPriceImageParams): string {
  const {
    snapshot,
    dayKey,
    combinedPrices,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
  } = params;

  const day = resolveSnapshotDay(snapshot, dayKey);
  const isToday = resolveIsToday(snapshot, dayKey);
  const plannedRaw = day?.buckets?.plannedKWh ?? [];
  const plannedKWh = plannedRaw.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  const bucketCount = plannedKWh.length;

  const layout = buildLayout({ width, height, bucketCount });
  if (!layout) {
    const subtitle = day?.budget?.enabled === false
      ? 'Daily budget disabled'
      : 'No plan data available';
    return buildEmptySvg({
      width,
      height,
      title: 'Budget and Price',
      subtitle,
    });
  }

  const context = buildPlanPriceContext({
    day,
    isToday,
    combinedPrices,
    plannedKWh,
    bucketCount,
  });

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Budget and price">`,
    `<rect width="${width}" height="${height}" fill="${COLORS.background}"/>`,
    `<rect x="${layout.chartLeft}" y="${layout.chartTop}" width="${layout.chartWidth}" height="${layout.chartHeight}" fill="${COLORS.panel}" rx="12" ry="12"/>`,
    ...buildHeaderMarkup(context),
    ...buildChartMarkup({ layout, context }),
    ...buildAxisLabelsMarkup({ layout, context }),
    ...buildLegendMarkup({ layout, context }),
    '</svg>',
  ];
  return parts.join('');
}

export async function buildPlanPricePng(params: PlanPriceImageParams): Promise<Uint8Array> {
  const width = params.width ?? DEFAULT_WIDTH;
  const height = params.height ?? DEFAULT_HEIGHT;
  const svg = buildPlanPriceSvg({ ...params, width, height });
  const { Resvg } = await loadResvg();
  const baseOptions = {
    fitTo: { mode: 'width', value: width },
  } as const;
  const fontOptions = {
    font: {
      loadSystemFonts: true,
      defaultFontFamily: DEFAULT_FONT_FAMILY,
      sansSerifFamily: DEFAULT_FONT_FAMILY,
      ...(FONT_FILES.length > 0 ? { fontFiles: FONT_FILES } : {}),
    },
  };
  try {
    const resvg = new Resvg(svg, { ...baseOptions, ...fontOptions });
    return resvg.render().asPng();
  } catch (error) {
    console.warn('Plan image: failed to render with custom fonts, falling back', error);
    const resvg = new Resvg(svg, baseOptions);
    return resvg.render().asPng();
  }
}

const loadResvg = async (): Promise<typeof import('@resvg/resvg-js')> => {
  if (!resvgPromise) {
    resvgPromise = import('@resvg/resvg-js');
  }
  return resvgPromise;
};

function resolveSnapshotDay(
  snapshot: DailyBudgetUiPayload | null,
  dayKey?: string | null,
): DailyBudgetDayPayload | null {
  if (!snapshot) return null;
  const resolvedKey = dayKey ?? snapshot.todayKey;
  if (!resolvedKey) return null;
  return snapshot.days[resolvedKey] ?? null;
}

function resolveIsToday(snapshot: DailyBudgetUiPayload | null, dayKey?: string | null): boolean {
  if (!snapshot) return true;
  const resolvedKey = dayKey ?? snapshot.todayKey;
  if (!resolvedKey) return true;
  return resolvedKey === snapshot.todayKey;
}

function resolveFontFiles(): string[] {
  const baseDir = path.resolve(__dirname, '../../assets/fonts');
  const fontFiles = [
    path.join(baseDir, 'IBMPlexSans-Regular.ttf'),
    path.join(baseDir, 'IBMPlexSans-SemiBold.ttf'),
  ];
  return fontFiles.filter((file) => fs.existsSync(file));
}

function buildTextMarkup(params: {
  x: number;
  y: number;
  text: string;
  size: number;
  weight?: number;
  fill?: string;
  anchor?: TextAnchor;
}): string {
  const {
    x,
    y,
    text,
    size,
    weight = 500,
    fill = COLORS.text,
    anchor,
  } = params;
  const anchorAttr = anchor ? ` text-anchor="${anchor}"` : '';
  return [
    `<text x="${x}" y="${y}"${anchorAttr}`,
    ` font-family="${DEFAULT_FONT_FAMILY}" font-size="${size}" font-weight="${weight}"`,
    ` fill="${fill}">`,
    `${escapeText(text)}</text>`,
  ].join('');
}

function buildLayout(params: { width: number; height: number; bucketCount: number }): Layout | null {
  const { width, height, bucketCount } = params;
  const chartWidth = Math.max(0, width - PADDING * 2);
  const chartHeight = Math.max(0, height - PADDING * 2 - HEADER_HEIGHT - AXIS_LABEL_HEIGHT - LEGEND_HEIGHT);
  if (!bucketCount || chartWidth <= 0 || chartHeight <= 0) return null;
  const chartLeft = PADDING;
  const chartTop = PADDING + HEADER_HEIGHT;
  const axisLabelY = chartTop + chartHeight + AXIS_LABEL_HEIGHT - 2;
  const legendTop = chartTop + chartHeight + AXIS_LABEL_HEIGHT;
  const slotWidth = chartWidth / bucketCount;
  const barWidth = Math.max(4, slotWidth * 0.78);
  const barOffset = (slotWidth - barWidth) / 2;
  return {
    width,
    height,
    chartWidth,
    chartHeight,
    chartLeft,
    chartTop,
    axisLabelY,
    legendTop,
    slotWidth,
    barWidth,
    barOffset,
  };
}

function buildPlanPriceContext(params: {
  day: DailyBudgetDayPayload | null;
  isToday: boolean;
  combinedPrices?: CombinedPriceData | null;
  plannedKWh: number[];
  bucketCount: number;
}): PlanPriceContext {
  const {
    day,
    isToday,
    combinedPrices,
    plannedKWh,
    bucketCount,
  } = params;
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
    priceSeries,
    priceValues: priceStats.priceValues,
    priceMin: priceStats.priceMin,
    priceMax: priceStats.priceMax,
    priceSpan: priceStats.priceSpan,
    priceUnit,
    currentIndex: current.currentIndex,
    currentLabel: current.currentLabel,
    currentPlan: current.currentPlan,
    currentPrice: current.currentPrice,
    currentPriceLabel: current.currentPriceLabel,
    showNow: current.showNow,
    metaLine: lines.metaLine,
    nowLine: lines.nowLine,
    labelEvery: resolveLabelEvery(bucketCount),
  };
}

function buildHeaderMarkup(context: PlanPriceContext): string[] {
  return [
    buildTextMarkup({
      x: PADDING,
      y: PADDING + 42,
      text: 'Budget and Price',
      size: FONT_SIZES.title,
      weight: 600,
      fill: COLORS.text,
    }),
    buildTextMarkup({
      x: PADDING,
      y: PADDING + 78,
      text: context.metaLine,
      size: FONT_SIZES.meta,
      weight: 500,
      fill: COLORS.muted,
    }),
    buildTextMarkup({
      x: PADDING,
      y: PADDING + 114,
      text: context.nowLine,
      size: FONT_SIZES.now,
      weight: 600,
      fill: COLORS.text,
    }),
  ];
}

function buildChartMarkup(params: { layout: Layout; context: PlanPriceContext }): string[] {
  const { layout, context } = params;
  const currentX = layout.chartLeft + context.currentIndex * layout.slotWidth;
  const currentMarker = context.showNow
    ? [
      `<rect x="${currentX}" y="${layout.chartTop}" width="${layout.slotWidth}" height="${layout.chartHeight}" fill="${COLORS.nowFill}" opacity="0.4"/>`,
    ]
    : [];
  const gridLines = Array.from({ length: GRID_LINES }, (_, index) => {
    const y = layout.chartTop + (layout.chartHeight * (index + 1)) / (GRID_LINES + 1);
    return `<line x1="${layout.chartLeft}" y1="${y}" x2="${layout.chartLeft + layout.chartWidth}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1"/>`;
  });
  const bars = Array.from({ length: context.bucketCount }, (_, index) => {
    const value = context.plannedKWh[index] ?? 0;
    const heightRatio = clamp(value / context.maxPlan, 0, 1);
    const barHeight = Math.max(0, heightRatio * layout.chartHeight);
    const barX = layout.chartLeft + index * layout.slotWidth + layout.barOffset;
    const barY = layout.chartTop + layout.chartHeight - barHeight;
    return `<rect x="${barX}" y="${barY}" width="${layout.barWidth}" height="${barHeight}" fill="${COLORS.plan}" rx="${BAR_RADIUS}" ry="${BAR_RADIUS}"/>`;
  });
  const pricePath = buildPricePath({
    priceSeries: context.priceSeries,
    chartLeft: layout.chartLeft,
    chartTop: layout.chartTop,
    chartHeight: layout.chartHeight,
    slotWidth: layout.slotWidth,
    priceMin: context.priceMin,
    priceSpan: context.priceSpan,
  });
  const priceMissingLabel = buildTextMarkup({
    x: layout.chartLeft + layout.chartWidth - 8,
    y: layout.chartTop + 22,
    text: 'Price data missing',
    size: FONT_SIZES.meta,
    weight: 500,
    fill: COLORS.muted,
    anchor: 'end',
  });
  const priceLine = pricePath
    ? [
      `<path d="${pricePath}" fill="none" stroke="${COLORS.priceShadow}" stroke-width="${PRICE_LINE_OUTLINE_WIDTH}" stroke-linejoin="round" stroke-linecap="round" opacity="0.55"/>`,
      `<path d="${pricePath}" fill="none" stroke="${COLORS.price}" stroke-width="${PRICE_LINE_WIDTH}" stroke-linejoin="round" stroke-linecap="round"/>`,
    ]
    : [
      priceMissingLabel,
    ];
  const nowLabel = context.showNow ? buildNowLabelMarkup({ layout, context }) : [];
  const currentDot = context.showNow ? buildCurrentDotMarkup({ layout, context }) : [];
  return [
    ...currentMarker,
    ...gridLines,
    ...bars,
    ...priceLine,
    ...nowLabel,
    ...currentDot,
  ];
}

function buildAxisLabelsMarkup(params: { layout: Layout; context: PlanPriceContext }): string[] {
  const { layout, context } = params;
  return Array.from({ length: context.bucketCount }, (_, index) => {
    if (index % context.labelEvery !== 0 && index !== context.bucketCount - 1) return null;
    const label = resolveLabel(context.bucketLabels, context.bucketStartUtc, index);
    const labelX = layout.chartLeft + (index + 0.5) * layout.slotWidth;
    return buildTextMarkup({
      x: labelX,
      y: layout.axisLabelY,
      text: label,
      size: FONT_SIZES.axis,
      weight: 500,
      fill: COLORS.muted,
      anchor: 'middle',
    });
  }).filter((value): value is string => value !== null);
}

function buildNowLabelMarkup(params: { layout: Layout; context: PlanPriceContext }): string[] {
  const { layout, context } = params;
  const labelX = layout.chartLeft + (context.currentIndex + 0.5) * layout.slotWidth;
  const labelY = layout.chartTop + 24;
  return [
    buildTextMarkup({
      x: labelX,
      y: labelY,
      text: 'Now',
      size: FONT_SIZES.label,
      weight: 700,
      fill: COLORS.nowStroke,
      anchor: 'middle',
    }),
  ];
}

function buildCurrentDotMarkup(params: { layout: Layout; context: PlanPriceContext }): string[] {
  const { layout, context } = params;
  if (typeof context.currentPrice !== 'number' || !Number.isFinite(context.currentPrice)) {
    return [];
  }
  const cx = layout.chartLeft + (context.currentIndex + 0.5) * layout.slotWidth;
  const cy = layout.chartTop + layout.chartHeight
    - ((context.currentPrice - context.priceMin) / context.priceSpan) * layout.chartHeight;
  return [
    `<circle cx="${cx}" cy="${cy}" r="${DOT_RADIUS}" fill="${COLORS.price}" stroke="${COLORS.background}" stroke-width="2"/>`,
  ];
}

function buildLegendMarkup(params: { layout: Layout; context: PlanPriceContext }): string[] {
  const { layout, context } = params;
  const legendStep = layout.chartWidth / 2;
  const legendY = layout.legendTop + 26;
  const legendTextY = legendY + 18;
  const planRangeText = context.plannedKWh.length
    ? `Hourly budget range ${formatNumber(Math.min(...context.plannedKWh), 2)}-${formatNumber(Math.max(...context.plannedKWh), 2)} kWh`
    : 'Hourly budget n/a';
  const priceRangeText = context.priceValues.length
    ? `Price range ${formatNumber(context.priceMin, 0)}-${formatNumber(context.priceMax, 0)} ${context.priceUnit}`
    : 'Price n/a';
  return [
    `<rect x="${layout.chartLeft}" y="${legendY}" width="18" height="12" fill="${COLORS.plan}" rx="3" ry="3"/>`,
    buildTextMarkup({
      x: layout.chartLeft + 26,
      y: legendTextY,
      text: planRangeText,
      size: FONT_SIZES.legend,
      weight: 500,
      fill: COLORS.text,
    }),
    `<line x1="${layout.chartLeft + legendStep}" y1="${legendY + 6}" x2="${layout.chartLeft + legendStep + 24}" y2="${legendY + 6}" stroke="${COLORS.price}" stroke-width="4" stroke-linecap="round"/>`,
    buildTextMarkup({
      x: layout.chartLeft + legendStep + 32,
      y: legendTextY,
      text: priceRangeText,
      size: FONT_SIZES.legend,
      weight: 500,
      fill: COLORS.text,
    }),
  ];
}

function buildEmptySvg(params: { width: number; height: number; title: string; subtitle: string }): string {
  const { width, height, title, subtitle } = params;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeText(title)}">`,
    `<rect width="${width}" height="${height}" fill="${COLORS.background}"/>`,
    buildTextMarkup({
      x: PADDING,
      y: PADDING + 46,
      text: title,
      size: FONT_SIZES.title,
      weight: 600,
      fill: COLORS.text,
    }),
    buildTextMarkup({
      x: PADDING,
      y: PADDING + 86,
      text: subtitle,
      size: FONT_SIZES.meta,
      weight: 500,
      fill: COLORS.muted,
    }),
    '</svg>',
  ].join('');
}
