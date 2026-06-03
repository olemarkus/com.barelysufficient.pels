import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
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
  // Configured hard cap in kW. When provided alongside the daily-budget
  // snapshot's `plannedUncontrolledKWh`, each bucket gets a
  // `reservedHeadroomKw` forecast (`hardCapKw − plannedUncontrolledKw`) that a
  // fully-reserved smart task can use to promote its committed floor step
  // (Slice 2 of Cause #2 in `TODO.md`). Optional: missing → no forecast → the
  // planner stays on the min-step floor.
  hardCapKw?: number | null;
  // Number of priority-1 fully-reserved smart tasks that could share this
  // bucket's reserved headroom. The producer divides `reservedHeadroomKw` by
  // this count (equal-share allocation) before publishing it to the planner,
  // so two competing tasks each see their fair fraction rather than both
  // promoting their committed floor to the full forecast. The consumer
  // (`horizonPlanner.resolveFloorStep`) reads one flat per-bucket value and
  // stays unaware of sibling tasks — see
  // `feedback_layering_resolution_in_producer`. Defaults to `1` (legacy /
  // single-task behavior). Values `<= 0` or non-finite are treated as `1`.
  //
  // A function form lets the count vary per bucket: a task whose deadline
  // sits inside the horizon stops sharing the headroom on later buckets
  // where it is no longer eligible (see "over-counts in late-horizon
  // buckets" TODO entry). The number form is preserved for legacy callers
  // and tests; the function receives the bucket's UTC start ms.
  concurrentEligibleCount?: number | ((bucketStartMs: number) => number);
}): DeferredObjectivePolicyHorizonResult => {
  const {
    nowMs,
    deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
    exemptFromBudget = false,
    hardCapKw = null,
    concurrentEligibleCount = 1,
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
    buckets: mapPolicyBuckets(sourceBuckets, exemptFromBudget, hardCapKw, concurrentEligibleCount),
    horizonBucketCount: sourceBuckets.length,
    dailyBudgetExhaustedBucketCount: countDailyBudgetExhausted(sourceBuckets),
    reasonCode: null,
  };
};

// Per-bucket spot price keyed by bucket id (the bucket's ISO start string,
// which is also `DeferredObjectivePlannedBucket.sourceBucketId`). Built from
// the SAME `collectSnapshotPriceBuckets` source the policy horizon consumes,
// so a cost estimate computed by multiplying planned kWh by these prices uses
// exactly the price data the planner saw. Returns an empty map when the
// snapshot has no usable price buckets. Used by the plan-preview composition,
// which needs the raw per-bucket price to cost the plan.
export const buildDeferredObjectivePolicyBucketPrices = (
  dailyBudgetSnapshot: DailyBudgetUiPayload | null,
): Map<string, number> => {
  if (!dailyBudgetSnapshot) return new Map();
  const prices = new Map<string, number>();
  for (const bucket of collectSnapshotPriceBuckets(dailyBudgetSnapshot)) {
    prices.set(bucket.id, bucket.price);
  }
  return prices;
};

// One hour on the preview price curve: an EPOCH-hour-aligned UTC start and that
// hour's per-kWh spot price, or `null` when no price is published for the hour.
export type DeferredObjectivePolicyWindowPrice = {
  startMs: number;
  price: number | null;
};

// Epoch-hour floor — the SAME basis `buildHoursFromHorizonPlan` floors scheduled
// hours to (activePlanSchedule.ts). Keeping both on this basis is what lets the
// widget join `priceSeries` against `scheduledHours` by `startsAtMs`; a
// fractional-offset timezone (UTC+5:30/+5:45) starts its local-day buckets at
// :30/:45 past the UTC hour, so emitting the raw bucket start would never match
// the floored scheduled hours and the chart would highlight nothing.
const PRICE_WINDOW_HOUR_MS = 60 * 60 * 1000;
const floorToHourMs = (ms: number): number => Math.floor(ms / PRICE_WINDOW_HOUR_MS) * PRICE_WINDOW_HOUR_MS;

