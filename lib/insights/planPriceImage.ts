import type { CombinedPriceData } from '../dailyBudget/dailyBudgetMath';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { clamp } from '../utils/mathUtils';

type PlanPriceImageParams = {
  snapshot: DailyBudgetUiPayload | null;
  combinedPrices?: CombinedPriceData | null;
  nowMs?: number;
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
  currentIndex: number;
  currentLabel: string;
  currentPlan: number;
  currentPrice: number | null;
  currentPriceLabel: string;
  metaLine: string;
  nowLine: string;
  labelEvery: number;
};

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 520;
const PADDING = 22;
const HEADER_HEIGHT = 82;
const AXIS_LABEL_HEIGHT = 18;
const LEGEND_HEIGHT = 64;
const GRID_LINES = 3;

const COLORS = {
  background: '#101614',
  panel: '#151F1B',
  grid: '#24312B',
  text: '#E6EFE8',
  muted: '#9FB2A7',
  plan: '#5CCB6B',
  price: '#F2A13E',
  nowFill: '#22342D',
  nowStroke: '#E6EFE8',
};

const FONT_FAMILY = 'IBM Plex Sans, Arial, sans-serif';
let resvgPromise: Promise<typeof import('@resvg/resvg-js')> | null = null;

export function buildPlanPriceSvg(params: PlanPriceImageParams): string {
  const {
    snapshot,
    combinedPrices,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
  } = params;

  const plannedRaw = snapshot?.buckets?.plannedKWh ?? [];
  const plannedKWh = plannedRaw.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  const bucketCount = plannedKWh.length;

  const layout = buildLayout({ width, height, bucketCount });
  if (!layout) {
    return buildEmptySvg({
      width,
      height,
      title: 'Plan + Price',
      subtitle: 'No plan data available',
    });
  }

  const context = buildPlanPriceContext({
    snapshot,
    combinedPrices,
    plannedKWh,
    bucketCount,
  });

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Plan and price">`,
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
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
  });
  return resvg.render().asPng();
}

const loadResvg = async (): Promise<typeof import('@resvg/resvg-js')> => {
  if (!resvgPromise) {
    resvgPromise = import('@resvg/resvg-js');
  }
  return resvgPromise;
};

function buildLayout(params: { width: number; height: number; bucketCount: number }): Layout | null {
  const { width, height, bucketCount } = params;
  const chartWidth = Math.max(0, width - PADDING * 2);
  const chartHeight = Math.max(0, height - PADDING * 2 - HEADER_HEIGHT - AXIS_LABEL_HEIGHT - LEGEND_HEIGHT);
  if (!bucketCount || chartWidth <= 0 || chartHeight <= 0) return null;
  const chartLeft = PADDING;
  const chartTop = PADDING + HEADER_HEIGHT;
  const axisLabelY = chartTop + chartHeight + AXIS_LABEL_HEIGHT - 4;
  const legendTop = chartTop + chartHeight + AXIS_LABEL_HEIGHT;
  const slotWidth = chartWidth / bucketCount;
  const barWidth = Math.max(2, slotWidth * 0.72);
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
  snapshot: DailyBudgetUiPayload | null;
  combinedPrices?: CombinedPriceData | null;
  plannedKWh: number[];
  bucketCount: number;
}): PlanPriceContext {
  const {
    snapshot,
    combinedPrices,
    plannedKWh,
    bucketCount,
  } = params;
  const bucketLabels = snapshot?.buckets?.startLocalLabels ?? [];
  const bucketStartUtc = snapshot?.buckets?.startUtc ?? [];
  const priceSeries = normalizeSeriesLength(
    resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: snapshot?.buckets?.price,
      combinedPrices,
    }),
    bucketCount,
  );
  const priceStats = buildPriceStats(priceSeries);
  const current = resolveCurrentPlanInfo({
    snapshot,
    plannedKWh,
    priceSeries,
    bucketLabels,
    bucketStartUtc,
    bucketCount,
  });
  const lines = buildMetaLines({
    snapshot,
    currentLabel: current.currentLabel,
    currentPlan: current.currentPlan,
    currentPriceLabel: current.currentPriceLabel,
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
    currentIndex: current.currentIndex,
    currentLabel: current.currentLabel,
    currentPlan: current.currentPlan,
    currentPrice: current.currentPrice,
    currentPriceLabel: current.currentPriceLabel,
    metaLine: lines.metaLine,
    nowLine: lines.nowLine,
    labelEvery: resolveLabelEvery(bucketCount),
  };
}

function buildHeaderMarkup(context: PlanPriceContext): string[] {
  return [
    `<text x="${PADDING}" y="${PADDING + 26}" style="font: 600 20px ${FONT_FAMILY}; fill: ${COLORS.text};">Plan + Price</text>`,
    `<text x="${PADDING}" y="${PADDING + 50}" style="font: 500 13px ${FONT_FAMILY}; fill: ${COLORS.muted};">${escapeText(context.metaLine)}</text>`,
    `<text x="${PADDING}" y="${PADDING + 70}" style="font: 500 13px ${FONT_FAMILY}; fill: ${COLORS.text};">${escapeText(context.nowLine)}</text>`,
  ];
}

