import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanReservationSegmentV1,
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import { isMeaningfullyCheaper } from './bucketAllocation';
import { roundKWh } from './activePlanMath';

const ONE_HOUR_MS = 60 * 60 * 1000;
// Mirrors the planner's booked-energy epsilon: a bucket the allocation booked
// essentially nothing into is not a real deferral target.
const PLANNED_EPSILON_KWH = 0.001;

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
  const byHour = new Map<number, {
    plannedKWh: number;
    plannedAdmissionPowerKw: number;
    earliestStartMs: number;
  }>();
  for (const bucket of horizonPlan.plannedBuckets) {
    if (bucket.plannedUsefulEnergyKWh <= 0) continue;
    const hourStart = Math.floor(bucket.startMs / ONE_HOUR_MS) * ONE_HOUR_MS;
    const existing = byHour.get(hourStart);
    if (existing) {
      existing.plannedKWh += bucket.plannedUsefulEnergyKWh;
      existing.plannedAdmissionPowerKw = Math.max(
        existing.plannedAdmissionPowerKw,
        bucket.plannedAdmissionPowerKw ?? 0,
      );
      existing.earliestStartMs = Math.min(existing.earliestStartMs, bucket.startMs);
    } else {
      byHour.set(hourStart, {
        plannedKWh: bucket.plannedUsefulEnergyKWh,
        plannedAdmissionPowerKw: bucket.plannedAdmissionPowerKw ?? 0,
        earliestStartMs: bucket.startMs,
      });
    }
  }
  const hours = [...byHour.entries()]
    .map(([startsAtMs, { plannedKWh, plannedAdmissionPowerKw, earliestStartMs }]) => ({
      startsAtMs,
      plannedKWh: roundKWh(plannedKWh),
      ...(plannedAdmissionPowerKw > 0 ? { plannedAdmissionPowerKw } : {}),
      // When the earliest bucket folded into this hour starts after the hour
      // boundary, the planner trimmed it to `nowMs` (the current hour on a
      // mid-hour cycle), so `plannedKWh` is already only the post-trim
      // remainder covering `[earliestStartMs, hourEnd]`. Record that so the
      // history chart does not prorate an already-trimmed value. A full hour
      // (earliest bucket hour-aligned) leaves `coversFromMs` absent.
      ...(earliestStartMs > startsAtMs ? { coversFromMs: earliestStartMs } : {}),
    }))
    .sort((left, right) => left.startsAtMs - right.startsAtMs);
  // Milestones are NOT stamped here: they must reflect the committed kWh AFTER
  // `mergeHoursPreservingCommitment` applies its floors (an earlier hour's kWh can
  // win the Math.max, which raises the cumulative for downstream hours). The
  // recorder calls `stampUnitMilestones` on the merged `effectiveHours` instead.
  return hours;
};

const segmentHourStart = (segment: Pick<DeferredObjectiveActivePlanReservationSegmentV1, 'startMs'>): number => (
  Math.floor(segment.startMs / ONE_HOUR_MS) * ONE_HOUR_MS
);

export const buildLiveReservationSegments = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanReservationSegmentV1[] => (
  (diag.horizonPlan?.plannedBuckets ?? []).flatMap((bucket) => {
    if (bucket.plannedUsefulEnergyKWh <= PLANNED_EPSILON_KWH) return [];
    const durationHours = (bucket.endMs - bucket.startMs) / ONE_HOUR_MS;
    if (durationHours <= 0) return [];
    const admissionPowerKw = bucket.plannedAdmissionPowerKw ?? (
      bucket.plannedUsefulEnergyKWh / durationHours
    );
    if (!Number.isFinite(admissionPowerKw) || admissionPowerKw <= 0) return [];
    return [{
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      plannedKWh: bucket.plannedUsefulEnergyKWh,
      plannedAdmissionPowerKw: admissionPowerKw,
      sourceBucketId: bucket.sourceBucketId,
    }];
  })
);

const scaleSegmentsToHour = (params: {
  segments: readonly DeferredObjectiveActivePlanReservationSegmentV1[];
  hour: DeferredObjectiveActivePlanHourV1;
}): DeferredObjectiveActivePlanReservationSegmentV1[] => {
  const totalKWh = params.segments.reduce((sum, segment) => sum + segment.plannedKWh, 0);
  if (totalKWh <= 0 || params.hour.plannedKWh <= PLANNED_EPSILON_KWH) return [];
  return params.segments.map((segment) => ({
    ...segment,
    plannedKWh: segment.plannedKWh * params.hour.plannedKWh / totalKWh,
  }));
};

