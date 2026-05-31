import type {
  DeferredObjectiveBucketPreference,
  DeferredObjectiveCommittedHour,
  DeferredObjectiveHorizonBucket,
  DeferredObjectivePlannedBucket,
  DeferredObjectiveStep,
} from './types';

const HOUR_MS = 60 * 60 * 1000;

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
  preference: DeferredObjectiveBucketPreference;
  policyScore: number;
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
  usesPolicyAvoid: boolean;
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
  let usesPolicyAvoid = false;
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
    usesPolicyAvoid = usesPolicyAvoid || bucket.preference === 'avoid';
  }

  return {
    plannedBuckets: buildPlannedBuckets({ buckets, stepForBucket, plannedByBucketId }),
    plannedUsefulEnergyKWh,
    unplannedUsefulEnergyKWh: Math.max(0, remainingKWh),
    usesDeadlineReserve,
    usesPolicyAvoid,
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
  let usesPolicyAvoid = false;
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
    usesPolicyAvoid = usesPolicyAvoid || bucket.preference === 'avoid';
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
  //        don't spike it) plus the executor's within-hour step-climb and the
  //        served hour self-committing — not from skipping the current bucket.
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
    usesPolicyAvoid = usesPolicyAvoid || expansion.usesPolicyAvoid;
  }

  return {
    plannedBuckets: buildPlannedBuckets({ buckets, stepForBucket, plannedByBucketId }),
    plannedUsefulEnergyKWh,
    unplannedUsefulEnergyKWh: Math.max(0, remainingKWh),
    usesDeadlineReserve,
    usesPolicyAvoid,
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
//       `test/deferredObjectiveCommitmentRolloverSimulation.test.ts`). The
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
//       current hour filled here self-stabilises: it appears in the live plan,
//       the recorder merges it into the commitment, and the next cycle serves
//       it from phase-1 (committed) rather than re-deciding it.
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
  usesPolicyAvoid: boolean;
} => {
  const {
    buckets, stepForBucket, epsilonKWh, plannedByBucketId, committedHours,
  } = params;
  let remainingKWh = params.remainingKWh;
  let plannedUsefulEnergyKWh = 0;
  let usesDeadlineReserve = false;
  let usesPolicyAvoid = false;
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
    usesPolicyAvoid = usesPolicyAvoid || bucket.preference === 'avoid';
  }
  return {
    plannedUsefulEnergyKWh, remainingKWh, usesDeadlineReserve, usesPolicyAvoid,
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
    preference: normalizePreference(bucket.preference),
    policyScore: normalizePolicyScore(bucket.policyScore, bucket.preference),
    reserve,
    current: startMs <= nowMs && endMs > nowMs,
    usefulEnergyCapKWh,
    reservedHeadroomKw: normalizeReservedHeadroomKw(bucket.reservedHeadroomKw),
  };
};

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

const normalizePreference = (
  preference: DeferredObjectiveBucketPreference | undefined,
): DeferredObjectiveBucketPreference => preference ?? 'neutral';

const normalizePolicyScore = (
  policyScore: number | undefined,
  preference: DeferredObjectiveBucketPreference | undefined,
): number => {
  if (typeof policyScore === 'number' && Number.isFinite(policyScore)) return policyScore;
  switch (preference) {
    case 'preferred':
      return 2;
    case 'avoid':
      return 0;
    case 'neutral':
    default:
      return 1;
  }
};

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
): NormalizedBucket[] => (
  [...buckets].sort(compareBucketsForAllocation)
);

const sortBucketsByTime = (
  buckets: NormalizedBucket[],
): NormalizedBucket[] => (
  [...buckets].sort(compareBucketsByTime)
);

const compareBucketsForAllocation = (
  left: NormalizedBucket,
  right: NormalizedBucket,
): number => (
  compareReserve(left, right)
  || comparePreference(left, right)
  || right.policyScore - left.policyScore
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

const comparePreference = (
  left: Pick<NormalizedBucket, 'preference'>,
  right: Pick<NormalizedBucket, 'preference'>,
): number => preferenceRank(right.preference) - preferenceRank(left.preference);

const preferenceRank = (preference: DeferredObjectiveBucketPreference): number => {
  switch (preference) {
    case 'preferred':
      return 2;
    case 'neutral':
      return 1;
    case 'avoid':
      return 0;
    default:
      return 1;
  }
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
    preference: bucket.preference,
    policyScore: bucket.policyScore,
    reserve: bucket.reserve,
    current: bucket.current,
    usefulEnergyCapacityKWh: resolveBucketStepCapacityKWh(bucket, stepForBucket(bucket)),
    plannedUsefulEnergyKWh: plannedByBucketId.get(bucket.id) ?? 0,
  }));
};
