import type { CombinedPriceData } from '../../../lib/dailyBudget/dailyBudgetPrices';
import type {
  DailyBudgetDayPayload,
  DailyBudgetUiPayload,
  DailyBudgetUiRead,
} from '../../../lib/dailyBudget/dailyBudgetTypes';
import {
  PLAN_PRICE_WIDGET_EMPTY,
  PLAN_PRICE_WIDGET_TITLE,
  resolvePlanPriceCostDisplay,
  type PlanPriceSummaryTone,
} from '../../../packages/shared-domain/src/planPriceWidgetCopy';
import {
  planningPriceDivergesFromImport,
} from '../../../packages/shared-domain/src/price/planningPrice';
import type {
  PlanPriceWidgetEmptyPayload,
  PlanPriceWidgetPayload,
  WidgetTarget,
} from './planPriceWidgetTypes';

const WIDGET_TITLE = PLAN_PRICE_WIDGET_TITLE;

const EMPTY_STATE_SUBTITLES = {
  budget_disabled: PLAN_PRICE_WIDGET_EMPTY.budgetDisabled,
  no_data: PLAN_PRICE_WIDGET_EMPTY.noData,
  tomorrow_pending: PLAN_PRICE_WIDGET_EMPTY.tomorrowPending,
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

// Index the per-hour PLANNING price (`budgetPrice`) from the combined-price
// rows, keyed by hour-start epoch ms. Only finite `budgetPrice` values land in
// the map — an absent/junk value leaves the hour on the import price, so a
// non-prosumer's overlay is a no-op (byte-identical).
const buildBudgetPriceByStart = (combinedPrices: CombinedPriceData | null): Map<number, number> => {
  const byStart = new Map<number, number>();
  // `combinedPrices` is the raw `combined_prices` settings read (untrusted): a
  // malformed persisted value could carry a non-array `prices`, so array-guard
  // before iterating rather than letting `for...of` throw. `Array.isArray` /
  // the local `isFiniteNumber` — no `lib/**` import (widget can't reach it).
  if (!combinedPrices || !Array.isArray(combinedPrices.prices)) return byStart;
  for (const entry of combinedPrices.prices) {
    if (!entry || typeof entry !== 'object') continue;
    const timestamp = Date.parse(entry.startsAt);
    if (Number.isFinite(timestamp) && isFiniteNumber(entry.budgetPrice)) {
      byStart.set(timestamp, entry.budgetPrice);
    }
  }
  return byStart;
};

export const resolvePriceSeries = (params: {
  bucketStartUtc: ReadonlyArray<string>;
  bucketPrices: ReadonlyArray<number | null | undefined>;
  combinedPrices: CombinedPriceData | null;
  // Price minor→major divisor (øre→kr ÷100; flow/homey ÷1). Gates the planning
  // overlay on the DISPLAY resolution so a sub-cent surplus never flips a curve
  // point without a visible change. Defaults to 1 (no scaling) for legacy
  // callers/tests that don't pass it.
  divisor?: number;
}): Array<number | null> => {
  const { bucketStartUtc, bucketPrices, combinedPrices, divisor = 1 } = params;

  // Base import-price (`total`) series — from the bucket prices when they
  // align, else joined from the combined rows by hour start.
  let base: Array<number | null>;
  if (bucketPrices.length === bucketStartUtc.length) {
    base = bucketPrices.map((value) => (isFiniteNumber(value) ? value : null));
    // Array-guard the untrusted `combined_prices.prices` before the fallback
    // `for...of` — a non-array (e.g. `{}`) is not iterable and would throw.
  } else if (!combinedPrices || !Array.isArray(combinedPrices.prices) || bucketStartUtc.length === 0) {
    return bucketStartUtc.map(() => null);
  } else {
    const totalByStart = new Map<number, number>();
    for (const entry of combinedPrices.prices) {
      if (!entry || typeof entry !== 'object') continue;
      const timestamp = Date.parse(entry.startsAt);
      if (!Number.isFinite(timestamp) || !isFiniteNumber(entry.total)) continue;
      totalByStart.set(timestamp, entry.total);
    }
    base = bucketStartUtc.map((iso) => {
      const timestamp = Date.parse(iso);
      if (!Number.isFinite(timestamp)) return null;
      return totalByStart.get(timestamp) ?? null;
    });
  }

  // Overlay the PLANNING price (`budgetPrice ?? total`) so the widget's price
  // curve AND projected cost estimate follow the same signal the scheduler
  // plans against — a prosumer's flexible load shifts toward self-consuming
  // solar. Only replace an hour whose planning price actually diverges from
  // its import price, so a non-prosumer (or a no-surplus hour) is byte-
  // identical. Never used for a bill; the widget's "Projected …" framing is an
  // estimate, not the delivered cost.
  const budgetPriceByStart = buildBudgetPriceByStart(combinedPrices);
  if (budgetPriceByStart.size === 0) return base;
  return base.map((total, index) => {
    if (!isFiniteNumber(total)) return total;
    const timestamp = Date.parse(bucketStartUtc[index] ?? '');
    const budgetPrice = Number.isFinite(timestamp) ? budgetPriceByStart.get(timestamp) : undefined;
    return planningPriceDivergesFromImport(budgetPrice, total, divisor) ? (budgetPrice as number) : total;
  });
};

// The per-bucket kWh basis for projecting the day total: actual usage already
// incurred for elapsed buckets, planned usage for the remainder. Built only for
// today (where actuals exist); tomorrow keeps the pure planned series.
//
//   index <  currentIndex → elapsed: use actual (planned only if actual absent)
//   index == currentIndex → in progress: max(actual, planned) so a bucket that
//                            has already overrun its allocation isn't understated
//   index >  currentIndex → future: use planned
//
// This guarantees the projected total reflects what the user has actually spent
// to date, so an overrun can't be hidden behind shrinking future allocations.
const resolveProjectionKwh = (params: {
  plannedKwh: ReadonlyArray<number>;
  actualKwh: ReadonlyArray<number | null>;
  currentIndex: number;
  useActual: boolean;
}): number[] => {
  if (!params.useActual) return params.plannedKwh.map((value) => value);

  return params.plannedKwh.map((planned, index) => {
    const actual = params.actualKwh[index];
    if (index < params.currentIndex) {
      return isFiniteNumber(actual) ? actual : planned;
    }
    if (index === params.currentIndex && isFiniteNumber(actual)) {
      return Math.max(actual, planned);
    }
    return planned;
  });
};

// Project the day's total cost as Σ (price × projectedKwh) over every bucket,
// scaled into the display currency by the resolved cost divisor. Uses the same
// actual-to-date + planned-remainder basis as the kWh projection. Returns null
// — so the renderer suppresses the cost half honestly rather than showing a
// misleading total — when: no usable cost unit exists, no energy-bearing bucket
// is priced, OR any energy-bearing bucket lacks a price (a partial price horizon
// can't be honestly presented as a full-day projected cost; the kWh projection
// still stands since it doesn't depend on prices).
const computeProjectedCost = (params: {
  projectionKwh: ReadonlyArray<number>;
  priceSeries: ReadonlyArray<number | null>;
  costUnit: string;
  costDivisor: number;
}): number | null => {
  if (params.costUnit.trim().length === 0) return null;

  let rawTotal = 0;
  let priced = false;
  let missingPrice = false;
  params.projectionKwh.forEach((kwh, index) => {
    if (!isFiniteNumber(kwh) || kwh <= 0) return; // no energy ⇒ no cost contribution
    const price = params.priceSeries[index];
    if (!isFiniteNumber(price)) {
      missingPrice = true; // a contributing bucket has no price
      return;
    }
    rawTotal += price * kwh;
    priced = true;
  });

  if (!priced || missingPrice) return null;
  return rawTotal / Math.max(1, params.costDivisor);
};

const resolveSummaryTone = (
  projectedKwh: number,
  budgetKwh: number,
  isToday: boolean,
): PlanPriceSummaryTone | null => {
  // Tomorrow has no live budget comparison to report against yet.
  if (!isToday) return null;
  if (!isFiniteNumber(budgetKwh) || budgetKwh <= 0) return null;
  return projectedKwh > budgetKwh ? 'over' : 'on_track';
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
  payload: DailyBudgetUiPayload,
  target: WidgetTarget,
): string | null => {
  const key = target === 'tomorrow' ? payload.tomorrowKey : payload.todayKey;
  return typeof key === 'string' && key.trim() ? key : null;
};

const resolveDay = (snapshot: DailyBudgetUiRead, target: WidgetTarget) => {
  if (snapshot.kind !== 'budget') return { day: null, dayKey: null };
  const { payload } = snapshot;
  const dayKey = resolveDayKey(payload, target);
  if (!dayKey) return { day: null, dayKey };

  return {
    day: payload.days[dayKey] ?? null,
    dayKey,
  };
};

export const buildPlanPriceWidgetPayload = (params: {
  snapshot: DailyBudgetUiRead;
  combinedPrices: CombinedPriceData | null;
  target: unknown;
  // Persisted price scheme (`norway` | `flow` | `homey`) from the price store.
  // Drives øre→kr scaling and the axis-unit label; optional because legacy /
  // test payloads may omit it (defaults to the Norwegian Nordpool scheme).
  priceScheme?: string;
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
  // Resolve the cost display first: its divisor gates the planning-price overlay
  // in `resolvePriceSeries` on the display resolution (so a sub-cent surplus
  // never flips a curve point without a visible change).
  const costDisplay = resolvePlanPriceCostDisplay({
    priceScheme: params.priceScheme,
    priceUnit: params.combinedPrices?.priceUnit,
  });
  const priceSeries = normalizeSeriesLength(
    resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: Array.isArray(day.buckets.price) ? day.buckets.price : [],
      combinedPrices: params.combinedPrices,
      divisor: costDisplay.costDivisor,
    }),
    bucketCount,
  );
  const priceStats = buildPriceStats(priceSeries);
  const isToday = resolvedTarget === 'today';
  const { actualKwh, showActual } = resolveActualSeries(day, bucketCount, isToday);
  const { currentIndex, showNow } = resolveCurrentState(day, bucketCount, isToday);
  // Base the projection on actual usage to date plus planned for the remainder,
  // so an overrun already incurred is reflected (and can't read "On track").
  // Only fold in actuals when we have a trustworthy elapsed boundary
  // (`showNow` ⇒ a valid in-range currentIndex). Without it the future buckets
  // can't be told from elapsed ones, so we keep the pure planned projection.
  const projectionKwh = resolveProjectionKwh({
    plannedKwh,
    actualKwh,
    currentIndex,
    useActual: showActual && showNow,
  });
  const projectedKwh = projectionKwh.reduce((sum, value) => sum + value, 0);
  const projectedCost = computeProjectedCost({
    projectionKwh,
    priceSeries,
    costUnit: costDisplay.costUnit,
    costDivisor: costDisplay.costDivisor,
  });
  const summaryTone = resolveSummaryTone(projectedKwh, day.budget.dailyBudgetKWh, isToday);

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
    priceAxisUnit: costDisplay.priceAxisUnit,
    projectedKwh,
    projectedCost,
    costUnit: costDisplay.costUnit,
    summaryTone,
  };
};

export { WIDGET_TITLE };
