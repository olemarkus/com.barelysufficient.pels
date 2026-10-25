import type { TaskEvaluation } from './taskEvaluation';
import type {
  DeferredObjectivePlanInterval,
  DeferredObjectiveActivePlanReservationSegmentV1,
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import type { DeferredObjectiveHorizonPlan } from './types';
import { hasCheaperEnergyHourAhead } from './priceBand';
import { hoursWithPlannedEnergy } from '../../../packages/shared-domain/src/deferredPlanBookedHours';
import { roundKWh } from './activePlanMath';

const ONE_HOUR_MS = 60 * 60 * 1000;
// Minimum energy for a meaningful price-deferral target and the ordinary
// persisted kWh precision. Positive bookings below this still carry control
// and physical reservations until their bucket ends.
const PLANNED_EPSILON_KWH = 0.001;

// Book actual allocation coverage. Adjacent pieces of one source period may
// reunite after the deadline-reserve split; a gap or a new price stays distinct.
export const buildHoursFromHorizonPlan = (
  evaluation: TaskEvaluation,
): DeferredObjectivePlanInterval[] | null => {
  if (evaluation.planning.kind === 'inactive') return null;
  const booked: Array<{ sourceBucketId: string; interval: DeferredObjectivePlanInterval }> = [];
  const candidates = evaluation.planning.plan.plannedBuckets.filter((bucket) => bucket.booked).map((bucket) => ({
    sourceBucketId: bucket.sourceBucketId,
    interval: {
      startsAtMs: bucket.startMs,
      endsAtMs: bucket.endMs,
      plannedKWh: bucket.plannedUsefulEnergyKWh,
      ...(bucket.plannedAdmissionPowerKw ? { plannedAdmissionPowerKw: bucket.plannedAdmissionPowerKw } : {}),
    },
  }));
  // Only newly constructed bookings are coalesced; the allocation stays immutable.
  /* eslint-disable functional/immutable-data */
  for (const candidate of candidates) {
    const previous = booked.at(-1);
    const { interval } = candidate;
    if (previous && previous.sourceBucketId === candidate.sourceBucketId
      && previous.interval.endsAtMs === interval.startsAtMs
      && previous.interval.plannedAdmissionPowerKw === interval.plannedAdmissionPowerKw) {
      previous.interval.endsAtMs = interval.endsAtMs;
      previous.interval.plannedKWh += interval.plannedKWh;
    } else {
      booked.push(candidate);
    }
  }
  /* eslint-enable functional/immutable-data */
  return booked.map(({ interval }) => ({
    ...interval,
    plannedKWh: interval.plannedKWh < PLANNED_EPSILON_KWH ? interval.plannedKWh : roundKWh(interval.plannedKWh),
  }));
};

const clipSegmentToBooking = (
  segment: DeferredObjectiveActivePlanReservationSegmentV1,
  hour: DeferredObjectivePlanInterval,
): DeferredObjectiveActivePlanReservationSegmentV1[] => {
  const startMs = Math.max(segment.startMs, hour.coversFromMs ?? hour.startsAtMs);
  const endMs = Math.min(segment.endMs, hour.endsAtMs);
  if (endMs <= startMs) return [];
  if (startMs === segment.startMs && endMs === segment.endMs) return [segment];
  return [{ ...segment, startMs, endMs,
    plannedKWh: segment.plannedKWh * (endMs - startMs) / (segment.endMs - segment.startMs) }];
};

export const buildLiveReservationSegments = (
  plan: DeferredObjectiveHorizonPlan,
): DeferredObjectiveActivePlanReservationSegmentV1[] => (
  plan.plannedBuckets.flatMap((bucket) => {
    if (bucket.plannedUsefulEnergyKWh <= 0) return [];
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
  hour: DeferredObjectivePlanInterval;
}): DeferredObjectiveActivePlanReservationSegmentV1[] => {
  const totalKWh = params.segments.reduce((sum, segment) => sum + segment.plannedKWh, 0);
  if (totalKWh <= 0 || params.hour.plannedKWh <= 0) return [];
  if (totalKWh === params.hour.plannedKWh) return [...params.segments];
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
    if (!segmentsOverlap(previous, live)) continue;
    matchingLiveAdmissionPowerKw = Math.max(
      matchingLiveAdmissionPowerKw,
      live.plannedAdmissionPowerKw,
    );
  }
  return matchingLiveAdmissionPowerKw > previous.plannedAdmissionPowerKw
    ? { ...previous, plannedAdmissionPowerKw: matchingLiveAdmissionPowerKw }
    : previous;
});