const totalSegmentKWh = (
  segments: readonly DeferredObjectiveActivePlanReservationSegmentV1[],
): number => segments.reduce((sum, segment) => sum + segment.plannedKWh, 0);

const segmentsOverlap = (
  left: DeferredObjectiveActivePlanReservationSegmentV1,
  right: DeferredObjectiveActivePlanReservationSegmentV1,
): boolean => left.startMs < right.endMs && left.endMs > right.startMs;

const overlayLiveAdmissionPower = (params: {
  previous: readonly DeferredObjectiveActivePlanReservationSegmentV1[];
  live: readonly DeferredObjectiveActivePlanReservationSegmentV1[];
}): DeferredObjectiveActivePlanReservationSegmentV1[] => params.previous.map((previous) => {
  let matchingLiveAdmissionPowerKw = 0;
  for (const live of params.live) {
    const sameSource = previous.sourceBucketId === undefined
      || live.sourceBucketId === undefined
      || previous.sourceBucketId === live.sourceBucketId;
    if (!sameSource || !segmentsOverlap(previous, live)) continue;
    matchingLiveAdmissionPowerKw = Math.max(
      matchingLiveAdmissionPowerKw,
      live.plannedAdmissionPowerKw,
    );
  }
  return matchingLiveAdmissionPowerKw > previous.plannedAdmissionPowerKw
    ? { ...previous, plannedAdmissionPowerKw: matchingLiveAdmissionPowerKw }
    : previous;
});

const selectExactSegmentsForHour = (params: {
  hour: DeferredObjectiveActivePlanHourV1;
  live: readonly DeferredObjectiveActivePlanReservationSegmentV1[];
  previous: readonly DeferredObjectiveActivePlanReservationSegmentV1[];
}): readonly DeferredObjectiveActivePlanReservationSegmentV1[] => {
  if (params.live.length === 0) return params.previous;
  if (params.previous.length === 0) {
    // A legacy hour may carry a full-hour commitment floor but have no exact
    // segment shape yet. A late-hour live plan covers only the remaining
    // minutes; scaling the full floor into that short interval would fabricate
    // an extreme physical claim. Fall through to the synthetic full-hour shape
    // when the live energy cannot represent the committed floor.
    return params.hour.plannedKWh > totalSegmentKWh(params.live) + PLANNED_EPSILON_KWH
      ? []
      : params.live;
  }
  const liveDistance = Math.abs(totalSegmentKWh(params.live) - params.hour.plannedKWh);
  const previousDistance = Math.abs(totalSegmentKWh(params.previous) - params.hour.plannedKWh);
  // A tie means the commitment floor did not need new topology. Retaining the
  // prior exact shape avoids turning the moving current-hour trim into a new
  // persisted physical claim on every settle. Fresh admission power is still
  // authoritative for the unelapsed overlap: a step increase must immediately
  // reserve the larger physical draw for lower-priority tasks and restarts.
  return previousDistance <= liveDistance
    ? overlayLiveAdmissionPower({ previous: params.previous, live: params.live })
    : params.live;
};

// Persist the allocator's exact source-bucket geometry alongside the legacy
// hour-aligned schedule. `effectiveHours` may carry a commitment floor, so its
// authoritative per-hour kWh is projected onto whichever exact topology won
// that floor; every segment keeps its own physical admission power. If the live
// plan dropped a floored hour entirely, retain that hour's prior exact topology;
// only legacy revisions with no exact shape fall back to a clipped synthetic
// hour segment whose hourly admission is necessarily conservative.
export const buildReservationSegmentsFromHorizonPlan = (params: {
  diag: DeferredObjectiveDiagnostic;
  effectiveHours: readonly DeferredObjectiveActivePlanHourV1[];
  previousSegments?: readonly DeferredObjectiveActivePlanReservationSegmentV1[];
}): DeferredObjectiveActivePlanReservationSegmentV1[] => {
  const liveSegments = buildLiveReservationSegments(params.diag);
  const previousSegments = params.previousSegments ?? [];
  return params.effectiveHours.flatMap((hour) => {
    if (hour.plannedKWh <= PLANNED_EPSILON_KWH) return [];
    const liveForHour = liveSegments.filter((segment) => segmentHourStart(segment) === hour.startsAtMs);
    const previousForHour = previousSegments.filter((segment) => segmentHourStart(segment) === hour.startsAtMs);
    const exactSegments = selectExactSegmentsForHour({
      hour,
      live: liveForHour,
      previous: previousForHour,
    });
    if (exactSegments.length > 0) return scaleSegmentsToHour({ segments: exactSegments, hour });
    const startMs = hour.coversFromMs ?? hour.startsAtMs;
    const endMs = Math.min(hour.startsAtMs + ONE_HOUR_MS, params.diag.deadlineAtMs ?? Number.POSITIVE_INFINITY);
    if (endMs <= startMs) return [];
    const durationHours = (endMs - startMs) / ONE_HOUR_MS;
    const admissionPowerKw = hour.plannedAdmissionPowerKw ?? hour.plannedKWh / durationHours;
    return [{ startMs, endMs, plannedKWh: hour.plannedKWh, plannedAdmissionPowerKw: admissionPowerKw }];
  });
};

