import type { CombinedPriceData } from '../../../lib/dailyBudget/dailyBudgetPrices';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../lib/dailyBudget/dailyBudgetTypes';
import type {
  PlanPriceWidgetEmptyPayload,
  PlanPriceWidgetPayload,
  WidgetTarget,
} from './planPriceWidgetTypes';

const WIDGET_TITLE = 'Budget and Price';

const EMPTY_STATE_SUBTITLES = {
  budget_disabled: 'Daily budget disabled',
  no_data: 'No plan data available',
  tomorrow_pending: 'Tomorrow plan not available yet',
} as const;

type EmptyStateReason = keyof typeof EMPTY_STATE_SUBTITLES;

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const resolveWidgetTarget = (value: unknown): WidgetTarget => (
  value === 'tomorrow' ? 'tomorrow' : 'today'
);

const normalizeSeriesLength = (
  series: ReadonlyArray<number | null>,
  count: number,
): Array<number | null> => Array.from({ length: count }, (_value, index) => series[index] ?? null);

export const resolveLabel = (
  labels: ReadonlyArray<string>,
  startUtc: ReadonlyArray<string>,
  index: number,
): string => {
  const label = labels[index];
  if (typeof label === 'string' && label.trim()) {
    const separatorIndex = label.indexOf(':');
    return separatorIndex >= 0 ? label.slice(0, separatorIndex).trim() : label.trim();
  }

  const iso = startUtc[index];
  if (!iso) return '';

  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return String(date.getHours()).padStart(2, '0');
};

export const resolveLabelEvery = (bucketCount: number): number => {
  if (bucketCount <= 8) return 1;
  if (bucketCount <= 12) return 2;
  if (bucketCount <= 24) return 4;
  return Math.max(1, Math.round(bucketCount / 6));
};

export const resolvePriceSeries = (params: {
  bucketStartUtc: ReadonlyArray<string>;
  bucketPrices: ReadonlyArray<number | null | undefined>;
  combinedPrices: CombinedPriceData | null;
}): Array<number | null> => {
  const { bucketStartUtc, bucketPrices, combinedPrices } = params;

  if (bucketPrices.length === bucketStartUtc.length) {
    return bucketPrices.map((value) => (isFiniteNumber(value) ? value : null));
  }

  if (!combinedPrices?.prices || bucketStartUtc.length === 0) {
    return bucketStartUtc.map(() => null);
  }

  const priceByStart = new Map<number, number>();
  for (const entry of combinedPrices.prices) {
    if (!entry || typeof entry !== 'object') continue;
    const timestamp = Date.parse(entry.startsAt);
    if (!Number.isFinite(timestamp) || !isFiniteNumber(entry.total)) continue;
    priceByStart.set(timestamp, entry.total);
  }

  return bucketStartUtc.map((iso) => {
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return null;
    return priceByStart.get(timestamp) ?? null;
  });
};

const buildPriceStats = (priceSeries: ReadonlyArray<number | null>) => {
  const priceValues = priceSeries.filter(isFiniteNumber);
  return {
    priceValues,
    priceMin: priceValues.length > 0 ? Math.min(...priceValues) : 0,
    priceMax: priceValues.length > 0 ? Math.max(...priceValues) : 1,
  };
};

const resolveActualSeries = (
  day: DailyBudgetDayPayload | null,
  bucketCount: number,
  isToday: boolean,
) => {
  const actualKwh = normalizeSeriesLength(
    Array.isArray(day?.buckets.actualKWh)
      ? day.buckets.actualKWh.map((value) => (isFiniteNumber(value) ? Math.max(0, value) : null))
      : [],
    bucketCount,
  );

  return {
    actualKwh,
    showActual: isToday && actualKwh.some(isFiniteNumber),
  };
};