const selectExactSegmentsForHour = (
  hour: DeferredObjectivePlanInterval,
  live: readonly DeferredObjectiveActivePlanReservationSegmentV1[],
  previous: readonly DeferredObjectiveActivePlanReservationSegmentV1[],
): readonly DeferredObjectiveActivePlanReservationSegmentV1[] => {
  if (live.length === 0) return previous;
  if (previous.length === 0) {
    // A legacy hour may carry a full-hour commitment floor but have no exact
    // segment shape yet. A late-hour live plan covers only the remaining
    // minutes; scaling the full floor into that short interval would fabricate
    // an extreme physical claim. Fall through to the synthetic full-hour shape
    // when the live energy cannot represent the committed floor.
    return hour.plannedKWh > totalSegmentKWh(live) + PLANNED_EPSILON_KWH
      ? []
      : live;
  }
  const liveDistance = Math.abs(totalSegmentKWh(live) - hour.plannedKWh);
  const previousDistance = Math.abs(totalSegmentKWh(previous) - hour.plannedKWh);
  // A tie means the commitment floor did not need new topology. Retaining the
  // prior exact shape avoids turning the moving current-hour trim into a new
  // persisted physical claim on every settle. Fresh admission power is still
  // authoritative for the unelapsed overlap: a step increase must immediately
  // reserve the larger physical draw for lower-priority tasks and restarts.
  return previousDistance <= liveDistance
    ? overlayLiveAdmissionPower({ previous, live })
    : live;
};

