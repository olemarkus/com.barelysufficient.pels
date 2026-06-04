import type {
  DeferredObjectiveCommittedHour,
  DeferredObjectiveHorizonBucket,
  DeferredObjectivePlannedBucket,
  DeferredObjectiveStep,
} from './types';

const HOUR_MS = 60 * 60 * 1000;

// Relative price margin (~5%) below which two hours are treated as equally
// priced for fill ordering. RELATIVE (ratio-based), not a fixed offset, so it is
// invariant to the price currency — the price series carries no unit at this
// layer. The same constant gates the mid-execution deferral
// (`horizonPlanner.resolvePriceDeferralEligible` via `isMeaningfullyCheaper`):
// both express "a later hour must be more than ~5% cheaper to be worth shifting
// load to". Below the margin, the earlier hour wins (heat early; don't churn
// load between near-equal hours).
export const PRICE_BAND_MARGIN = 0.05;

// Width of one relative price band on the log grid `priceFillBand` quantises
// positive prices onto. Quantisation is what makes the fill order a transitive
// total order (a pairwise within-margin comparator is NOT transitive on a price
// ramp: a≈b and b≈c does not imply a≈c). The trade-off is that the grid only
// APPROXIMATES the margin at its edges: two prices within `PRICE_BAND_MARGIN` can
// fall in adjacent bands (treated as a real difference) and two prices up to
// ~2× the margin apart can share a band (treated as a tie). So the build-time
// fill order (this grid) and the live deferral (the exact `isMeaningfullyCheaper`
// ratio) can disagree near a band edge for spreads close to the margin. That is
// an accepted approximation, not a bug — both still express "~5% relative".
const PRICE_BAND_LOG_BASE = Math.log(1 + PRICE_BAND_MARGIN);

// The minimum positive price across the buckets being ordered. The band grid is
// anchored here so band membership depends only on PRICE RATIOS (`price / min`),
// never on the absolute magnitude — i.e. the same price curve produces the same
// fill order whether the feed is in øre, eurocents, or €/kWh. (A fixed grid
// anchored at `1` would, e.g., tie `100` vs `96` but split `1.00` vs `0.96` for
// the same ~4% spread — the currency-dependence this avoids.) `null` when no
// bucket carries a positive price, in which case there are no tier-1 buckets to
// rank against each other.
const resolvePriceAnchor = (buckets: readonly { price: number | null }[]): number | null => {
  let min: number | null = null;
  for (const bucket of buckets) {
    const price = bucket.price;
    if (typeof price === 'number' && Number.isFinite(price) && price > 0 && (min === null || price < min)) {
      min = price;
    }
  }
  return min;
};

// True when `candidatePrice` is cheaper than `referencePrice` by MORE than the
// relative margin (a pure ratio, so unit-invariant). Used by the live deferral
// to decide a later hour is worth shifting load into. A non-finite or
// non-positive reference makes the ratio meaningless (you cannot be "5% cheaper
// than free/negative"), so it returns false — run now rather than defer on a
// meaningless comparison. A non-finite candidate is non-comparable → false.
export const isMeaningfullyCheaper = (
  candidatePrice: number | null,
  referencePrice: number | null,
): boolean => {
  if (typeof referencePrice !== 'number' || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return false;
  }
  if (typeof candidatePrice !== 'number' || !Number.isFinite(candidatePrice)) return false;
  return candidatePrice <= referencePrice * (1 - PRICE_BAND_MARGIN);
};

