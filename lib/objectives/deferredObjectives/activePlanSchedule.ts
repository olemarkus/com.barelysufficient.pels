import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import { roundKWh } from './activePlanMath';

const ONE_HOUR_MS = 60 * 60 * 1000;

export const buildHoursFromHorizonPlan = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanHourV1[] | null => {
  const horizonPlan = diag.horizonPlan;
  if (!horizonPlan) return null;
  // The horizon planner trims the current bucket's start to `nowMs` and may
  // split a single hour into two segments at `planningEndMs` (see
  // `bucketAllocation.ts`), so plannedBucket startMs values can be
  // mid-hour. The Settings UI keys planned usage by hour-aligned price-horizon
  // start timestamps, so floor each bucket to its containing hour and sum
  // segments that collapse into the same hour.
  const byHour = new Map<number, number>();
  for (const bucket of horizonPlan.plannedBuckets) {
    if (bucket.plannedUsefulEnergyKWh <= 0) continue;
    const hourStart = Math.floor(bucket.startMs / ONE_HOUR_MS) * ONE_HOUR_MS;
    byHour.set(hourStart, (byHour.get(hourStart) ?? 0) + bucket.plannedUsefulEnergyKWh);
  }
  return [...byHour.entries()]
    .map(([startsAtMs, plannedKWh]) => ({ startsAtMs, plannedKWh: roundKWh(plannedKWh) }))
    .sort((left, right) => left.startsAtMs - right.startsAtMs);
};

export const resolveProjectedFinishAtMs = (
  diag: DeferredObjectiveDiagnostic,
): number | null => {
  const horizonPlan = diag.horizonPlan;
  if (!horizonPlan) return null;
  // The last planned bucket may be only partially used; estimate finish time
  // from its fill ratio so the trigger token reflects realistic completion,
  // not just the hour boundary.
  let lastPlannedBucket: typeof horizonPlan.plannedBuckets[number] | null = null;
  for (const bucket of horizonPlan.plannedBuckets) {
    if (bucket.plannedUsefulEnergyKWh <= 0) continue;
    if (lastPlannedBucket === null || bucket.startMs > lastPlannedBucket.startMs) {
      lastPlannedBucket = bucket;
    }
  }
  if (lastPlannedBucket === null) return null;
  const bucketDurationMs = lastPlannedBucket.endMs - lastPlannedBucket.startMs;
  if (bucketDurationMs <= 0) return null;
  const capacity = lastPlannedBucket.usefulEnergyCapacityKWh;
  const fraction = capacity > 0
    ? Math.min(1, Math.max(0, lastPlannedBucket.plannedUsefulEnergyKWh / capacity))
    : 1;
  return Math.round(lastPlannedBucket.startMs + fraction * bucketDurationMs);
};

// User-facing notification gate. Fires only when the number of charging
// hours actually changes — same-count swaps stay quiet on the flow bus.
// Empty schedules split by intent: a `satisfied` collapse is suppressed
// (target met — no plan to notify about); a `cannot_meet`, `invalid`, or
// `at_risk` collapse fires so automations see "your plan blew up" even when the
// planner stays in the same status across a statusDetail worsening. `at_risk`
// is included because a `feasible_above_floor` verdict (floor planned nothing,
// only a step climb would fit) is the one `at_risk` case that can reach an
// empty schedule — reserve/policy at-risk always plan buckets — and an empty
// floor schedule is still a "plan blew up" event worth surfacing.
export const shouldFireNotification = (
  previousHourCount: number,
  nextHourCount: number,
  planStatus: DeferredObjectiveActivePlanRevisionV1['planStatus'],
): boolean => {
  if (previousHourCount === nextHourCount) return false;
  if (nextHourCount > 0) return true;
  return planStatus === 'cannot_meet' || planStatus === 'invalid' || planStatus === 'at_risk';
};

// Schedule comparison: two hour lists are equivalent iff they cover the same
// set of hour-aligned `startsAtMs` values, in order. `plannedKWh` is
// deliberately excluded — a shrinking `energyNeededKWh` redistributes kWh
// across the same hours without changing the user-visible schedule.
export const sameHourSchedule = (
  a: readonly DeferredObjectiveActivePlanHourV1[],
  b: readonly DeferredObjectiveActivePlanHourV1[],
): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.startsAtMs !== b[i]!.startsAtMs) return false;
  }
  return true;
};

