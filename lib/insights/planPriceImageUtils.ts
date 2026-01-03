import type { CombinedPriceData } from '../dailyBudget/dailyBudgetMath';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { clamp } from '../utils/mathUtils';

export function buildPriceStats(priceSeries: Array<number | null>): {
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

export function resolveCurrentPlanInfo(params: {
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
    ? `${formatNumber(currentPrice, 0)} øre/kWh`
    : 'Price n/a';
  return {
    currentIndex,
    currentLabel,
    currentPlan,
    currentPrice,
    currentPriceLabel,
  };
}

export function buildMetaLines(params: {
  snapshot: DailyBudgetUiPayload | null;
  currentPlan: number;
  currentPriceLabel: string;
}): {
  metaLine: string;
  nowLine: string;
} {
  const {
    snapshot,
    currentPlan,
    currentPriceLabel,
  } = params;
  const metaLine = snapshot?.dateKey ?? '';
  const nowLine = `Current hour: ${formatNumber(currentPlan, 2)} kWh, ${currentPriceLabel}`;
  return { metaLine, nowLine };
}

export function buildPricePath(params: {
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

export function resolvePriceSeries(params: {
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

export function normalizeSeriesLength(series: Array<number | null>, count: number): Array<number | null> {
  if (series.length === count) return series;
  return Array.from({ length: count }, (_, index) => series[index] ?? null);
}

export function resolveLabel(labels: string[], startUtc: string[], index: number): string {
  const label = labels[index];
  if (typeof label === 'string' && label.trim()) {
    return label.split(':')[0].trim();
  }
  const iso = startUtc[index];
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return pad2(date.getHours());
}

export function resolveLabelEvery(bucketCount: number): number {
  if (bucketCount <= 8) return 1;
  if (bucketCount <= 12) return 2;
  if (bucketCount <= 24) return 4;
  return Math.max(1, Math.round(bucketCount / 6));
}

export function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '--';
  return value.toFixed(digits);
}

export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