// Resolve the anchor (measured value at this revision) and the kWh-per-unit rate
// for the unit-milestone trajectory, kind-split. Null when either is unavailable
// (cold-start before a rate is learned, stale read) — the hour then omits
// `plannedUnitMilestone` and the gate falls back to its energy comparison.
//
// The rate is the BUFFERED per-unit rate (`energyNeededKWh / remainingUnits`,
// producer-resolved as `kWhPerUnitBuffered`) — the same buffered currency the
// hour's `plannedKWh` is booked in. Converting buffered planned energy at the
// mean rate (`kWhPerUnitBanded`, which is `energyExpectedKWh /
// remainingUnits`) would overshoot the cumulative milestone by the buffer ratio,
// leaving the final milestone above target and making `isAheadOfHourMilestone`
// under-fire (the device under-defers). Falls back to the mean rate when the
// buffered rate is absent (legacy diagnostics / bootstrap, where the two coincide
// so the result is unchanged).
const resolveUnitTrajectoryAnchor = (
  diag: DeferredObjectiveDiagnostic,
): { anchorUnit: number; ratePerUnit: number } | null => {
  const anchorUnit = diag.currentValue;
  const meanRatePerUnit = diag.kWhPerUnitBanded;
  const bufferedRatePerUnit = diag.kWhPerUnitBuffered;
  const ratePerUnit = typeof bufferedRatePerUnit === 'number' && Number.isFinite(bufferedRatePerUnit)
    && bufferedRatePerUnit > 0
    ? bufferedRatePerUnit
    : meanRatePerUnit;
  if (typeof anchorUnit !== 'number' || !Number.isFinite(anchorUnit)) return null;
  if (typeof ratePerUnit !== 'number' || !Number.isFinite(ratePerUnit) || ratePerUnit <= 0) return null;
  return { anchorUnit, ratePerUnit };
};

// Stamp each hour with the cumulative target progress (in the objective's unit)
// the plan expects by the END of that hour — `plannedUnitMilestone` in the
// contract — so the mid-execution gate compares the live measured value against an
// absolute target without dividing committed energy by a drifting live rate.
//
// Each hour's milestone is FROZEN when the hour is first committed and is NEVER
// re-anchored afterward. Re-anchoring a committed hour at the live measured value
// would double-count the progress already delivered within that hour (the live
// reading already includes it). So this:
//   - keeps any hour that already carries a milestone (committed at an earlier
//     revision — `mergeHoursPreservingCommitment` carries it via `{ ...c }`),
//   - stamps only genuinely-NEW hours (expansion adds, or the very first commit),
//     accumulating each on top of the last frozen milestone so the staircase
//     reflects the MERGED (floored) committed energy of the earlier hours — and
//     seeds the first hour of a brand-new plan at the live measured anchor.
// Elapsed hours are left untouched (their milestone is history) but still advance
// the running base so a later hour after a gap accumulates correctly.
export const stampUnitMilestones = (
  hours: DeferredObjectiveActivePlanHourV1[],
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
): DeferredObjectiveActivePlanHourV1[] => {
  const anchor = resolveUnitTrajectoryAnchor(diag);
  if (!anchor) return hours;
  const currentHourStartMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
  let lastMilestone: number | null = null;
  return [...hours]
    .sort((left, right) => left.startsAtMs - right.startsAtMs)
    .map((hour) => {
      const existing = hour.plannedUnitMilestone;
      const hasExisting = typeof existing === 'number' && Number.isFinite(existing);
      // Keep a frozen milestone (elapsed or already-committed hour); advance base.
      if (hasExisting) {
        lastMilestone = existing;
        return hour;
      }
      // Elapsed hour with no milestone (legacy) — leave it, don't fabricate history.
      if (hour.startsAtMs < currentHourStartMs) return hour;
      // New current/future hour: build on the last frozen milestone, or seed the
      // very first hour of a brand-new plan at the live measured anchor.
      const base = lastMilestone ?? anchor.anchorUnit;
      lastMilestone = base + hour.plannedKWh / anchor.ratePerUnit;
      return { ...hour, plannedUnitMilestone: lastMilestone };
    });
};