// Currency-relative fill-ordering key. Cheaper hours sort first. Returned as a
// `(tier, key)` pair compared lexicographically — a single total order, so the
// induced sort is transitive (a pairwise within-margin comparator would NOT be:
// a≈b and b≈c does not imply a≈c on a price ramp).
//
//   tier 0 — non-positive price (free / paid-to-consume): always cheaper than
//            any priced hour. `key` is the raw price so a deeper-negative hour
//            still sorts ahead of a shallow one (genuinely cheaper).
//   tier 1 — positive price: `key` is `price / anchor` quantised onto a log grid
//            of relative width `(1 + PRICE_BAND_MARGIN)`, where `anchor` is the
//            set's min positive price. Banding on the RATIO makes it
//            currency-invariant (see `resolvePriceAnchor`); two hours within ~5%
//            of each other land in the same band → they tie on price and the time
//            tiebreak (earlier first) decides.
//   tier 2 — missing/non-finite price: sorts last (fill only as a last resort).
const priceFillBand = (
  price: number | null,
  anchor: number | null,
): { tier: number; key: number } => {
  if (typeof price !== 'number' || !Number.isFinite(price)) return { tier: 2, key: 0 };
  if (price <= 0) return { tier: 0, key: price };
  // `anchor` (set min positive price) is `null` only when there are no positive
  // prices — then this is the sole tier-1 bucket and the key is irrelevant.
  const ratio = anchor === null ? 1 : price / anchor;
  return { tier: 1, key: Math.round(Math.log(ratio) / PRICE_BAND_LOG_BASE) };
};

type NormalizedBucket = Omit<DeferredObjectivePlannedBucket,
| 'plannedUsefulEnergyKWh'
| 'usefulEnergyCapacityKWh'
> & {
  usefulEnergyCapKWh: number;
  reservedHeadroomKw: number | undefined;
};

// Per-bucket step resolver. Each bucket may commit at a different step when
// the objective is fully-reserved and the producer's per-bucket
// `reservedHeadroomKw` forecast varies across the horizon — generous-headroom
// hours promote to a higher step, tight-headroom hours stay lower. For
// non-fully-reserved objectives and single-step devices the resolver returns
// the same `activeSteps[0]` for every bucket. Probes (climbed-band /
// budget-bound feasibility) supply a uniform `() => climbStep` instead.
//
// Signature accepts the minimal structural shape needed — `reservedHeadroomKw`
// alone — so callers can be the planner (`NormalizedBucket`) or test fixtures
// without importing the full normalized type.
export type StepForBucket = (
  bucket: { reservedHeadroomKw?: number | undefined },
) => DeferredObjectiveStep;

type BucketSegment = {
  id: string;
  sourceBucketId: string;
  startMs: number;
  endMs: number;
  durationHours: number;
  price: number | null;
  reserve: boolean;
  current: boolean;
  usefulEnergyCapKWh: number;
  // Per-bucket physical headroom forecast (hard-cap minus uncontrolled
  // background, divided across concurrent eligible tasks). Caps the
  // per-hour kWh the allocator can commit so a hour with low forecast
  // headroom can't over-promise even when step capacity has more to give.
  // `undefined` when the producer (`policyHorizon.ts`) could not compute a
  // forecast — typically `hardCapKw === null` or `backgroundKWh === null`;
  // in that case the per-hour cap falls back to step capacity ∧
  // daily-budget only.
  reservedHeadroomKw: number | undefined;
};

export type BucketAllocationResult = {
  plannedBuckets: DeferredObjectivePlannedBucket[];
  plannedUsefulEnergyKWh: number;
  unplannedUsefulEnergyKWh: number;
  usesDeadlineReserve: boolean;
};

export const normalizeHorizonBuckets = (params: {
  nowMs: number;
  deadlineAtMs: number;
  deadlineMarginMs: number;
  buckets: DeferredObjectiveHorizonBucket[];
}): NormalizedBucket[] => {
  const {
    nowMs,
    deadlineAtMs,
    deadlineMarginMs,
    buckets,
  } = params;
  const planningEndMs = Math.max(nowMs, deadlineAtMs - deadlineMarginMs);
  const normalized: NormalizedBucket[] = [];

  for (const bucket of buckets) {
    appendNormalizedBucketSegments({
      bucket,
      nowMs,
      deadlineAtMs,
      planningEndMs,
      normalized,
    });
  }

  return normalized.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
};

