import type {
  DeferredObjectiveCommittedHour,
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveAllocatedBucket,
  DeferredObjectiveStep,
} from './types';
import { comparePrice, resolvePriceAnchor } from './priceBand';
import { hasPlannedEnergy } from '../../../packages/shared-domain/src/deferredPlanBookedHours';

const HOUR_MS = 60 * 60 * 1000;

type NormalizedBucket = Omit<DeferredObjectiveAllocatedBucket,
| 'plannedUsefulEnergyKWh'
| 'plannedAdmissionPowerKw'
| 'usefulEnergyCapacityKWh'
> & {
  dailyBudgetCapKWh: number;
  budgetCapPolicy: 'enforced' | 'lifted';
  higherPriorityReservedKWh: number;
  reservedHeadroomKw: number | undefined;
  higherPriorityAdmissionPowerKw: number | undefined;
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
  dailyBudgetCapKWh: number;
  budgetCapPolicy: 'enforced' | 'lifted';
  higherPriorityReservedKWh: number;
  // Concurrent draw already claimed by higher-priority tasks in this hour; see the
  // field doc on `DeferredObjectiveHorizonBucket`. Drives the RATE test below.
  higherPriorityAdmissionPowerKw: number | undefined;
  // Per-bucket physical headroom forecast (hard-cap minus uncontrolled
  // background, divided across concurrent eligible tasks). Caps the
  // per-hour kWh the allocator can commit so a hour with low forecast
  // headroom can't over-promise even when step capacity has more to give.
  // `undefined` when the producer (`policyHorizon.ts`) could not compute a
  // forecast — typically `backgroundKWh === null`;
  // in that case the per-hour cap falls back to step capacity ∧
  // daily-budget only.
  reservedHeadroomKw: number | undefined;
};

export type BucketAllocationResult = {
  plannedBuckets: DeferredObjectiveAllocatedBucket[];
  plannedUsefulEnergyKWh: number;
  unplannedUsefulEnergyKWh: number;
  usesDeadlineReserve: boolean;
};

/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
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
/* eslint-enable functional/immutable-data */

// Epsilon decides whether the remaining task need is satisfied, not whether a
// bucket is booked. A positive sliver at hour-end still carries an active claim;
// dropping it would release the device just before the next booked hour.
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
    if (plannedKWh <= 0) continue;
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
    if (plannedKWh <= 0) continue;
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
    if (plannedKWh <= 0) continue;
    plannedByBucketId.set(bucket.id, plannedKWh);
    plannedUsefulEnergyKWh += plannedKWh;
    remainingKWh -= plannedKWh;
    usesDeadlineReserve = usesDeadlineReserve || bucket.reserve;
  }
  return {
    plannedUsefulEnergyKWh, remainingKWh, usesDeadlineReserve,
  };
};

// Shared between phase-1 and phase-2: the hour-aligned set of timestamps that
// carry a committed energy floor. A saved hour booked at 0 kWh promises nothing,
// so it is not in the set: phase-1 must not fill it ahead of cheaper committed
// hours just because it is earlier, and phase-2 may fill it cheapest-first like
// any other uncommitted hour when the need grows.
const buildCommittedHourSet = (
  committedHours: readonly DeferredObjectiveCommittedHour[],
): Set<number> => {
  const set = new Set<number>();
  for (const hour of committedHours) {
    if (!Number.isFinite(hour.startsAtMs) || !hasPlannedEnergy(hour)) continue;
    set.add(Math.floor(hour.startsAtMs / HOUR_MS) * HOUR_MS);
  }
  return set;
};

/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
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
/* eslint-enable functional/immutable-data */

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
  const higherPriorityReservedKWh = resolveOverlappingReservedEnergyKWh({
    reservations: bucket.higherPriorityEnergyReservations,
    startMs,
    endMs,
  });
  // `reservedHeadroomKw` is a per-source-bucket rate forecast (kW), not an
  // integral — segment splits inherit the same rate. The per-hour ceiling
  // applies it as `rate × segmentDurationHours` so the primary/reserve
  // split still respects the hour-aligned forecast.
  return {
    id: segmentId,
    sourceBucketId: bucket.sourceBucketId ?? bucket.id,
    startMs,
    endMs,
    durationHours,
    price: normalizePrice(bucket.price),
    reserve,
    current: startMs <= nowMs && endMs > nowMs,
    dailyBudgetCapKWh: usefulEnergyCapKWh,
    budgetCapPolicy: 'enforced',
    higherPriorityReservedKWh,
    reservedHeadroomKw: normalizeReservedHeadroomKw(bucket.reservedHeadroomKw),
    higherPriorityAdmissionPowerKw: normalizeReservedHeadroomKw(bucket.higherPriorityAdmissionPowerKw),
  };
};