// Merge live horizon hours into the existing commitment.
//
// The committed schedule is the task's contract (which hour-aligned hours it
// will run). Each plan cycle the live horizon plan is merged in.
//
// We split `committed` relative to the ACTUAL current hour
// (`floor(nowMs / ONE_HOUR_MS)`), NOT relative to the live plan's earliest
// hour. The horizon allocator is a price/policy optimizer
// (`bucketAllocation.ts` sorts by reserve→preference→policyScore→time, and
// `buildHoursFromHorizonPlan` DROPS every bucket with
// `plannedUsefulEnergyKWh <= 0`), so when near-term hours are expensive or
// carry an `avoid` price level they are allocated 0 kWh and vanish from the
// live set. The live plan's earliest populated hour can therefore be a FUTURE
// hour while the current hour is still pending — keying the partition off the
// live earliest hour would misclassify still-pending committed hours as
// "elapsed" and let optimizer thrash silently drop them from the coverage
// contract. We key off wall-clock `nowMs` instead.
//
//   • ELAPSED committed hours (`startsAtMs < currentHourStart`) are settled
//     history — the hour they describe is strictly in the past. They are
//     preserved as floors in the result but MUST NOT gate the coverage check,
//     otherwise the merge would freeze permanently after the task's first
//     committed hour elapses and could never adopt a newly-planned future hour
//     again.
//
//   • CURRENT/FUTURE committed hours (`startsAtMs >= currentHourStart`) are the
//     part of the contract that is still pending (current hour onward). The
//     coverage check runs over these only. A committed current/future hour
//     missing from the live plan is genuine optimizer churn (the allocator
//     repriced it to 0 kWh or dropped it), NOT an elapsed hour.
//
// Two branches on that current/future coverage:
//
// **live ⊇ current/future committed**: adopt the live hour set. For each
// overlapping hour take `Math.max(committed.plannedKWh, live.plannedKWh)` so
// the historical kWh is preserved as a contract floor — a shrinking live kWh
// (per-cycle re-fill against a smaller current need) must not rewrite a
// committed hour downward. Elapsed committed hours are added back as floors.
// This lets per-cycle growth (within-hour drift or phase-2 expansion) extend
// the commitment with brand-new future hours, but only once the earlier hours
// have TRULY elapsed. When committed is empty the inclusion check is vacuously
// true → live becomes the first real commitment.
//
// **live ⊉ current/future committed**: a still-pending committed hour is
// genuinely missing from the live allocation (real optimizer churn). Preserve
// the full commitment as-is — "committed schedule cannot shrink mid-task and
// cannot churn from optimizer thrash" is the long-standing invariant.
//
// Pure: no mutation of the inputs. Hour math is UTC-millisecond floor/compare
// of `nowMs` and the already-hour-floored `startsAtMs` values, so a 23/25-hour
// DST day does not perturb the elapsed/future partition (no local-time
// assumption).
export const mergeHoursPreservingCommitment = (
  committed: readonly DeferredObjectiveActivePlanHourV1[],
  live: readonly DeferredObjectiveActivePlanHourV1[],
  nowMs: number,
): DeferredObjectiveActivePlanHourV1[] => {
  if (committed.length === 0) return [...live];
  // With no live plan there is nothing to adopt — preserve the commitment
  // (no-shrink invariant).
  if (live.length === 0) return [...committed];

  const currentHourStart = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
  const currentOrFutureCommitted = committed.filter((h) => h.startsAtMs >= currentHourStart);

  const liveByStart = new Map(live.map((h) => [h.startsAtMs, h] as const));
  const liveCoversCommitment = currentOrFutureCommitted.every((h) => liveByStart.has(h.startsAtMs));
  // Genuine churn: a still-pending committed hour vanished from the allocation.
  if (!liveCoversCommitment) return [...committed];

  const committedByStart = new Map(committed.map((h) => [h.startsAtMs, h] as const));
  const mergedLive = live.map((liveHour) => {
    const c = committedByStart.get(liveHour.startsAtMs);
    if (!c) return liveHour;
    return c.plannedKWh > liveHour.plannedKWh
      ? { ...liveHour, plannedKWh: c.plannedKWh }
      : liveHour;
  });
  // Elapsed hours (`startsAtMs < currentHourStart`) are re-added as floors. In
  // production the planner trims the live plan's current bucket start to
  // `nowMs`, so its earliest hour is >= currentHourStart and elapsed hours do
  // not appear in `live`. Guard against a live plan that still carries a
  // sub-current hour anyway: any elapsed hour already present in `live` was
  // folded into `mergedLive` (with the committed kWh floor applied), so exclude
  // it here to avoid duplicating its `startsAtMs`.
  const elapsedCommitted = committed.filter(
    (h) => h.startsAtMs < currentHourStart && !liveByStart.has(h.startsAtMs),
  );
  return [...elapsedCommitted, ...mergedLive].sort((left, right) => left.startsAtMs - right.startsAtMs);
};