export const allocateEnergyToBuckets = (params: {
  buckets: NormalizedBucket[];
  stepForBucket: StepForBucket;
  energyNeededKWh: number;
  epsilonKWh: number;
}): BucketAllocationResult => {
  const {
    buckets,
    stepForBucket,
    energyNeededKWh,
    epsilonKWh,
  } = params;
  const plannedByBucketId = new Map<string, number>();
  let remainingKWh = Math.max(0, energyNeededKWh);
  let plannedUsefulEnergyKWh = 0;
  let usesDeadlineReserve = false;
  const allocationOrder = sortBucketsForAllocation(buckets);

  for (const bucket of allocationOrder) {
    if (remainingKWh <= epsilonKWh) break;
    const usefulEnergyCapacityKWh = resolveBucketStepCapacityKWh(bucket, stepForBucket(bucket));
    const plannedKWh = Math.min(remainingKWh, usefulEnergyCapacityKWh);
    if (plannedKWh <= epsilonKWh) continue;
    plannedByBucketId.set(bucket.id, plannedKWh);
    plannedUsefulEnergyKWh += plannedKWh;
    remainingKWh -= plannedKWh;
    usesDeadlineReserve = usesDeadlineReserve || bucket.reserve;
  }

  return {
    plannedBuckets: buildPlannedBuckets({ buckets, stepForBucket, plannedByBucketId }),
    plannedUsefulEnergyKWh,
    unplannedUsefulEnergyKWh: Math.max(0, remainingKWh),
    usesDeadlineReserve,
  };
};

// Two-phase committed allocator. The committed hour SET identifies which
// hours phase-1 may fill (vs phase-2's spill into uncommitted future hours).
// The committed hour KWH VALUE is a contract FLOOR preserved by
// `mergeHoursPreservingCommitment` (`Math.max` on overlap) — it is NOT a
// per-hour ceiling here. The per-hour ceiling is the bucket's step capacity
// (`step.usefulPowerKw × durationHours`).
//
// Treating committed kWh as a floor rather than a ceiling is what gives the
// allocator hysteresis against slow energy-need drift: a primary bucket
// committed at 0.71 kWh on rev 1 can absorb growth up to its step capacity
// (e.g. 1.25 kWh at floor step `low`, 2.75 kWh at promoted `max`) on later
// cycles WITHOUT spilling slivers into new hours. The recorder's
// `sameHourSchedule` diff gate suppresses revision writes when the hour-set
// is unchanged, so this drift absorption is also quiet end-to-end.
//
// Phase-2 expansion still adds new future uncommitted hours when even all
// committed hours filled to step capacity cannot absorb the demand — the
// genuine "primary's hour cannot deliver enough; we need more hours" case.
export const allocateCommittedEnergyToBuckets = (params: {
  buckets: NormalizedBucket[];
  stepForBucket: StepForBucket;
  energyNeededKWh: number;
  epsilonKWh: number;
  committedHours: readonly DeferredObjectiveCommittedHour[];
}): BucketAllocationResult => {
  const {
    buckets,
    stepForBucket,
    energyNeededKWh,
    epsilonKWh,
    committedHours,
  } = params;
  const committedHourSet = buildCommittedHourSet(committedHours);
  const plannedByBucketId = new Map<string, number>();
  let remainingKWh = Math.max(0, energyNeededKWh);
  let plannedUsefulEnergyKWh = 0;
  let usesDeadlineReserve = false;
  const bucketsByTime = sortBucketsByTime(buckets);

  for (const bucket of bucketsByTime) {
    if (remainingKWh <= epsilonKWh) break;
    const hourStartMs = Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS;
    if (!committedHourSet.has(hourStartMs)) continue;
    const usefulEnergyCapacityKWh = resolveBucketStepCapacityKWh(bucket, stepForBucket(bucket));
    const plannedKWh = Math.min(remainingKWh, usefulEnergyCapacityKWh);
    if (plannedKWh <= epsilonKWh) continue;
    plannedByBucketId.set(bucket.id, plannedKWh);
    plannedUsefulEnergyKWh += plannedKWh;
    remainingKWh -= plannedKWh;
    usesDeadlineReserve = usesDeadlineReserve || bucket.reserve;
  }

  // Phase-2 expansion fires only when the committed hours, filled up to their
  // step capacity, still cannot cover the demand. Two scenarios reach here:
  //
  //   (i)  Empty commitment (satisfied-then-drifted task — created with the
  //        tank already above target, then a hot-water draw made the need
  //        positive). Phase-1 has nothing to fill; expansion books hours
  //        against the uncommitted horizon, INCLUDING the current hour —
  //        an uncommitted current hour has no settled budget to protect, so
  //        it is filled cheapest-first rather than stranded (keeping the
  //        device on while behind). Stability comes from `energyNeededKWh`
  //        being slow-moving (target minus measured progress, so brief sheds
  //        don't spike it) plus the executor's within-hour step-climb — the
  //        served hour re-fills via phase-2 each cycle until the once-per-hour
  //        `:58` settle records it — not from skipping the current bucket.
  //   (ii) Non-empty commitment that genuinely cannot absorb the new need
  //        even at step capacity (e.g. shower crash dropped tank ~38 °C,
  //        need now exceeds committed step capacity × committed hours).
  //        Expansion adds the missing hours; commitment grows on persist.
  if (remainingKWh > epsilonKWh) {
    const expansion = expandCommittedAllocation({
      buckets,
      stepForBucket,
      epsilonKWh,
      remainingKWh,
      plannedByBucketId,
      committedHours,
    });
    plannedUsefulEnergyKWh += expansion.plannedUsefulEnergyKWh;
    remainingKWh = expansion.remainingKWh;
    usesDeadlineReserve = usesDeadlineReserve || expansion.usesDeadlineReserve;
  }

  return {
    plannedBuckets: buildPlannedBuckets({ buckets, stepForBucket, plannedByBucketId }),
    plannedUsefulEnergyKWh,
    unplannedUsefulEnergyKWh: Math.max(0, remainingKWh),
    usesDeadlineReserve,
  };
};

