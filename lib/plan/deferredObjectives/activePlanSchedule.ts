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

// Merge live horizon hours into the existing commitment. Captures two
// distinct intents at the same call site:
//
// **Expansion (live ⊇ committed)** — the planner allocated at least every
// committed hour plus possibly new ones. This is the phase-2 expansion
// shape: drift triggered the allocator to add future buckets to the
// existing commitment. We adopt the live hours wholesale (overlapping
// hours pick up the live `plannedKWh`, which reflects the latest
// allocation against current energy need; new live hours grow the
// commitment). This is the "expansion extends the commitment" path.
//
// **Optimizer-disagreement (live ⊉ committed)** — the live allocation is
// missing one or more committed hours. That is NOT expansion — it's the
// committed-replan path producing a different set of hours than the
// commitment (e.g. energy need shrank so phase-1 didn't fill every
// committed hour; or a fresh re-optimization picked different hours). The
// commitment is the contract; we preserve it as-is and ignore the live
// hours that disagree. This preserves the long-standing "committed
// schedule cannot shrink mid-task and cannot churn from optimizer
// thrash" invariant.
//
// The two intents are distinguished purely by the set inclusion test
// (`committed.every(h => live has h.startsAtMs)`). When `committed` is
// empty the check is vacuously true → the live hours become the new
// commitment, which is exactly what we want for the satisfied-then-drift
// case (commitment was `[]` because target was already met at task
// creation; drift triggered expansion; we lay down the expansion hours
// as the first real commitment).
export const mergeHoursPreservingCommitment = (
  committed: readonly DeferredObjectiveActivePlanHourV1[],
  live: readonly DeferredObjectiveActivePlanHourV1[],
): DeferredObjectiveActivePlanHourV1[] => {
  if (committed.length === 0) return [...live];
  const liveByStart = new Map(live.map((h) => [h.startsAtMs, h] as const));
  const liveCoversCommitment = committed.every((h) => liveByStart.has(h.startsAtMs));
  if (!liveCoversCommitment) return [...committed];
  // Expansion branch: live is a superset of committed. Adopt live as the
  // shape (which includes any new expansion hours), but for overlapping
  // hours take `Math.max(committed.plannedKWh, live.plannedKWh)` so the
  // historical commitment kWh is preserved as a floor. Without this, a
  // shrinking `energyNeededKWh` would let the allocator's per-cycle
  // re-fill rewrite a committed hour's cap downward — and the next
  // cycle's `buildCommittedHourMap` would then enforce the smaller cap,
  // silently shrinking future delivery against the original contract.
  const committedByStart = new Map(committed.map((h) => [h.startsAtMs, h] as const));
  return [...live]
    .map((liveHour) => {
      const c = committedByStart.get(liveHour.startsAtMs);
      if (!c) return liveHour;
      return c.plannedKWh > liveHour.plannedKWh
        ? { ...liveHour, plannedKWh: c.plannedKWh }
        : liveHour;
    })
    .sort((left, right) => left.startsAtMs - right.startsAtMs);
};