function buildChartMarkup(params: { layout: Layout; context: PlanPriceContext }): string[] {
  const { layout, context } = params;
  const currentX = layout.chartLeft + context.currentIndex * layout.slotWidth;
  const currentMarker = [
    `<rect x="${currentX}" y="${layout.chartTop}" width="${layout.slotWidth}" height="${layout.chartHeight}" fill="${COLORS.nowFill}" opacity="0.5"/>`,
  ];
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
    return `<rect x="${barX}" y="${barY}" width="${layout.barWidth}" height="${barHeight}" fill="${COLORS.plan}" rx="3" ry="3"/>`;
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
  const priceLine = pricePath
    ? [`<path d="${pricePath}" fill="none" stroke="${COLORS.price}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`]
    : [
      `<text x="${layout.chartLeft + layout.chartWidth - 8}" y="${layout.chartTop + 16}" text-anchor="end" style="font: 500 12px ${FONT_FAMILY}; fill: ${COLORS.muted};">Price data missing</text>`,
    ];
  const currentDot = buildCurrentDotMarkup({ layout, context });
  return [
    ...currentMarker,
    ...gridLines,
    ...bars,
    ...priceLine,
    ...currentDot,
  ];
}

function buildAxisLabelsMarkup(params: { layout: Layout; context: PlanPriceContext }): string[] {
  const { layout, context } = params;
  return Array.from({ length: context.bucketCount }, (_, index) => {
    if (index % context.labelEvery !== 0 && index !== context.bucketCount - 1) return null;
    const label = resolveLabel(context.bucketLabels, context.bucketStartUtc, index);
    const labelX = layout.chartLeft + (index + 0.5) * layout.slotWidth;
    return `<text x="${labelX}" y="${layout.axisLabelY}" text-anchor="middle" style="font: 500 11px ${FONT_FAMILY}; fill: ${COLORS.muted};">${escapeText(label)}</text>`;
  }).filter((value): value is string => value !== null);
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
    `<circle cx="${cx}" cy="${cy}" r="4" fill="${COLORS.price}" stroke="${COLORS.background}" stroke-width="2"/>`,
  ];
}

function buildLegendMarkup(params: { layout: Layout; context: PlanPriceContext }): string[] {
  const { layout, context } = params;
  const legendStep = layout.chartWidth / 3;
  const legendY = layout.legendTop + 26;
  const legendTextY = legendY + 10;
  const priceRangeText = context.priceValues.length
    ? `Price (ore/kWh, ${formatNumber(context.priceMin, 0)}-${formatNumber(context.priceMax, 0)})`
    : 'Price (n/a)';
  return [
    `<rect x="${layout.chartLeft}" y="${legendY}" width="16" height="10" fill="${COLORS.plan}" rx="2" ry="2"/>`,
    `<text x="${layout.chartLeft + 24}" y="${legendTextY}" style="font: 500 12px ${FONT_FAMILY}; fill: ${COLORS.text};">Plan (kWh/h)</text>`,
    `<line x1="${layout.chartLeft + legendStep}" y1="${legendY + 5}" x2="${layout.chartLeft + legendStep + 18}" y2="${legendY + 5}" stroke="${COLORS.price}" stroke-width="3" stroke-linecap="round"/>`,
    `<text x="${layout.chartLeft + legendStep + 26}" y="${legendTextY}" style="font: 500 12px ${FONT_FAMILY}; fill: ${COLORS.text};">${escapeText(priceRangeText)}</text>`,
    `<rect x="${layout.chartLeft + legendStep * 2}" y="${legendY - 2}" width="16" height="14" fill="none" stroke="${COLORS.nowStroke}" stroke-width="2" rx="3" ry="3"/>`,
    `<text x="${layout.chartLeft + legendStep * 2 + 26}" y="${legendTextY}" style="font: 500 12px ${FONT_FAMILY}; fill: ${COLORS.text};">Current hour</text>`,
  ];
}

function buildPriceStats(priceSeries: Array<number | null>): {
  priceValues: number[];
  priceMin: number;
  priceMax: number;
  priceSpan: number;
} {
  const priceValues = priceSeries.filter((value): value is number => (
    typeof value === 'number' && Number.isFinite(value)
  ));
  const priceMin = priceValues.length ? Math.min(...priceValues) : 0;
  const priceMax = priceValues.length ? Math.max(...priceValues) : 1;
  const priceSpan = Math.max(1, priceMax - priceMin);
  return {
    priceValues,
    priceMin,
    priceMax,
    priceSpan,
  };
}