// Phase-2 expansion for the committed-plan path. Three load-bearing
// invariants the design rides on:
//
//   (a) A *committed* current hour's allocation is the contract for the hour:
//       its per-bucket budget cap has settled and any partial consumption is
//       already in flight, so expansion must not re-claim against it. That is
//       enforced by the `committedHourSet` skip below — a committed current
//       hour is in the set and is left to phase-1. An *uncommitted* current
//       hour has no settled budget to protect, so expansion DOES fill it
//       (cheapest-first, like any other hour). Without that, a task that
//       outlives its committed window strands its current hour at 0 kWh and
//       the device is turned off while still behind target (see
//       `test/integration/deferredObjectiveCommitmentRolloverSimulation.test.ts`). The
//       cheapest-first sort still defers an expensive current hour behind
//       cheaper future hours, so "wait for a cheaper hour" is preserved; the
//       current hour is only filled when it is among the cheapest hours still
//       needed (last resort near a deadline, or the genuine strand).
//   (b) Within-hour delivery is the executor / climbed-probe layer's job,
//       not the allocator's. A bucket commits an integral (kWh), not a
//       rate; the executor can climb step level to deliver the integral by
//       hour-end even after brief 60-300 s sheds. So status flutter from
//       stepped-load oscillation or brief sheds must NOT trigger plan
//       expansion — they self-resolve at the runtime layer. An uncommitted
//       current hour filled here appears in the live plan EVERY cycle, so the
//       device stays controlled. The recorder folds it into the persisted
//       commitment only at the once-per-hour settle
//       (`activePlanRecorder.isReplanDueThisCycle`); until that settle it
//       re-fills via this phase-2 path each cycle rather than being served from
//       phase-1 (committed). Live control is identical either way.
//   (c) Policy buckets stay hour-aligned. The committed-hour skip set is
//       keyed by `floor(startMs / HOUR_MS)`; relaxing the hour alignment
//       (sub-hour segments outside the existing reserve split) would
//       require revisiting both this skip and the per-bucket cap maths.
//
// Operationally: spill the residual into uncommitted future buckets using
// the fresh-allocator sort. Resizing WITHIN a committed hour up to step
// capacity is phase-1's job (committed kWh is a floor, not a ceiling — see
// `allocateCommittedEnergyToBuckets` header). Expansion only handles the
// genuine "all committed hours at step capacity still cannot cover the
// need" case, plus the "satisfied-then-drifted" case where commitment is
// empty (target was already met at task creation, then real-world load —
// e.g. a hot-water draw — created a new need). Mutates `plannedByBucketId`
// in place; returns updated running totals.
const expandCommittedAllocation = (params: {
  buckets: NormalizedBucket[];
  stepForBucket: StepForBucket;
  epsilonKWh: number;
  remainingKWh: number;
  plannedByBucketId: Map<string, number>;
  committedHours: readonly DeferredObjectiveCommittedHour[];
}): {
  plannedUsefulEnergyKWh: number;
  remainingKWh: number;
  usesDeadlineReserve: boolean;
} => {
  const {
    buckets, stepForBucket, epsilonKWh, plannedByBucketId, committedHours,
  } = params;
  let remainingKWh = params.remainingKWh;
  let plannedUsefulEnergyKWh = 0;
  let usesDeadlineReserve = false;
  const committedHourSet = buildCommittedHourSet(committedHours);
  for (const bucket of sortBucketsForAllocation(buckets)) {
    if (remainingKWh <= epsilonKWh) break;
    if (plannedByBucketId.has(bucket.id)) continue;
    // Skip any bucket whose hour was part of the original commitment —
    // phase-1 already filled those up to step capacity. Expansion adds
    // *new* hours, never duplicating allocation against a committed slot.
    // This also protects a *committed* current hour (its settled budget is
    // phase-1's; invariant (a)). An *uncommitted* current hour is NOT skipped:
    // it has no settled budget, so expansion fills it cheapest-first like any
    // other hour rather than stranding it at 0 kWh (invariant (a)).
    if (committedHourSet.has(Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS)) continue;
    const plannedKWh = Math.min(
      remainingKWh,
      resolveBucketStepCapacityKWh(bucket, stepForBucket(bucket)),
    );
    if (plannedKWh <= epsilonKWh) continue;
    plannedByBucketId.set(bucket.id, plannedKWh);
    plannedUsefulEnergyKWh += plannedKWh;
    remainingKWh -= plannedKWh;
    usesDeadlineReserve = usesDeadlineReserve || bucket.reserve;
  }
  return {
    plannedUsefulEnergyKWh, remainingKWh, usesDeadlineReserve,
  };
};

