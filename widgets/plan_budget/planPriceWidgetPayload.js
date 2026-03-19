/* global module */
'use strict';

const WIDGET_TITLE = 'Budget and Price';

const EMPTY_STATE_SUBTITLES = {
  budget_disabled: 'Daily budget disabled',
  no_data: 'No plan data available',
  tomorrow_pending: 'Tomorrow plan not available yet',
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const resolveWidgetTarget = (value) => (value === 'tomorrow' ? 'tomorrow' : 'today');

const normalizeSeriesLength = (series, count) => {
  if (series.length === count) return series;
  return Array.from({ length: count }, (_, index) => series[index] ?? null);
};

const resolveLabel = (labels, startUtc, index) => {
  const label = labels[index];
  if (typeof label === 'string' && label.trim()) {
    const separatorIndex = label.indexOf(':');
    return separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : label.trim();
  }
  const iso = startUtc[index];
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return String(date.getHours()).padStart(2, '0');
};

const resolveLabelEvery = (bucketCount) => {
  if (bucketCount <= 8) return 1;
  if (bucketCount <= 12) return 2;
  if (bucketCount <= 24) return 4;
  return Math.max(1, Math.round(bucketCount / 6));
};

const resolvePriceSeries = ({ bucketStartUtc, bucketPrices, combinedPrices }) => {
  if (Array.isArray(bucketPrices) && bucketPrices.length === bucketStartUtc.length) {
    return bucketPrices.map((value) => (
      Number.isFinite(value) ? value : null
    ));
  }

  if (!combinedPrices || !Array.isArray(combinedPrices.prices) || bucketStartUtc.length === 0) {
    return bucketStartUtc.map(() => null);
  }

  const priceByStart = new Map();
  combinedPrices.prices.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const startsAt = typeof entry.startsAt === 'string' ? entry.startsAt : '';
    const total = Number(entry.total);
    const timestamp = Date.parse(startsAt);
    if (!Number.isFinite(timestamp) || !Number.isFinite(total)) return;
    priceByStart.set(timestamp, total);
  });

  return bucketStartUtc.map((iso) => {
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return null;
    const total = priceByStart.get(timestamp);
    return Number.isFinite(total) ? total : null;
  });
};

const buildPriceStats = (priceSeries) => {
  const priceValues = priceSeries.filter((value) => Number.isFinite(value));
  return {
    priceValues,
    priceMin: priceValues.length > 0 ? Math.min(...priceValues) : 0,
    priceMax: priceValues.length > 0 ? Math.max(...priceValues) : 1,
  };
};

const resolveActualSeries = (day, bucketCount, isToday) => {
  const actualKwh = normalizeSeriesLength(
    Array.isArray(day?.buckets?.actualKWh)
      ? day.buckets.actualKWh.map((value) => (Number.isFinite(value) ? Math.max(0, value) : null))
      : [],
    bucketCount,
  );

  return {
    actualKwh,
    showActual: Boolean(isToday && actualKwh.some((value) => Number.isFinite(value))),
  };
};

const resolveCurrentState = (day, bucketCount, isToday) => {
  const rawIndex = day?.currentBucketIndex;
  const hasCurrentIndex = Number.isFinite(rawIndex);
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

const buildEmptyPayload = (target, reason) => ({
  state: 'empty',
  target,
  title: WIDGET_TITLE,
  subtitle: EMPTY_STATE_SUBTITLES[reason] ?? EMPTY_STATE_SUBTITLES.no_data,
});

const resolveDayKey = (snapshot, target) => {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (target === 'tomorrow') {
    return typeof snapshot.tomorrowKey === 'string' && snapshot.tomorrowKey.trim()
      ? snapshot.tomorrowKey
      : null;
  }
  return typeof snapshot.todayKey === 'string' && snapshot.todayKey.trim()
    ? snapshot.todayKey
    : null;
};

const resolveDay = (snapshot, target) => {
  const dayKey = resolveDayKey(snapshot, target);
  if (!dayKey || !snapshot || typeof snapshot !== 'object' || !snapshot.days || typeof snapshot.days !== 'object') {
    return { day: null, dayKey };
  }
  return {
    day: snapshot.days[dayKey] ?? null,
    dayKey,
  };
};

const buildPlanPriceWidgetPayload = ({ snapshot, combinedPrices, target }) => {
  const resolvedTarget = resolveWidgetTarget(target);
  const { day, dayKey } = resolveDay(snapshot, resolvedTarget);

  if (!day || !dayKey) {
    return buildEmptyPayload(
      resolvedTarget,
      resolvedTarget === 'tomorrow' ? 'tomorrow_pending' : 'no_data',
    );
  }

  const plannedKwh = Array.isArray(day?.buckets?.plannedKWh)
    ? day.buckets.plannedKWh.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0))
    : [];
  const bucketCount = plannedKwh.length;

  if (bucketCount === 0) {
    return buildEmptyPayload(
      resolvedTarget,
      day?.budget?.enabled === false
        ? 'budget_disabled'
        : (resolvedTarget === 'tomorrow' ? 'tomorrow_pending' : 'no_data'),
    );
  }

  const bucketStartUtc = Array.isArray(day?.buckets?.startUtc) ? day.buckets.startUtc : [];
  const labels = Array.isArray(day?.buckets?.startLocalLabels) ? day.buckets.startLocalLabels : [];
  const bucketLabels = Array.from({ length: bucketCount }, (_, index) => resolveLabel(labels, bucketStartUtc, index));
  const priceSeries = normalizeSeriesLength(
    resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: Array.isArray(day?.buckets?.price) ? day.buckets.price : [],
      combinedPrices,
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

module.exports = {
  buildPlanPriceWidgetPayload,
  resolveWidgetTarget,
  resolvePriceSeries,
  resolveLabel,
  resolveLabelEvery,
};