function resolveCurrentPlanInfo(params: {
  snapshot: DailyBudgetUiPayload | null;
  plannedKWh: number[];
  priceSeries: Array<number | null>;
  bucketLabels: string[];
  bucketStartUtc: string[];
  bucketCount: number;
}): {
  currentIndex: number;
  currentLabel: string;
  currentPlan: number;
  currentPrice: number | null;
  currentPriceLabel: string;
} {
  const {
    snapshot,
    plannedKWh,
    priceSeries,
    bucketLabels,
    bucketStartUtc,
    bucketCount,
  } = params;
  const currentIndex = clamp(snapshot?.currentBucketIndex ?? 0, 0, bucketCount - 1);
  const currentLabel = resolveLabel(bucketLabels, bucketStartUtc, currentIndex);
  const currentPlan = plannedKWh[currentIndex] ?? 0;
  const currentPrice = priceSeries[currentIndex] ?? null;
  const currentPriceLabel = typeof currentPrice === 'number' && Number.isFinite(currentPrice)
    ? `${formatNumber(currentPrice, 0)} ore/kWh`
    : 'Price n/a';
  return {
    currentIndex,
    currentLabel,
    currentPlan,
    currentPrice,
    currentPriceLabel,
  };
}

function buildMetaLines(params: {
  snapshot: DailyBudgetUiPayload | null;
  currentLabel: string;
  currentPlan: number;
  currentPriceLabel: string;
}): {
  metaLine: string;
  nowLine: string;
} {
  const {
    snapshot,
    currentLabel,
    currentPlan,
    currentPriceLabel,
  } = params;
  const budgetStatus = snapshot?.budget?.enabled ? 'Daily budget on' : 'Daily budget off';
  const metaLine = snapshot ? `${snapshot.dateKey} ${snapshot.timeZone} | ${budgetStatus}` : budgetStatus;
  const nowLine = `Now ${currentLabel || '--'} | Plan ${formatNumber(currentPlan, 2)} kWh | ${currentPriceLabel}`;
  return { metaLine, nowLine };
}

function buildPricePath(params: {
  priceSeries: Array<number | null>;
  chartLeft: number;
  chartTop: number;
  chartHeight: number;
  slotWidth: number;
  priceMin: number;
  priceSpan: number;
}): string {
  const {
    priceSeries,
    chartLeft,
    chartTop,
    chartHeight,
    slotWidth,
    priceMin,
    priceSpan,
  } = params;
  let path = '';
  let started = false;
  priceSeries.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      started = false;
      return;
    }
    const x = chartLeft + (index + 0.5) * slotWidth;
    const y = chartTop + chartHeight - ((value - priceMin) / priceSpan) * chartHeight;
    path += `${started ? ' L' : ' M'}${x} ${y}`;
    started = true;
  });
  return path.trim();
}

function resolvePriceSeries(params: {
  bucketStartUtc: string[];
  bucketPrices?: Array<number | null>;
  combinedPrices?: CombinedPriceData | null;
}): Array<number | null> {
  const { bucketStartUtc, bucketPrices, combinedPrices } = params;
  if (Array.isArray(bucketPrices) && bucketPrices.length === bucketStartUtc.length) {
    return bucketPrices.map((value) => (
      typeof value === 'number' && Number.isFinite(value) ? value : null
    ));
  }
  if (!combinedPrices?.prices?.length || bucketStartUtc.length === 0) {
    return bucketStartUtc.map(() => null);
  }
  const priceByStart = new Map<number, number>();
  combinedPrices.prices.forEach((entry) => {
    const ts = Date.parse(entry.startsAt);
    if (Number.isFinite(ts) && Number.isFinite(entry.total)) {
      priceByStart.set(ts, entry.total);
    }
  });
  return bucketStartUtc.map((iso) => {
    const ts = Date.parse(iso);
    const value = priceByStart.get(ts);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
}

function normalizeSeriesLength(series: Array<number | null>, count: number): Array<number | null> {
  if (series.length === count) return series;
  return Array.from({ length: count }, (_, index) => series[index] ?? null);
}

function resolveLabel(labels: string[], startUtc: string[], index: number): string {
  const label = labels[index];
  if (typeof label === 'string' && label.trim()) return label;
  const iso = startUtc[index];
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function resolveLabelEvery(bucketCount: number): number {
  if (bucketCount <= 8) return 1;
  if (bucketCount <= 12) return 2;
  if (bucketCount <= 24) return 4;
  return Math.max(1, Math.round(bucketCount / 6));
}

function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '--';
  return value.toFixed(digits);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmptySvg(params: { width: number; height: number; title: string; subtitle: string }): string {
  const { width, height, title, subtitle } = params;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeText(title)}">`,
    `<rect width="${width}" height="${height}" fill="${COLORS.background}"/>`,
    `<text x="${PADDING}" y="${PADDING + 32}" style="font: 600 20px ${FONT_FAMILY}; fill: ${COLORS.text};">${escapeText(title)}</text>`,
    `<text x="${PADDING}" y="${PADDING + 58}" style="font: 500 13px ${FONT_FAMILY}; fill: ${COLORS.muted};">${escapeText(subtitle)}</text>`,
    '</svg>',
  ].join('');
}