// Shared between phase-1 and phase-2: the hour-aligned set of timestamps
// that name the commitment's hours. Built from the RAW `committedHours`
// array so a commitment entry with `plannedKWh: 0` (synthetic test case,
// not reachable via `buildHoursFromHorizonPlan`) still counts as committed
// — phase-2 must not double-allocate against a slot phase-1 already
// considered, regardless of the floor's kWh value.
const buildCommittedHourSet = (
  committedHours: readonly DeferredObjectiveCommittedHour[],
): Set<number> => {
  const set = new Set<number>();
  for (const hour of committedHours) {
    if (!Number.isFinite(hour.startsAtMs)) continue;
    set.add(Math.floor(hour.startsAtMs / HOUR_MS) * HOUR_MS);
  }
  return set;
};

const appendNormalizedBucketSegments = (params: {
  bucket: DeferredObjectiveHorizonBucket;
  nowMs: number;
  deadlineAtMs: number;
  planningEndMs: number;
  normalized: NormalizedBucket[];
}): void => {
  const {
    bucket,
    nowMs,
    deadlineAtMs,
    planningEndMs,
    normalized,
  } = params;
  if (!isValidBucket(bucket)) return;
  const startMs = Math.max(bucket.startMs, nowMs);
  const endMs = Math.min(bucket.endMs, deadlineAtMs);
  if (endMs <= startMs) return;

  const splitAtMs = planningEndMs > startMs && planningEndMs < endMs
    ? planningEndMs
    : null;
  if (splitAtMs === null) {
    normalized.push(buildBucketSegment({
      bucket,
      startMs,
      endMs,
      reserve: startMs >= planningEndMs,
      nowMs,
      segmentId: bucket.id,
      originalStartMs: bucket.startMs,
      originalEndMs: bucket.endMs,
    }));
    return;
  }
  normalized.push(buildBucketSegment({
    bucket,
    startMs,
    endMs: splitAtMs,
    reserve: false,
    nowMs,
    segmentId: `${bucket.id}:primary`,
    originalStartMs: bucket.startMs,
    originalEndMs: bucket.endMs,
  }));
  normalized.push(buildBucketSegment({
    bucket,
    startMs: splitAtMs,
    endMs,
    reserve: true,
    nowMs,
    segmentId: `${bucket.id}:reserve`,
    originalStartMs: bucket.startMs,
    originalEndMs: bucket.endMs,
  }));
};

