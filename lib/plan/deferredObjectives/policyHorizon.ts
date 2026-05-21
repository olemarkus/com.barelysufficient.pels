import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../dailyBudget/dailyBudgetTypes';
import type { DeferredObjectiveHorizonBucket } from './types';

export type DeferredObjectivePolicyHorizonUnavailableReason =
  | 'objective_price_feature_disabled'
  | 'objective_missing_price_horizon';

export type DeferredObjectivePolicyHorizonResult =
  | {
    buckets: DeferredObjectiveHorizonBucket[];
    horizonBucketCount: number;
    // Number of buckets in the horizon whose per-bucket headroom collapsed to
    // zero because the daily budget cap had already been reached at the start
    // of the bucket. Surfaces as a diagnostic field so the UI can explain a
    // `cannot_meet` outcome that would otherwise look like a device or
    // schedule problem.
    dailyBudgetExhaustedBucketCount: number;
    reasonCode: null;
  }
  | {
    buckets: [];
    horizonBucketCount: 0;
    dailyBudgetExhaustedBucketCount: 0;
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
  // True when the per-bucket budget collapsed to 0 specifically because
  // `buildAllowedCumKWh` plateaued at the daily budget cap (i.e. the cumulative
  // had already hit `dailyBudgetKWh` before this bucket). Distinguishes the
  // budget-cap cause from the legacy "no allowedCumKWh data" path.
  dailyBudgetExhausted: boolean;
};

export const buildDeferredObjectivePolicyHorizon = (params: {
  nowMs: number;
  deadlineAtMs: number;
  priceOptimizationEnabled: boolean;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  // When true (an at-risk smart task that was granted the "exempt from budget"
  // rescue permission), the per-bucket daily-budget cap is lifted so the planner
  // may schedule into otherwise budget-exhausted buckets. This relaxes only the
  // soft daily-budget throttle; physical capacity stays enforced downstream at
  // admission and the capacity guard.
  exemptFromBudget?: boolean;
}): DeferredObjectivePolicyHorizonResult => {
  const {
    nowMs,
    deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
    exemptFromBudget = false,
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
    buckets: mapPolicyBuckets(sourceBuckets, exemptFromBudget),
    horizonBucketCount: sourceBuckets.length,
    dailyBudgetExhaustedBucketCount: countDailyBudgetExhausted(sourceBuckets),
    reasonCode: null,
  };
};

const countDailyBudgetExhausted = (buckets: PolicyBucketSource[]): number => (
  buckets.reduce((count, bucket) => count + (bucket.dailyBudgetExhausted ? 1 : 0), 0)
);

const unavailable = (
  reasonCode: DeferredObjectivePolicyHorizonUnavailableReason,
): DeferredObjectivePolicyHorizonResult => ({
  buckets: [],
  horizonBucketCount: 0,
  dailyBudgetExhaustedBucketCount: 0,
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
  const dailyBudgetKWh = day.budget.enabled ? day.budget.dailyBudgetKWh : null;
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
    const perBucketBudgetKWh = resolvePerBucketBudget(allowedCumKWh, index);
    return [{
      id: startIso,
      startMs,
      endMs,
      price,
      priceFactor: typeof priceFactor === 'number' && Number.isFinite(priceFactor) ? priceFactor : null,
      backgroundKWh: finiteOrNull(plannedUncontrolledKWh?.[index]),
      perBucketBudgetKWh,
      dailyBudgetExhausted: isDailyBudgetExhausted({
        allowedCumKWh,
        index,
        perBucketBudgetKWh,
        dailyBudgetKWh,
      }),
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

// True when the per-bucket budget is 0 specifically because the cumulative
// allowed already reached `dailyBudgetKWh` before this bucket. `buildAllowedCumKWh`
// clamps `total` at the cap, so plateau buckets always share the same value as
// the previous one. We require both the plateau and a meeting/exceeding-cap
// reading so the legacy "no budget data" path (perBucketBudgetKWh === null)
// stays distinguishable.
const DAILY_BUDGET_CAP_EPSILON_KWH = 1e-6;
const isDailyBudgetExhausted = (params: {
  allowedCumKWh: number[] | undefined;
  index: number;
  perBucketBudgetKWh: number | null;
  dailyBudgetKWh: number | null;
}): boolean => {
  const { allowedCumKWh, index, perBucketBudgetKWh, dailyBudgetKWh } = params;
  // `perBucketBudgetKWh` is the difference of two cumulative floats; the
  // `Math.max(0, ...)` in `resolvePerBucketBudget` clamps negative noise but
  // leaves tiny positive residues. Treat anything within the daily-budget
  // epsilon as a plateau so precision drift doesn't hide an exhausted bucket.
  if (perBucketBudgetKWh === null || perBucketBudgetKWh > DAILY_BUDGET_CAP_EPSILON_KWH) return false;
  if (dailyBudgetKWh === null || dailyBudgetKWh <= 0) return false;
  if (!Array.isArray(allowedCumKWh)) return false;
  const current = allowedCumKWh[index];
  if (typeof current !== 'number' || !Number.isFinite(current)) return false;
  return current >= dailyBudgetKWh - DAILY_BUDGET_CAP_EPSILON_KWH;
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

const mapPolicyBuckets = (
  buckets: PolicyBucketSource[],
  exemptFromBudget: boolean,
): DeferredObjectiveHorizonBucket[] => {
  const ranked = rankPrices(buckets.map((bucket) => bucket.price));
  return buckets.map((bucket, index) => {
    const priceFactor = bucket.priceFactor;
    const rankedScore = ranked[index] ?? 1;
    const cap = resolveMaxUsefulEnergyKWh(bucket, exemptFromBudget);
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

const resolveMaxUsefulEnergyKWh = (
  bucket: PolicyBucketSource,
  exemptFromBudget: boolean,
): number | null => {
  // "Exempt from budget" lifts the per-bucket daily-budget cap entirely; the
  // bucket falls back to the device's step capacity in allocation, and physical
  // limits are enforced downstream (admission / capacity guard).
  if (exemptFromBudget) return null;
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