// Stamp each committed hour with `cheaperHourAhead` — whether a meaningfully-
// cheaper, booked, non-reserve hour exists strictly LATER in the live plan than
// this hour. Resolved here in the producer (at the `:58` settle, alongside the
// unit milestone) to a flat boolean, so the per-power-cycle release path can read
// it off the current hour instead of re-scanning a live price series every cycle
// (`feedback_layering_resolution_in_producer`; the two-clock model in
// notes/deferred-load-objectives/execution-adaptation.md).
//
// FROZEN per hour like `plannedUnitMilestone`: an hour that already carries the
// flag (committed at an earlier revision, carried through the merge via `{ ...c }`)
// keeps it; only genuinely-new hours are computed from the current plan's bucket
// prices. The comparison reuses `isMeaningfullyCheaper` — the same relative band
// the build-time allocator and the live price-deferral gate use — so "worth
// shifting load" stays consistent across all three. An hour the live plan carries
// no comparable price for is left unstamped (consumer reads absence as `false`).
export const stampCheaperHourAhead = (
  hours: DeferredObjectiveActivePlanHourV1[],
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanHourV1[] => {
  const horizonPlan = diag.horizonPlan;
  if (!horizonPlan) return hours;
  const buckets = horizonPlan.plannedBuckets;
  // Reference price per hour-aligned slot: the earliest covering bucket's price
  // (buckets may be split sub-hour at `nowMs`/`planningEndMs`; segments of one
  // hour share the source price).
  const priceByHour = new Map<number, number>();
  for (const bucket of buckets) {
    if (typeof bucket.price !== 'number' || !Number.isFinite(bucket.price)) continue;
    const hourStart = Math.floor(bucket.startMs / ONE_HOUR_MS) * ONE_HOUR_MS;
    if (!priceByHour.has(hourStart)) priceByHour.set(hourStart, bucket.price);
  }
  return hours.map((hour) => {
    if (typeof hour.cheaperHourAhead === 'boolean') return hour; // frozen at booking
    const thisPrice = priceByHour.get(hour.startsAtMs);
    if (typeof thisPrice !== 'number') return hour; // no comparable price ⇒ leave absent
    const cheaperAhead = buckets.some((bucket) => (
      !bucket.reserve
      && Math.floor(bucket.startMs / ONE_HOUR_MS) * ONE_HOUR_MS > hour.startsAtMs
      && bucket.plannedUsefulEnergyKWh > PLANNED_EPSILON_KWH
      && isMeaningfullyCheaper(bucket.price, thisPrice)
    ));
    return { ...hour, cheaperHourAhead: cheaperAhead };
  });
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
    if (a[i].startsAtMs !== b[i].startsAtMs) return false;
  }
  return true;
};

// Coordination-sensitive equality. Lower-priority commitments may need a
// rewrite even when their hour set is unchanged: a higher task can alter the
// kWh left in an hour or the physical step reservation lower tasks expose to
// tasks behind them.
export const samePriorityAllocation = (
  a: readonly DeferredObjectiveActivePlanHourV1[],
  b: readonly DeferredObjectiveActivePlanHourV1[],
): boolean => {
  if (!sameHourSchedule(a, b)) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].plannedKWh !== b[i].plannedKWh) return false;
    if ((a[i].plannedAdmissionPowerKw ?? 0) !== (b[i].plannedAdmissionPowerKw ?? 0)) return false;
  }
  return true;
};

const sameAdmissionAllocation = (
  a: readonly DeferredObjectiveActivePlanHourV1[],
  b: readonly DeferredObjectiveActivePlanHourV1[],
): boolean => {
  if (!sameHourSchedule(a, b)) return false;
  for (let i = 0; i < a.length; i += 1) {
    if ((a[i].plannedAdmissionPowerKw ?? 0) !== (b[i].plannedAdmissionPowerKw ?? 0)) return false;
  }
  return true;
};