// Hourly spot prices across the preview window `[nowMs, deadlineAtMs)`, as a
// DENSE, ascending, epoch-hour-floored series — the SAME snapshot price buckets
// the policy horizon and cost estimate consume, sliced to the window. Powers the
// create-task preview chart's price curve. Imposes NO horizon-coverage
// requirement (a partial curve is still informative). An interior hour with no
// published price is emitted as a `null`-price slot (so the chart breaks the line
// across the gap and the time axis stays true), NOT dropped — dropping would
// collapse the array indices the chart lays out by and skew the x-axis. Returns
// an empty array when no priced buckets fall in the window.
export const buildDeferredObjectivePolicyWindowPrices = (
  dailyBudgetSnapshot: DailyBudgetUiPayload | null,
  nowMs: number,
  deadlineAtMs: number,
): DeferredObjectivePolicyWindowPrice[] => {
  if (!dailyBudgetSnapshot) return [];
  // Buckets arrive ascending by start (today then tomorrow, each in hour order).
  const priceByHour = new Map<number, number>();
  for (const bucket of collectSnapshotPriceBuckets(dailyBudgetSnapshot)) {
    if (bucket.endMs <= nowMs || bucket.startMs >= deadlineAtMs) continue;
    // Clip the start to `nowMs` for the in-progress bucket — the SAME basis
    // `buildHoursFromHorizonPlan` floors (the planner normalises a straddling
    // bucket to `max(startMs, nowMs)`). Without the clip, in a fractional-offset
    // timezone the current bucket keys to the PREVIOUS epoch hour and the
    // current scheduled hour would never highlight.
    const hour = floorToHourMs(Math.max(bucket.startMs, nowMs));
    // First-write wins: in a fractional-offset zone the clipped in-progress
    // bucket and the next bucket can floor to the SAME epoch hour. Keep the
    // earlier (current) one — the bucket the planner is actually drawing from at
    // `nowMs` — so the hour shows the price being paid now, not the next bucket's.
    if (!priceByHour.has(hour)) priceByHour.set(hour, bucket.price);
  }
  if (priceByHour.size === 0) return [];
  const hours = [...priceByHour.keys()].sort((left, right) => left - right);
  const series: DeferredObjectivePolicyWindowPrice[] = [];
  for (let hour = hours[0]; hour <= hours[hours.length - 1]; hour += PRICE_WINDOW_HOUR_MS) {
    series.push({ startMs: hour, price: priceByHour.get(hour) ?? null });
  }
  return series;
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
    const perBucketBudgetKWh = resolvePerBucketBudget(allowedCumKWh, index);
    return [{
      id: startIso,
      startMs,
      endMs,
      price,
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
  hardCapKw: number | null,
  concurrentEligibleCount: number | ((bucketStartMs: number) => number),
): DeferredObjectiveHorizonBucket[] => {
  // Resolve the eligible count per bucket so a task that drops out of
  // eligibility mid-horizon (its deadline passes) stops dividing the
  // reserved headroom on later buckets. Number callers collapse to a
  // constant share regardless of bucket start.
  const shareForBucket = (bucketStartMs: number): number => (
    typeof concurrentEligibleCount === 'function'
      ? resolveEligibleShare(concurrentEligibleCount(bucketStartMs))
      : resolveEligibleShare(concurrentEligibleCount)
  );
  return buckets.map((bucket) => {
    const cap = resolveMaxUsefulEnergyKWh(bucket, exemptFromBudget);
    const reservedHeadroomKw = resolveReservedHeadroomKw(bucket, hardCapKw, shareForBucket(bucket.startMs));
    return {
      id: bucket.id,
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      // Raw price is the sole price signal. The allocator fills hours
      // cheapest-first by comparing these relatively (currency-invariant band)
      // and the live deferral compares them by ratio.
      // `collectSnapshotPriceBuckets` already guarantees a finite price on every
      // source bucket.
      price: bucket.price,
      ...(cap !== null ? { maxUsefulEnergyKWh: cap } : {}),
      ...(reservedHeadroomKw !== null ? { reservedHeadroomKw } : {}),
    };
  });
};

// Treat non-positive / non-finite eligible counts as `1` (single task) so a
// caller mis-passing zero never produces `NaN`/`Infinity` headroom. The
// single-task value preserves legacy behaviour exactly. Equal-share allocation
// is the v1 rule — see the `concurrentEligibleCount` doc in
// `buildDeferredObjectivePolicyHorizon` and the TODO entry that motivated this.
const resolveEligibleShare = (concurrentEligibleCount: number): number => (
  Number.isFinite(concurrentEligibleCount) && concurrentEligibleCount >= 1
    ? 1 / concurrentEligibleCount
    : 1
);

// Reserved physical headroom for a fully-reserved smart task in this bucket:
// `(hardCapKw − planned uncontrolled load) ÷ concurrentEligibleCount`. The
// per-bucket budget (hardCap minus the non-PELS-managed forecast) is divided
// equally across the eligible top-priority fully-reserved tasks so two such
// tasks don't both promote their committed floor to the *full* forecast and
// double-book the reserved slot in diagnostic verdicts. Equal-share allocation
// is the simplest fair v1 rule: it is symmetric across tasks (no deadline tie-
// breaking subtlety), stable across plan cycles unless the eligible-set count
// changes, and conservative — over-counting eligibility (e.g. counting a task
// that has nothing to do this cycle) just keeps everyone closer to the
// min-step floor, which is the safer direction. Clamped at 0. Returns null
// when either physical input is missing so the planner falls back to the
// min-step floor.
const resolveReservedHeadroomKw = (
  bucket: PolicyBucketSource,
  hardCapKw: number | null,
  sharePerTask: number,
): number | null => {
  if (hardCapKw === null || !Number.isFinite(hardCapKw) || hardCapKw <= 0) return null;
  if (bucket.backgroundKWh === null) return null;
  const durationHours = (bucket.endMs - bucket.startMs) / (60 * 60 * 1000);
  if (durationHours <= 0) return null;
  const uncontrolledKw = bucket.backgroundKWh / durationHours;
  return Math.max(0, hardCapKw - uncontrolledKw) * sharePerTask;
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
