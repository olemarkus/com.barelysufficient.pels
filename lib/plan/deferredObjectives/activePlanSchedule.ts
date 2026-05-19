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
// (target met — no plan to notify about); a `cannot_meet` or `invalid`
// collapse fires so automations see "your plan blew up" even when the
// planner stays in the same status across a statusDetail worsening.
export const shouldFireNotification = (
  previousHourCount: number,
  nextHourCount: number,
  planStatus: DeferredObjectiveActivePlanRevisionV1['planStatus'],
): boolean => {
  if (previousHourCount === nextHourCount) return false;
  if (nextHourCount > 0) return true;
  return planStatus === 'cannot_meet' || planStatus === 'invalid';
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