const buildBucketSegment = (params: {
  bucket: DeferredObjectiveHorizonBucket;
  startMs: number;
  endMs: number;
  reserve: boolean;
  nowMs: number;
  segmentId: string;
  originalStartMs: number;
  originalEndMs: number;
}): BucketSegment => {
  const {
    bucket,
    startMs,
    endMs,
    reserve,
    nowMs,
    segmentId,
    originalStartMs,
    originalEndMs,
  } = params;
  const durationHours = (endMs - startMs) / HOUR_MS;
  const originalDurationMs = Math.max(1, originalEndMs - originalStartMs);
  const usefulEnergyCapKWh = resolveSegmentUsefulEnergyCapKWh({
    maxUsefulEnergyKWh: bucket.maxUsefulEnergyKWh,
    segmentDurationMs: endMs - startMs,
    originalDurationMs,
  });
  // `reservedHeadroomKw` is a per-source-bucket rate forecast (kW), not an
  // integral — segment splits inherit the same rate. The per-hour ceiling
  // applies it as `rate × segmentDurationHours` so the primary/reserve
  // split still respects the hour-aligned forecast.
  return {
    id: segmentId,
    sourceBucketId: bucket.id,
    startMs,
    endMs,
    durationHours,
    price: normalizePrice(bucket.price),
    reserve,
    current: startMs <= nowMs && endMs > nowMs,
    usefulEnergyCapKWh,
    reservedHeadroomKw: normalizeReservedHeadroomKw(bucket.reservedHeadroomKw),
  };
};

// Preserve finite prices, including negatives: a negative price (paid to
// consume) is meaningful and the relative price-deferral test relies on it.
// Non-finite / missing → null, treated as "no price" (non-comparable) there.
const normalizePrice = (price: number | null | undefined): number | null => (
  typeof price === 'number' && Number.isFinite(price) ? price : null
);

// Treat non-finite or negative inputs as "no forecast available" so the
// per-hour cap falls back to step capacity ∧ daily-budget only. A zero
// reading is meaningful — it forces the per-hour cap to zero, which is
// what we want when the producer has decided this hour cannot deliver.
const normalizeReservedHeadroomKw = (
  reservedHeadroomKw: number | undefined,
): number | undefined => {
  if (reservedHeadroomKw === undefined) return undefined;
  if (!Number.isFinite(reservedHeadroomKw) || reservedHeadroomKw < 0) return undefined;
  return reservedHeadroomKw;
};

const isValidBucket = (bucket: DeferredObjectiveHorizonBucket): boolean => (
  typeof bucket.id === 'string'
  && bucket.id.trim() !== ''
  && Number.isFinite(bucket.startMs)
  && Number.isFinite(bucket.endMs)
  && bucket.endMs > bucket.startMs
);

const resolveSegmentUsefulEnergyCapKWh = (params: {
  maxUsefulEnergyKWh: number | undefined;
  segmentDurationMs: number;
  originalDurationMs: number;
}): number => {
  const {
    maxUsefulEnergyKWh,
    segmentDurationMs,
    originalDurationMs,
  } = params;
  if (typeof maxUsefulEnergyKWh !== 'number' || !Number.isFinite(maxUsefulEnergyKWh)) {
    return Number.POSITIVE_INFINITY;
  }
  if (maxUsefulEnergyKWh <= 0) return 0;
  return maxUsefulEnergyKWh * (segmentDurationMs / originalDurationMs);
};