export const resolveCoordinatedScheduleUpdate = (params: {
  diag: DeferredObjectiveDiagnostic;
  objectiveChanged: boolean;
  committedHours: readonly DeferredObjectiveActivePlanHourV1[];
  latest: DeferredObjectiveActivePlanRevisionV1;
  liveHours: DeferredObjectiveActivePlanHourV1[];
  nowMs: number;
  metadataDrifted: boolean;
}): {
  replaceCommitment: boolean;
  effectiveHours: DeferredObjectiveActivePlanHourV1[];
  scheduleChanged: boolean;
  metadataDriftedWithinSchedule: boolean;
} => {
  const replaceCommitment = [
    params.objectiveChanged,
    params.diag.replaceCommitment === true,
  ].includes(true);
  const mergedHours = replaceCommitment
    ? params.liveHours
    : mergeHoursPreservingCommitment(params.committedHours, params.liveHours, params.nowMs);
  const effectiveHours = stampCheaperHourAhead(
    stampUnitMilestones(mergedHours, params.diag, params.nowMs),
    params.diag,
  );
  const scheduleChanged = !sameHourSchedule(params.latest.hours, effectiveHours);
  const priorityAllocationChanged = !samePriorityAllocation(params.latest.hours, effectiveHours);
  const coordinatedAllocationChanged = !sameAdmissionAllocation(params.latest.hours, effectiveHours)
    || (params.diag.replaceCommitment === true && priorityAllocationChanged);
  const metadataDriftedWithinSchedule = !scheduleChanged && [
    params.latest.allocationContextSignature !== params.diag.allocationContextSignature,
    coordinatedAllocationChanged,
    params.metadataDrifted,
  ].includes(true);
  return { replaceCommitment, effectiveHours, scheduleChanged, metadataDriftedWithinSchedule };
};

// Merge live horizon hours into the existing commitment. The recorder bypasses
// this helper for an explicit priority-coordination replacement; all ordinary
// replan paths retain the no-shrink rules below.
//
// The committed schedule is the task's contract (which hour-aligned hours it
// will run). Each plan cycle the live horizon plan is merged in.
//
// We split `committed` relative to the ACTUAL current hour
// (`floor(nowMs / ONE_HOUR_MS)`), NOT relative to the live plan's earliest
// hour. The horizon allocator is a price optimizer
// (`bucketAllocation.ts` sorts by reserve→relative-price-band→time, and
// `buildHoursFromHorizonPlan` DROPS every bucket with
// `plannedUsefulEnergyKWh <= 0`), so when near-term hours are relatively
// expensive they are allocated 0 kWh and vanish from the
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
  // (no-shrink invariant). An EARLY-SATISFIED task hits this branch every
  // cycle: once the target is reached `energyNeededKWh` is 0, the horizon
  // allocator emits no positive buckets, and `buildHoursFromHorizonPlan`
  // returns `[]`, so the merge preserves the full committed schedule. This is
  // intentional and benign — the executor acts on the LIVE plan + device state
  // (a satisfied device is at target, so nothing charges), never on these
  // persisted committed hours, and the lifecycle controller ends the task
  // shortly after satisfaction. The preserved hours are the run's historical
  // plan, not a standing commitment to keep charging. (Verified, no concrete
  // effect found — do not re-flag as "stale committed hours".)
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
    // Take the floor that wins the `Math.max` *whole*, so coverage follows the
    // energy: when the committed hour wins, its `coversFromMs` (absent ⇒ full
    // hour) replaces the live hour's trimmed `coversFromMs`. Keeping the live
    // trimmed coverage with the committed full energy would mislabel a full-hour
    // floor as a sub-hour span and suppress proration in the chart. Ties go to
    // the committed hour (`>=`): when a trimmed live current-hour bucket rounds
    // back to the committed full-hour kWh (or the device made no measurable
    // progress), the committed full-hour coverage is the correct one to keep so
    // the chart still prorates the elapsed part. When the live hour strictly
    // wins (fresh/grown), it keeps its own coverage.
    const winner = c.plannedKWh >= liveHour.plannedKWh ? { ...c } : liveHour;
    const plannedAdmissionPowerKw = Math.max(
      c.plannedAdmissionPowerKw ?? 0,
      liveHour.plannedAdmissionPowerKw ?? 0,
    );
    return plannedAdmissionPowerKw > 0 ? { ...winner, plannedAdmissionPowerKw } : winner;
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
