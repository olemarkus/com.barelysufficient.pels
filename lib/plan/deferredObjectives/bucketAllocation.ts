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
};

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
  step: DeferredObjectiveStep;
  energyNeededKWh: number;
  epsilonKWh: number;
}): BucketAllocationResult => {
  const {
    buckets,
    step,
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
    const usefulEnergyCapacityKWh = resolveBucketStepCapacityKWh(bucket, step);
    const plannedKWh = Math.min(remainingKWh, usefulEnergyCapacityKWh);
    if (plannedKWh <= epsilonKWh) continue;
    plannedByBucketId.set(bucket.id, plannedKWh);
    plannedUsefulEnergyKWh += plannedKWh;
    remainingKWh -= plannedKWh;
    usesDeadlineReserve = usesDeadlineReserve || bucket.reserve;
    usesPolicyAvoid = usesPolicyAvoid || bucket.preference === 'avoid';
  }

  return {
    plannedBuckets: buildPlannedBuckets({ buckets, step, plannedByBucketId }),
    plannedUsefulEnergyKWh,
    unplannedUsefulEnergyKWh: Math.max(0, remainingKWh),
    usesDeadlineReserve,
    usesPolicyAvoid,
  };
};

export const allocateCommittedEnergyToBuckets = (params: {
  buckets: NormalizedBucket[];
  step: DeferredObjectiveStep;
  energyNeededKWh: number;
  epsilonKWh: number;
  committedHours: readonly DeferredObjectiveCommittedHour[];
}): BucketAllocationResult => {
  const {
    buckets,
    step,
    energyNeededKWh,
    epsilonKWh,
    committedHours,
  } = params;
  const committedRemainingByHour = buildCommittedHourMap(committedHours, epsilonKWh);
  const plannedByBucketId = new Map<string, number>();
  let remainingKWh = Math.max(0, energyNeededKWh);
  let plannedUsefulEnergyKWh = 0;
  let usesDeadlineReserve = false;
  let usesPolicyAvoid = false;
  const bucketsByTime = sortBucketsByTime(buckets);

  for (const bucket of bucketsByTime) {
    if (remainingKWh <= epsilonKWh) break;
    const hourStartMs = Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS;
    const committedRemainingKWh = committedRemainingByHour.get(hourStartMs) ?? 0;
    if (committedRemainingKWh <= epsilonKWh) continue;
    const usefulEnergyCapacityKWh = resolveBucketStepCapacityKWh(bucket, step);
    const plannedKWh = Math.min(remainingKWh, committedRemainingKWh, usefulEnergyCapacityKWh);
    if (plannedKWh <= epsilonKWh) continue;
    plannedByBucketId.set(bucket.id, plannedKWh);
    committedRemainingByHour.set(hourStartMs, committedRemainingKWh - plannedKWh);
    plannedUsefulEnergyKWh += plannedKWh;
    remainingKWh -= plannedKWh;
    usesDeadlineReserve = usesDeadlineReserve || bucket.reserve;
    usesPolicyAvoid = usesPolicyAvoid || bucket.preference === 'avoid';
  }

  // Phase-2 expansion fires whenever the within-commitment fill leaves
  // residual energy unmet. An empty original commitment used to be a hard
  // "stale `cannot_meet` plan must not silently recover" stop, but that gate
  // also blocked the satisfied-then-drifted case: a task created with the
  // tank already above target gets `committedHours: []`, then if hot-water
  // draw crashes the tank mid-task the planner had no way to recover even
  // though the remaining horizon could absorb the new need. The
  // `!bucket.current` filter inside `expandCommittedAllocation` is the
  // structural replacement — expansion only adds *future* uncommitted
  // buckets, leaving the settled per-bucket budget cap on the current
  // bucket alone. Brief within-bucket cannot_meet flips (from a 60-300 s
  // shed) deflate naturally as the executor's step-climb catches up; the
  // committed kWh is an integral over the hour, not a rate.
  if (remainingKWh > epsilonKWh) {
    const expansion = expandCommittedAllocation({
      buckets,
      step,
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
    plannedBuckets: buildPlannedBuckets({ buckets, step, plannedByBucketId }),
    plannedUsefulEnergyKWh,
    unplannedUsefulEnergyKWh: Math.max(0, remainingKWh),
    usesDeadlineReserve,
    usesPolicyAvoid,
  };
};

// Phase-2 expansion for the committed-plan path. Three load-bearing
// invariants the design rides on:
//
//   (a) The current bucket's commitment is the contract for the hour. Its
//       per-bucket budget cap has settled and any partial consumption is
//       already in flight. Expansion adds *future* hours only — the
//       `!bucket.current` filter below enforces this.
//   (b) Within-hour delivery is the executor / climbed-probe layer's job,
//       not the allocator's. A bucket commits an integral (kWh), not a
//       rate; the executor can climb step level to deliver the integral by
//       hour-end even after brief 60-300 s sheds. So status flutter from
//       stepped-load oscillation or brief sheds must NOT trigger plan
//       expansion — they self-resolve at the runtime layer.
//   (c) Policy buckets stay hour-aligned. The committed-hour skip set is
//       keyed by `floor(startMs / HOUR_MS)`; relaxing the hour alignment
//       (sub-hour segments outside the existing reserve split) would
//       require revisiting both this skip and the per-bucket cap maths.
//
// Operationally: spill the residual into uncommitted future buckets using
// the fresh-allocator sort. This handles both the "primary bucket failed
// to deliver" case (commitment non-empty, drift made energyNeeded grow)
// and the "satisfied-then-drifted" case (commitment empty because target
// was already met at task creation, then real-world load — e.g. a
// hot-water draw — created a new need). Mutates `plannedByBucketId` in
// place; returns updated running totals.
const expandCommittedAllocation = (params: {
  buckets: NormalizedBucket[];
  step: DeferredObjectiveStep;
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
    buckets, step, epsilonKWh, plannedByBucketId, committedHours,
  } = params;
  let remainingKWh = params.remainingKWh;
  let plannedUsefulEnergyKWh = 0;
  let usesDeadlineReserve = false;
  let usesPolicyAvoid = false;
  // Build the skip set from the *raw* `committedHours` array, not from
  // `committedRemainingByHour`. `buildCommittedHourMap` filters out hours
  // with sub-epsilon or non-finite `plannedKWh`, but those hours are still
  // part of the commitment — they were just intentionally capped at zero.
  // Expansion must respect that cap, otherwise it could allocate fresh
  // energy into a slot the commitment explicitly held at zero.
  const committedHourSet = new Set<number>();
  for (const hour of committedHours) {
    if (!Number.isFinite(hour.startsAtMs)) continue;
    committedHourSet.add(Math.floor(hour.startsAtMs / HOUR_MS) * HOUR_MS);
  }
  for (const bucket of sortBucketsForAllocation(buckets)) {
    if (remainingKWh <= epsilonKWh) break;
    if (plannedByBucketId.has(bucket.id)) continue;
    // Skip the current bucket — its per-bucket budget cap has settled and
    // within-hour delivery is the executor's job (invariants (a) and (b)
    // above). Expansion adds future hours only.
    if (bucket.current) continue;
    // Skip any bucket whose hour was part of the original commitment — the
    // commitment is the binding ceiling for that hour. Expansion adds *new*
    // hours; resizing within an existing hour is the normal-revision path's
    // job, not this one.
    if (committedHourSet.has(Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS)) continue;
    const plannedKWh = Math.min(remainingKWh, resolveBucketStepCapacityKWh(bucket, step));
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
  };
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

const buildCommittedHourMap = (
  committedHours: readonly DeferredObjectiveCommittedHour[],
  epsilonKWh: number,
): Map<number, number> => {
  const byHour = new Map<number, number>();
  for (const hour of committedHours) {
    if (!Number.isFinite(hour.startsAtMs) || !Number.isFinite(hour.plannedKWh)) continue;
    if (hour.plannedKWh <= epsilonKWh) continue;
    const startsAtMs = Math.floor(hour.startsAtMs / HOUR_MS) * HOUR_MS;
    byHour.set(startsAtMs, (byHour.get(startsAtMs) ?? 0) + hour.plannedKWh);
  }
  return byHour;
};

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

const resolveBucketStepCapacityKWh = (
  bucket: NormalizedBucket,
  step: DeferredObjectiveStep,
): number => (
  Math.max(0, Math.min(step.usefulPowerKw * bucket.durationHours, bucket.usefulEnergyCapKWh))
);

const buildPlannedBuckets = (params: {
  buckets: NormalizedBucket[];
  step: DeferredObjectiveStep;
  plannedByBucketId: ReadonlyMap<string, number>;
}): DeferredObjectivePlannedBucket[] => {
  const {
    buckets,
    step,
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
    usefulEnergyCapacityKWh: resolveBucketStepCapacityKWh(bucket, step),
    plannedUsefulEnergyKWh: plannedByBucketId.get(bucket.id) ?? 0,
  }));
};