// Persist the allocator's exact source-bucket geometry alongside the legacy
// hour-aligned schedule. `effectiveHours` may carry a commitment floor, so its
// authoritative per-hour kWh is projected onto whichever exact topology won
// that floor; every segment keeps its own physical admission power. If the live
// plan dropped a floored hour entirely, retain that hour's prior exact topology;
// only legacy revisions with no exact shape fall back to a clipped synthetic
// hour segment whose hourly admission is necessarily conservative.
export const buildReservationSegmentsFromHorizonPlan = (
  diag: DeferredObjectiveDiagnostic,
  effectiveHours: readonly DeferredObjectivePlanInterval[],
  previousSegments: readonly DeferredObjectiveActivePlanReservationSegmentV1[] = [],
): DeferredObjectiveActivePlanReservationSegmentV1[] => {
  const liveSegments = diag.evaluation.planning.kind === 'allocated'
    ? buildLiveReservationSegments(diag.evaluation.planning.plan)
    : [];
  return effectiveHours.flatMap((hour) => {
    if (hour.plannedKWh <= 0) return [];
    const liveForHour = liveSegments.flatMap((segment) => clipSegmentToBooking(segment, hour));
    const previousForHour = previousSegments.flatMap((segment) => clipSegmentToBooking(segment, hour));
    const exactSegments = selectExactSegmentsForHour(hour, liveForHour, previousForHour);
    if (exactSegments.length > 0) return scaleSegmentsToHour({ segments: exactSegments, hour });
    const startMs = hour.coversFromMs ?? hour.startsAtMs;
    const endMs = Math.min(hour.endsAtMs, diag.deadlineAtMs ?? Number.POSITIVE_INFINITY);
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
// leaving the final milestone past target in its progress direction and making `isAheadOfHourMilestone`
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
  hours: DeferredObjectivePlanInterval[],
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  previous: readonly DeferredObjectivePlanInterval[],
): DeferredObjectivePlanInterval[] => {
  const anchor = resolveUnitTrajectoryAnchor(diag);
  if (!anchor || diag.progressDirection === 'unknown') return hours;
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
      if (hour.endsAtMs <= nowMs) return hour;
      // A grid split creates an intermediate edge with no saved unit target.
      // Keep its energy milestone instead of anchoring it at a later live read.
      if (previous.some((old) => old.plannedKWh > 0 && old.startsAtMs <= hour.startsAtMs
        && old.endsAtMs > hour.endsAtMs)) return hour;
      // New current/future hour: build on the last frozen milestone, or seed the
      // very first hour of a brand-new plan at the live measured anchor.
      const base = lastMilestone ?? anchor.anchorUnit;
      const signedUnits = diag.progressDirection === 'increasing' ? 1 : -1;
      lastMilestone = base + signedUnits * hour.plannedKWh / anchor.ratePerUnit;
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
// prices. The comparison is `hasCheaperEnergyHourAhead` — the same definition the
// fresh planner states for the current hour — over the relative band the
// build-time allocator also uses, so "worth shifting load" stays consistent. An hour the live plan carries
// no comparable price for is left unstamped (consumer reads absence as `false`).
export const stampCheaperHourAhead = (
  hours: DeferredObjectivePlanInterval[],
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectivePlanInterval[] => {
  const horizonPlan = diag.evaluation.planning.kind === 'allocated' ? diag.evaluation.planning.plan : null;
  if (!horizonPlan) return hours;
  const buckets = horizonPlan.plannedBuckets;
  return hours.map((hour) => {
    if (typeof hour.cheaperHourAhead === 'boolean') return hour; // frozen at booking
    const reference = buckets.find((bucket) => bucket.startMs < hour.endsAtMs
      && bucket.endMs > (hour.coversFromMs ?? hour.startsAtMs) && bucket.price !== null);
    if (!reference) return hour; // no comparable price ⇒ leave absent
    const cheaperAhead = hasCheaperEnergyHourAhead(buckets, reference, PLANNED_EPSILON_KWH);
    return { ...hour, cheaperHourAhead: cheaperAhead };
  });
};

export const resolveProjectedFinishAtMs = (
  diag: DeferredObjectiveDiagnostic,
): number | null => {
  const horizonPlan = diag.evaluation.planning.kind === 'allocated' ? diag.evaluation.planning.plan : null;
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

// User-facing notification gate. Fires when total scheduled duration changes;
// equal-duration swaps stay quiet on the Flow bus.
// Empty schedules split by intent: a `satisfied` collapse is suppressed
// (target met — no plan to notify about); a `cannot_meet`, `invalid`, or
// `at_risk` collapse fires so automations see "your plan blew up" even when the
// planner stays in the same status across a statusDetail worsening. `at_risk`
// is included because a `feasible_above_floor` verdict (floor planned nothing,
// only a step climb would fit) is the one `at_risk` case that can reach an
// empty schedule — reserve/policy at-risk always plan buckets — and an empty
// floor schedule is still a "plan blew up" event worth surfacing.
export const shouldFireNotification = (
  previousDurationHours: number,
  nextDurationHours: number,
  planStatus: DeferredObjectiveActivePlanRevisionV1['planStatus'],
): boolean => {
  if (previousDurationHours === nextDurationHours) return false;
  if (nextDurationHours > 0) return true;
  return planStatus === 'cannot_meet' || planStatus === 'invalid' || planStatus === 'at_risk';
};

// Schedule identity is time coverage. Changing the source grid or redistributing
// energy across the same covered time does not change the visible schedule.
export const sameHourSchedule = (
  a: readonly DeferredObjectivePlanInterval[],
  b: readonly DeferredObjectivePlanInterval[],
): boolean => {
  const leftCoverage = scheduleCoverage(a);
  const rightCoverage = scheduleCoverage(b);
  return leftCoverage.length === rightCoverage.length && leftCoverage.every((left, index) => {
    const right = rightCoverage[index];
    return right !== undefined && left.startsAtMs === right.startsAtMs && left.endsAtMs === right.endsAtMs;
  });
};

// Coordination-sensitive equality. Lower-priority commitments may need a
// rewrite even when their hour set is unchanged: a higher task can alter the
// kWh left in an hour or the physical step reservation lower tasks expose to
// tasks behind them.
export const samePriorityAllocation = (
  a: readonly DeferredObjectivePlanInterval[],
  b: readonly DeferredObjectivePlanInterval[],
): boolean => {
  if (a.length !== b.length || !sameHourSchedule(a, b)) return false;
  for (const [i, left] of a.entries()) {
    const right = b[i];
    if (right === undefined || left.startsAtMs !== right.startsAtMs || left.endsAtMs !== right.endsAtMs) return false;
    if (left.plannedKWh !== right.plannedKWh) return false;
    if ((left.plannedAdmissionPowerKw ?? 0) !== (right.plannedAdmissionPowerKw ?? 0)) return false;
  }
  return true;
};

const sameAdmissionAllocation = (
  a: readonly DeferredObjectivePlanInterval[],
  b: readonly DeferredObjectivePlanInterval[],
): boolean => {
  if (a.length !== b.length || !sameHourSchedule(a, b)) return false;
  for (const [i, left] of a.entries()) {
    const right = b[i];
    if (right === undefined || left.startsAtMs !== right.startsAtMs || left.endsAtMs !== right.endsAtMs) return false;
    if ((left.plannedAdmissionPowerKw ?? 0) !== (right.plannedAdmissionPowerKw ?? 0)) return false;
  }
  return true;
};

export const resolveCoordinatedScheduleUpdate = (
  diag: DeferredObjectiveDiagnostic,
  objectiveChanged: boolean,
  committedHours: readonly DeferredObjectivePlanInterval[],
  latest: DeferredObjectiveActivePlanRevisionV1,
  liveHours: DeferredObjectivePlanInterval[],
  nowMs: number,
  metadataDrifted: boolean,
): {
  replaceCommitment: boolean;
  effectiveHours: DeferredObjectivePlanInterval[];
  scheduleChanged: boolean;
  metadataDriftedWithinSchedule: boolean;
} => {
  const replaceCommitment = [
    objectiveChanged,
    diag.replaceCommitment === true,
  ].includes(true);
  const mergedHours = replaceCommitment
    ? liveHours
    : mergeHoursPreservingCommitment(committedHours, liveHours, nowMs);
  const effectiveHours = stampCheaperHourAhead(
    stampUnitMilestones(mergedHours, diag, nowMs, replaceCommitment ? [] : committedHours),
    diag,
  );
  const scheduleChanged = !sameHourSchedule(latest.hours, effectiveHours);
  const priorityAllocationChanged = !samePriorityAllocation(latest.hours, effectiveHours);
  const coordinatedAllocationChanged = !sameAdmissionAllocation(latest.hours, effectiveHours)
    || (diag.replaceCommitment === true && priorityAllocationChanged);
  const metadataDriftedWithinSchedule = !scheduleChanged && [
    latest.allocationContextSignature !== diag.allocationContextSignature,
    coordinatedAllocationChanged,
    metadataDrifted,
  ].includes(true);
  return { replaceCommitment, effectiveHours, scheduleChanged, metadataDriftedWithinSchedule };
};

// Floors promise energy over coverage, independent of the price source's grid.
// Regrid by the union of old/new boundaries, conserving each floor's energy.
// Elapsed slices remain history; a missing pending floor keeps the commitment.
export const mergeHoursPreservingCommitment = (
  committed: readonly DeferredObjectivePlanInterval[],
  live: readonly DeferredObjectivePlanInterval[],
  nowMs: number,
): DeferredObjectivePlanInterval[] => {
  const floors = hoursWithPlannedEnergy(committed);
  if (floors.length === 0) {
    return [...committed.filter((interval) => interval.endsAtMs <= nowMs), ...live]
      .sort((left, right) => left.startsAtMs - right.startsAtMs);
  }
  if (live.length === 0) return [...committed];
  const resolvedLive = retainUnsplitFloorCoverage(floors, live);
  const coverage = scheduleCoverage(resolvedLive);
  const missingFloor = floors.some((floor) => floor.endsAtMs > nowMs && !coverage.some((span) => (
    span.startsAtMs <= Math.max(nowMs, floor.coversFromMs ?? floor.startsAtMs)
      && span.endsAtMs >= floor.endsAtMs
  )));
  if (missingFloor) return [...committed];
  const retained = committed.filter((interval) => interval.plannedKWh > 0 || interval.endsAtMs <= nowMs);
  const boundaries = [...new Set([...retained, ...resolvedLive].flatMap((interval) => [
    interval.coversFromMs ?? interval.startsAtMs, interval.endsAtMs,
  ]))].sort((left, right) => left - right);
  return boundaries.slice(0, -1).flatMap((startsAtMs, index) => {
    const endsAtMs = boundaries[index + 1];
    if (endsAtMs === undefined) return [];
    const old = retained.find((interval) => (interval.coversFromMs ?? interval.startsAtMs) <= startsAtMs
      && interval.endsAtMs >= endsAtMs);
    const fresh = resolvedLive.find((interval) => (interval.coversFromMs ?? interval.startsAtMs) <= startsAtMs
      && interval.endsAtMs >= endsAtMs);
    if (!old && !fresh) return [];
    const oldEnergy = old ? intervalEnergy(old, startsAtMs, endsAtMs) : 0;
    const freshEnergy = fresh ? intervalEnergy(fresh, startsAtMs, endsAtMs) : 0;
    const winner = old && (!fresh || oldEnergy >= freshEnergy) ? old : fresh;
    if (!winner) return [];
    const admissionPower = Math.max(old?.plannedAdmissionPowerKw ?? 0, fresh?.plannedAdmissionPowerKw ?? 0);
    return [sliceBooking(winner, startsAtMs, endsAtMs, admissionPower)];
  });
};

const sliceBooking = (
  interval: DeferredObjectivePlanInterval,
  startsAtMs: number,
  endsAtMs: number,
  admissionPower: number,
): DeferredObjectivePlanInterval => {
  const { coversFromMs: _coverage, plannedUnitMilestone, ...metadata } = interval;
  return {
    ...metadata, startsAtMs, endsAtMs,
    ...(plannedUnitMilestone !== undefined && endsAtMs === interval.endsAtMs ? { plannedUnitMilestone } : {}),
    plannedKWh: intervalEnergy(interval, startsAtMs, endsAtMs),
    ...(admissionPower > 0 ? { plannedAdmissionPowerKw: admissionPower } : {}),
  };
};

// A moving `now` trims the live current period, not its already-booked energy.
// Keep the original coverage when its floor wins and no new grid boundary cuts
// it. Regridding into several periods instead uses proportional floors below.
const retainUnsplitFloorCoverage = (
  floors: readonly DeferredObjectivePlanInterval[],
  live: readonly DeferredObjectivePlanInterval[],
): DeferredObjectivePlanInterval[] => live.map((fresh) => {
  const floor = floors.find((old) => old.endsAtMs === fresh.endsAtMs
    && (old.coversFromMs ?? old.startsAtMs) <= (fresh.coversFromMs ?? fresh.startsAtMs)
    && old.plannedKWh >= fresh.plannedKWh
    && live.filter((candidate) => candidate.startsAtMs < old.endsAtMs
      && candidate.endsAtMs > (old.coversFromMs ?? old.startsAtMs)).length === 1);
  if (!floor) return fresh;
  const admissionPower = Math.max(floor.plannedAdmissionPowerKw ?? 0, fresh.plannedAdmissionPowerKw ?? 0);
  return { ...floor, ...(admissionPower > 0 ? { plannedAdmissionPowerKw: admissionPower } : {}) };
});

const intervalEnergy = (interval: DeferredObjectivePlanInterval, startMs: number, endMs: number): number => (
  interval.plannedKWh * (endMs - startMs) / (interval.endsAtMs - (interval.coversFromMs ?? interval.startsAtMs))
);

const scheduleCoverage = (
  intervals: readonly DeferredObjectivePlanInterval[],
): Array<{ startsAtMs: number; endsAtMs: number }> => {
  const coverage: Array<{ startsAtMs: number; endsAtMs: number }> = [];
  const ordered = [...intervals].sort((left, right) => left.startsAtMs - right.startsAtMs);
  // Mutate only the local coverage accumulator, never the caller's bookings.
  /* eslint-disable functional/immutable-data */
  for (const interval of ordered) {
    const startsAtMs = interval.coversFromMs ?? interval.startsAtMs;
    const previous = coverage.at(-1);
    if (previous && startsAtMs <= previous.endsAtMs) previous.endsAtMs = Math.max(previous.endsAtMs, interval.endsAtMs);
    else coverage.push({ startsAtMs, endsAtMs: interval.endsAtMs });
  }
  /* eslint-enable functional/immutable-data */
  return coverage;
};