const resolveCurrentState = (
  day: DailyBudgetDayPayload | null,
  bucketCount: number,
  isToday: boolean,
) => {
  const rawIndex = day?.currentBucketIndex;
  const hasCurrentIndex = isFiniteNumber(rawIndex);
  const maxIndex = Math.max(0, bucketCount - 1);
  const currentIndex = hasCurrentIndex ? clamp(rawIndex, 0, maxIndex) : 0;
  const showNow = Boolean(
    isToday
      && hasCurrentIndex
      && rawIndex >= 0
      && rawIndex < bucketCount,
  );

  return { currentIndex, showNow };
};

const buildEmptyPayload = (
  target: WidgetTarget,
  reason: EmptyStateReason,
): PlanPriceWidgetEmptyPayload => ({
  state: 'empty',
  target,
  title: WIDGET_TITLE,
  subtitle: EMPTY_STATE_SUBTITLES[reason],
});

const resolveDayKey = (
  snapshot: DailyBudgetUiPayload | null,
  target: WidgetTarget,
): string | null => {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const key = target === 'tomorrow' ? snapshot.tomorrowKey : snapshot.todayKey;
  return typeof key === 'string' && key.trim() ? key : null;
};

const resolveDay = (snapshot: DailyBudgetUiPayload | null, target: WidgetTarget) => {
  const dayKey = resolveDayKey(snapshot, target);
  if (!dayKey || !snapshot?.days || typeof snapshot.days !== 'object') {
    return { day: null, dayKey };
  }

  return {
    day: snapshot.days[dayKey] ?? null,
    dayKey,
  };
};

export const buildPlanPriceWidgetPayload = (params: {
  snapshot: DailyBudgetUiPayload | null;
  combinedPrices: CombinedPriceData | null;
  target: unknown;
}): PlanPriceWidgetPayload => {
  const resolvedTarget = resolveWidgetTarget(params.target);
  const { day, dayKey } = resolveDay(params.snapshot, resolvedTarget);

  if (!day || !dayKey) {
    return buildEmptyPayload(
      resolvedTarget,
      resolvedTarget === 'tomorrow' ? 'tomorrow_pending' : 'no_data',
    );
  }

  const plannedKwh = Array.isArray(day.buckets.plannedKWh)
    ? day.buckets.plannedKWh.map((value) => (isFiniteNumber(value) ? Math.max(0, value) : 0))
    : [];
  const bucketCount = plannedKwh.length;

  if (bucketCount === 0) {
    let emptyReason: EmptyStateReason = 'no_data';
    if (day.budget.enabled === false) {
      emptyReason = 'budget_disabled';
    } else if (resolvedTarget === 'tomorrow') {
      emptyReason = 'tomorrow_pending';
    }

    return buildEmptyPayload(
      resolvedTarget,
      emptyReason,
    );
  }

  const bucketStartUtc = Array.isArray(day.buckets.startUtc) ? day.buckets.startUtc : [];
  const labels = Array.isArray(day.buckets.startLocalLabels) ? day.buckets.startLocalLabels : [];
  const bucketLabels = Array.from(
    { length: bucketCount },
    (_value, index) => resolveLabel(labels, bucketStartUtc, index),
  );
  const priceSeries = normalizeSeriesLength(
    resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: Array.isArray(day.buckets.price) ? day.buckets.price : [],
      combinedPrices: params.combinedPrices,
    }),
    bucketCount,
  );
  const priceStats = buildPriceStats(priceSeries);
  const isToday = resolvedTarget === 'today';
  const { actualKwh, showActual } = resolveActualSeries(day, bucketCount, isToday);
  const { currentIndex, showNow } = resolveCurrentState(day, bucketCount, isToday);

  return {
    state: 'ready',
    target: resolvedTarget,
    dateKey: typeof day.dateKey === 'string' ? day.dateKey : dayKey,
    bucketLabels,
    plannedKwh,
    actualKwh,
    showActual,
    priceSeries,
    hasPriceData: priceStats.priceValues.length > 0,
    currentIndex,
    showNow,
    labelEvery: resolveLabelEvery(bucketCount),
    maxPlan: Math.max(1, ...plannedKwh),
    priceMin: priceStats.priceMin,
    priceMax: priceStats.priceMax,
  };
};

export { WIDGET_TITLE };
