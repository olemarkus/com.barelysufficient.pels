import type { CombinedPriceData } from '../dailyBudget/dailyBudgetMath';
import type { DailyBudgetDayPayload } from '../dailyBudget/dailyBudgetTypes';
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
  day: DailyBudgetDayPayload | null;
  plannedKWh: number[];
  priceSeries: Array<number | null>;
  bucketLabels: string[];
  bucketStartUtc: string[];
  bucketCount: number;
  isToday: boolean;
}): {
  currentIndex: number;
  currentLabel: string;
  currentPlan: number;
  currentPrice: number | null;
  currentPriceLabel: string;
  showNow: boolean;
} {
  const {
    day,
    plannedKWh,
    priceSeries,
    bucketLabels,
    bucketStartUtc,
    bucketCount,
    isToday,
  } = params;
  const rawIndex = day?.currentBucketIndex;
  const hasCurrentIndex = typeof rawIndex === 'number'
    && Number.isFinite(rawIndex)
    && rawIndex >= 0
    && rawIndex < bucketCount;
  const currentIndex = hasCurrentIndex ? rawIndex : clamp(0, 0, Math.max(0, bucketCount - 1));
  const showNow = isToday && hasCurrentIndex;
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
    showNow,
  };
}

export function buildMetaLines(params: {
  day: DailyBudgetDayPayload | null;
  currentPlan: number;
  currentPriceLabel: string;
  isToday: boolean;
  hasPriceData: boolean;
  showNow: boolean;
}): {
  metaLine: string;
  nowLine: string;
} {
  const {
    day,
    currentPlan,
    currentPriceLabel,
    isToday,
    hasPriceData,
    showNow,
  } = params;
  const metaLine = [
    day?.dateKey ?? null,
    !isToday && day?.dateKey ? 'Tomorrow' : null,
    !hasPriceData ? 'Prices pending' : null,
  ].filter((value): value is string => Boolean(value)).join(' • ');
  const label = showNow ? 'Current hour' : 'Plan preview';
  const nowLine = `${label}: ${formatNumber(currentPlan, 2)} kWh, ${currentPriceLabel}`;
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
