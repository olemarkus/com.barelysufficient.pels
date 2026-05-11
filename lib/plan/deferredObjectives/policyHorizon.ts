import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../dailyBudget/dailyBudgetTypes';
import type { DeferredObjectiveHorizonBucket } from './types';

export type DeferredObjectivePolicyHorizonUnavailableReason =
  | 'objective_price_feature_disabled'
  | 'objective_missing_price_horizon';

export type DeferredObjectivePolicyHorizonResult =
  | {
    buckets: DeferredObjectiveHorizonBucket[];
    horizonBucketCount: number;
    reasonCode: null;
  }
  | {
    buckets: [];
    horizonBucketCount: 0;
    reasonCode: DeferredObjectivePolicyHorizonUnavailableReason;
  };

// Per-bucket capacity assumes this objective claims first call on the bucket's
// budget headroom (per-bucket allowed kWh minus the daily-budget's forecasted
// background load). True for priority-1 devices; lower-priority devices won't
// actually get that headroom, but we apply the same math everywhere for now.
// Revisit once lower-priority shedding lands at the daily-budget layer.
type PolicyBucketSource = {
  id: string;
  startMs: number;
  endMs: number;
  price: number;
  priceFactor: number | null;
  backgroundKWh: number | null;
  perBucketBudgetKWh: number | null;
};

export const buildDeferredObjectivePolicyHorizon = (params: {
  nowMs: number;
  deadlineAtMs: number;
  priceOptimizationEnabled: boolean;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
}): DeferredObjectivePolicyHorizonResult => {
  const {
    nowMs,
    deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
  } = params;
  if (!priceOptimizationEnabled) {
    return unavailable('objective_price_feature_disabled');
  }
  const sourceBuckets = collectPriceBuckets({
    nowMs,
    deadlineAtMs,
    dailyBudgetSnapshot,
  });
  if (!sourceBuckets || sourceBuckets.length === 0) {
    return unavailable('objective_missing_price_horizon');
  }
  return {
    buckets: mapPolicyBuckets(sourceBuckets),
    horizonBucketCount: sourceBuckets.length,
    reasonCode: null,
  };
};

const unavailable = (
  reasonCode: DeferredObjectivePolicyHorizonUnavailableReason,
): DeferredObjectivePolicyHorizonResult => ({
  buckets: [],
  horizonBucketCount: 0,
  reasonCode,
});

const collectPriceBuckets = (params: {
  nowMs: number;
  deadlineAtMs: number;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
}): PolicyBucketSource[] | null => {
  const {
    nowMs,
    deadlineAtMs,
    dailyBudgetSnapshot,
  } = params;
  if (!dailyBudgetSnapshot) return null;
  const allBuckets = collectSnapshotPriceBuckets(dailyBudgetSnapshot)
    .filter((bucket) => bucket.endMs > nowMs && bucket.startMs < deadlineAtMs)
    .sort((left, right) => left.startMs - right.startMs);
  if (allBuckets.length === 0) return null;
  if (!coversHorizon({ buckets: allBuckets, nowMs, deadlineAtMs })) return null;
  return allBuckets;
};

const collectSnapshotPriceBuckets = (snapshot: DailyBudgetUiPayload): PolicyBucketSource[] => (
  [snapshot.todayKey, snapshot.tomorrowKey]
    .flatMap((dateKey) => {
      if (!dateKey) return [];
      const day = snapshot.days[dateKey];
      return day ? collectDayPriceBuckets(day) : [];
    })
);

const collectDayPriceBuckets = (day: DailyBudgetDayPayload): PolicyBucketSource[] => {
  const starts = day.buckets.startUtc;
  const prices = day.buckets.price;
  if (!Array.isArray(starts) || !Array.isArray(prices)) return [];
  const allowedCumKWh = day.buckets.allowedCumKWh;
  const plannedUncontrolledKWh = day.buckets.plannedUncontrolledKWh;
  return starts.flatMap((startIso, index) => {
    const startMs = new Date(startIso).getTime();
    const endMs = resolveBucketEndMs(starts, index);
    const price = prices[index];
    if (
      !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || endMs <= startMs
      || typeof price !== 'number'
      || !Number.isFinite(price)
    ) {
      return [];
    }
    const priceFactor = day.buckets.priceFactor?.[index] ?? null;
    return [{
      id: startIso,
      startMs,
      endMs,
      price,
      priceFactor: typeof priceFactor === 'number' && Number.isFinite(priceFactor) ? priceFactor : null,
      backgroundKWh: finiteOrNull(plannedUncontrolledKWh?.[index]),
      perBucketBudgetKWh: resolvePerBucketBudget(allowedCumKWh, index),
    }];
  });
};

const finiteOrNull = (value: number | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const resolvePerBucketBudget = (
  allowedCumKWh: number[] | undefined,
  index: number,
): number | null => {
  if (!Array.isArray(allowedCumKWh)) return null;
  const current = allowedCumKWh[index];
  if (typeof current !== 'number' || !Number.isFinite(current)) return null;
  const previous = index > 0 ? allowedCumKWh[index - 1] : 0;
  if (typeof previous !== 'number' || !Number.isFinite(previous)) return null;
  return Math.max(0, current - previous);
};

const resolveBucketEndMs = (starts: string[], index: number): number => {
  const nextStart = starts[index + 1];
  if (typeof nextStart === 'string') {
    return new Date(nextStart).getTime();
  }
  return new Date(starts[index]).getTime() + 60 * 60 * 1000;
};

const coversHorizon = (params: {
  buckets: PolicyBucketSource[];
  nowMs: number;
  deadlineAtMs: number;
}): boolean => {
  const { buckets, nowMs, deadlineAtMs } = params;
  let coveredUntilMs = nowMs;
  for (const bucket of buckets) {
    if (bucket.startMs > coveredUntilMs) return false;
    if (bucket.endMs > coveredUntilMs) coveredUntilMs = bucket.endMs;
    if (coveredUntilMs >= deadlineAtMs) return true;
  }
  return false;
};

const mapPolicyBuckets = (buckets: PolicyBucketSource[]): DeferredObjectiveHorizonBucket[] => {
  const ranked = rankPrices(buckets.map((bucket) => bucket.price));
  return buckets.map((bucket, index) => {
    const priceFactor = bucket.priceFactor;
    const rankedScore = ranked[index] ?? 1;
    const cap = resolveMaxUsefulEnergyKWh(bucket);
    return {
      id: bucket.id,
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      preference: resolveBucketPreference(priceFactor, rankedScore),
      policyScore: priceFactor ?? rankedScore,
      ...(cap !== null ? { maxUsefulEnergyKWh: cap } : {}),
    };
  });
};

const resolveMaxUsefulEnergyKWh = (bucket: PolicyBucketSource): number | null => {
  if (bucket.perBucketBudgetKWh === null || bucket.backgroundKWh === null) return null;
  return Math.max(0, bucket.perBucketBudgetKWh - bucket.backgroundKWh);
};

const rankPrices = (prices: number[]): number[] => {
  if (prices.length === 0) return [];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spread = max - min;
  if (spread <= 0) return prices.map(() => 1);
  return prices.map((price) => 0.8 + ((max - price) / spread) * 0.4);
};

const resolveBucketPreference = (
  priceFactor: number | null,
  rankedScore: number,
): DeferredObjectiveHorizonBucket['preference'] => {
  const score = priceFactor ?? rankedScore;
  if (score >= 1.1) return 'preferred';
  if (score <= 0.9) return 'avoid';
  return 'neutral';
};