const resolveOverlappingReservedEnergyKWh = (params: {
  reservations: DeferredObjectiveHorizonBucket['higherPriorityEnergyReservations'];
  startMs: number;
  endMs: number;
}): number => {
  let reservedKWh = 0;
  for (const reservation of params.reservations ?? []) {
    const durationMs = reservation.endMs - reservation.startMs;
    if (durationMs <= 0 || reservation.plannedKWh <= 0) continue;
    const overlapMs = Math.max(
      0,
      Math.min(params.endMs, reservation.endMs) - Math.max(params.startMs, reservation.startMs),
    );
    reservedKWh += reservation.plannedKWh * (overlapMs / durationMs);
  }
  return reservedKWh;
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

// Per-hour kWh ceiling. Three caps stacked via Math.min:
//   - `step.usefulPowerKw × durationHours`: device-side step capacity.
//   - `bucket.dailyBudgetCapKWh`: daily-budget per-bucket pacing slice
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
  // Rate test, but ONLY against concurrent contention. A higher-priority task's
  // claim is a real simultaneous draw, so a rung that does not fit the residual
  // cannot share the hour and the hour is not this task's to plan on.
  //
  // It deliberately does NOT apply when the only thing consuming headroom is the
  // background forecast. That is an hourly AVERAGE against an hourly ENERGY
  // allowance (`notes/safe-pace-two-constraints.md`: `hourlyAllowanceKWh`, with
  // `sustainableRateKw` "the same value read as a rate"), so it bounds how much the
  // hour can hold, not whether the device may run in it — an hour with 0.86 kW of
  // room holds 0.86 kWh, which a 1.38 kW charger takes in 37 minutes. Zeroing such
  // an hour is what made a budget-bound plan read as physically impossible, and it
  // enforced an instantaneous limit the live capacity guard already owns, at plan
  // time, from a forecast average. A grid import limit is the same trade: the
  // forecast spends its target as an hourly rate, and live admission alone holds
  // measured import under it.
  if (
    bucket.higherPriorityAdmissionPowerKw !== undefined
    && bucket.higherPriorityAdmissionPowerKw > 0
    && bucket.reservedHeadroomKw !== undefined
    && step.admissionPowerKw > bucket.reservedHeadroomKw
  ) {
    return 0;
  }
  const stepCapacityKWh = step.usefulPowerKw * bucket.durationHours;
  const headroomCapKWh = bucket.reservedHeadroomKw === undefined
    ? Number.POSITIVE_INFINITY
    : bucket.reservedHeadroomKw * bucket.durationHours;
  // Lift only the raw budget slice, retaining the reservation subtraction.
  // A slice already large enough for this rung was not budget-bound; making
  // that slice infinite would wrongly erase another task's claim as well.
  const dailyBudgetCapKWh = bucket.budgetCapPolicy === 'lifted'
    ? Math.max(bucket.dailyBudgetCapKWh, stepCapacityKWh)
    : bucket.dailyBudgetCapKWh;
  const energyAfterReservationsKWh = Math.max(0, dailyBudgetCapKWh - bucket.higherPriorityReservedKWh);
  return Math.max(0, Math.min(stepCapacityKWh, energyAfterReservationsKWh, headroomCapKWh));
};

const buildPlannedBuckets = (params: {
  buckets: NormalizedBucket[];
  stepForBucket: StepForBucket;
  plannedByBucketId: ReadonlyMap<string, number>;
}): DeferredObjectiveAllocatedBucket[] => {
  const {
    buckets,
    stepForBucket,
    plannedByBucketId,
  } = params;
  return buckets.map((bucket) => {
    const step = stepForBucket(bucket);
    const plannedUsefulEnergyKWh = plannedByBucketId.get(bucket.id) ?? 0;
    return {
      id: bucket.id,
      sourceBucketId: bucket.sourceBucketId,
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      durationHours: bucket.durationHours,
      price: bucket.price,
      reserve: bucket.reserve,
      current: bucket.current,
      usefulEnergyCapacityKWh: resolveBucketStepCapacityKWh(bucket, step),
      plannedUsefulEnergyKWh,
      plannedAdmissionPowerKw: plannedUsefulEnergyKWh > 0 ? step.admissionPowerKw : 0,
    };
  });
};