const sortBucketsForAllocation = (
  buckets: NormalizedBucket[],
): NormalizedBucket[] => {
  // Resolve the price anchor (set min positive price) ONCE for the whole sort so
  // every bucket bands against the same reference — that keeps `priceFillBand` a
  // pure function of price within the sort, so the induced order stays a
  // transitive total order.
  const anchor = resolvePriceAnchor(buckets);
  return [...buckets].sort((left, right) => compareBucketsForAllocation(left, right, anchor));
};

const sortBucketsByTime = (
  buckets: NormalizedBucket[],
): NormalizedBucket[] => (
  [...buckets].sort(compareBucketsByTime)
);

const compareBucketsForAllocation = (
  left: NormalizedBucket,
  right: NormalizedBucket,
  anchor: number | null,
): number => (
  compareReserve(left, right)
  || comparePrice(left, right, anchor)
  || left.startMs - right.startMs
  || left.endMs - right.endMs
);

const compareBucketsByTime = (
  left: NormalizedBucket,
  right: NormalizedBucket,
): number => (
  left.startMs - right.startMs
  || left.endMs - right.endMs
);

const compareReserve = (
  left: Pick<NormalizedBucket, 'reserve'>,
  right: Pick<NormalizedBucket, 'reserve'>,
): number => {
  if (left.reserve === right.reserve) return 0;
  return left.reserve ? 1 : -1;
};

// Cheapest-first on the currency-relative band (`priceFillBand`). Hours within
// ~`PRICE_BAND_MARGIN` of each other tie here and fall through to the time
// tiebreak (earlier first), so the allocator never churns load between
// near-equal hours for a sub-margin saving.
const comparePrice = (
  left: Pick<NormalizedBucket, 'price'>,
  right: Pick<NormalizedBucket, 'price'>,
  anchor: number | null,
): number => {
  const a = priceFillBand(left.price, anchor);
  const b = priceFillBand(right.price, anchor);
  return a.tier - b.tier || a.key - b.key;
};

// Per-hour kWh ceiling. Three caps stacked via Math.min:
//   - `step.usefulPowerKw × durationHours`: device-side step capacity.
//   - `bucket.usefulEnergyCapKWh`: daily-budget per-bucket pacing slice
//     (Infinity for `exemptFromBudget` tasks).
//   - `bucket.reservedHeadroomKw × durationHours`: physical headroom
//     forecast (hard-cap minus uncontrolled background, divided across
//     concurrent eligible tasks). Skipped when the forecast is not
//     available (`undefined`); a value of 0 caps the hour at 0 kWh, which
//     is the right behavior when the producer's forecast says the
//     hard-cap room is fully consumed.
const resolveBucketStepCapacityKWh = (
  bucket: NormalizedBucket,
  step: DeferredObjectiveStep,
): number => {
  const stepCapacityKWh = step.usefulPowerKw * bucket.durationHours;
  const headroomCapKWh = bucket.reservedHeadroomKw === undefined
    ? Number.POSITIVE_INFINITY
    : bucket.reservedHeadroomKw * bucket.durationHours;
  return Math.max(0, Math.min(stepCapacityKWh, bucket.usefulEnergyCapKWh, headroomCapKWh));
};

const buildPlannedBuckets = (params: {
  buckets: NormalizedBucket[];
  stepForBucket: StepForBucket;
  plannedByBucketId: ReadonlyMap<string, number>;
}): DeferredObjectivePlannedBucket[] => {
  const {
    buckets,
    stepForBucket,
    plannedByBucketId,
  } = params;
  return buckets.map((bucket) => ({
    id: bucket.id,
    sourceBucketId: bucket.sourceBucketId,
    startMs: bucket.startMs,
    endMs: bucket.endMs,
    durationHours: bucket.durationHours,
    price: bucket.price,
    reserve: bucket.reserve,
    current: bucket.current,
    usefulEnergyCapacityKWh: resolveBucketStepCapacityKWh(bucket, stepForBucket(bucket)),
    plannedUsefulEnergyKWh: plannedByBucketId.get(bucket.id) ?? 0,
  }));
};
