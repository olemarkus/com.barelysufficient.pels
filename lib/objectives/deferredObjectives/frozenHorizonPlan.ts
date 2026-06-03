import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanStatusV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { selectMinimumStepForEnergy } from './stepSelection';
import type {
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveHorizonStatus,
  DeferredObjectiveHorizonStatusDetail,
  DeferredObjectiveKind,
  DeferredObjectivePlannedBucket,
  DeferredObjectiveStep,
} from './types';

const ONE_HOUR_MS = 60 * 60 * 1000;

// Representative `statusDetail` for a frozen status. Mid-hour the diagnostic's
// `reasonCode` (derived from this) is NOT persisted (the recorder only writes at
// the `:58` settle, recomputing the authoritative detail) and admission gates on
// the status, not the detail — so a status-aligned neutral detail is sufficient.
const FROZEN_STATUS_DETAIL: Record<DeferredObjectiveHorizonStatus, DeferredObjectiveHorizonStatusDetail> = {
  on_track: 'planned_with_margin',
  at_risk: 'planned_using_deadline_reserve',
  cannot_meet: 'target_cannot_be_met',
  satisfied: 'energy_already_met',
  invalid: 'invalid_energy',
};

// The frozen read is only reached when the device is committed AND
// `remainingUnits > 0` (genuine `satisfied` already returned via the early
// `remainingUnits <= 0` branch). So for ADMISSION the device is plannable BY
// CONSTRUCTION — we never reconstruct feasibility mid-hour. We therefore coerce a
// non-plannable persisted status to `on_track`: a persisted `satisfied`/`invalid`
// here is the STALL-reported override (903f9745 — UI/Flows only) or stale, and
// admission must NOT release on it. The REPORTING path stays correct because the
// top-level `resolveStallReportedStatus` re-derives `satisfied` from the live stall
// classification; `at_risk`/`cannot_meet` pass through unchanged (hour-boundary-
// paced from the persisted `:58` value, so no mid-hour churn).
const PLANNABLE_PLAN_STATUSES = new Set<DeferredObjectiveActivePlanStatusV1>([
  'on_track', 'at_risk', 'cannot_meet',
]);
const toPlannableStatus = (planStatus: DeferredObjectiveActivePlanStatusV1): DeferredObjectiveHorizonStatus => (
  PLANNABLE_PLAN_STATUSES.has(planStatus) ? planStatus : 'on_track'
);

// Current + future committed hours become the planned buckets (elapsed hours are
// history). Each bucket is a FULL committed hour `[startsAtMs, startsAtMs+1h]` — we
// do NOT trim the current hour's start to `nowMs`: the frozen read carries the
// committed full-hour energy at the committed (floor) step, so the bucket stays
// internally consistent (energy = step power × 1 h) and the requested step
// recovers the committed floor step rather than escalating as the remaining hour
// shrinks (mid-hour escalation is the per-cycle re-plan the two-clock model removes;
// the executor still climbs opportunistically when behind, and the `:58` settle
// re-plans genuine shortfalls). `sourceBucketId` matches the allocator's
// hour-aligned ISO convention so plannedBuckets read identically fresh-vs-frozen.
const buildFrozenPlannedBuckets = (
  futureHours: readonly DeferredObjectiveActivePlanHourV1[],
  currentHourStartMs: number,
): DeferredObjectivePlannedBucket[] => futureHours.map((hour) => ({
  id: `frozen-${hour.startsAtMs}`,
  sourceBucketId: new Date(hour.startsAtMs).toISOString(),
  startMs: hour.startsAtMs,
  endMs: hour.startsAtMs + ONE_HOUR_MS,
  durationHours: 1,
  price: null,
  reserve: false,
  current: hour.startsAtMs === currentHourStartMs,
  usefulEnergyCapacityKWh: hour.plannedKWh,
  plannedUsefulEnergyKWh: hour.plannedKWh,
}));

// Price-deferral release, reusing the SAME frozen `cheaperHourAhead` the producer
// stamped at `:58` — no live price series rescanned. A booked current hour is
// released when the device is already ahead of its milestone AND a cheaper hour is
// booked ahead. A 0-booked current hour is already released by admission's
// `plannedUsefulEnergyKWh ≤ 0` branch.
//
// Cold-start release is NOT a mid-hour decision at all: "should the expensive
// current hour be booked, or deferred into the cheaper window?" is the allocator's
// `:58` call, recorded in the committed current-hour kWh (0 ⇒ deferred). The frozen
// read just delivers up to whatever the commitment booked (current hour 0 ⇒ idle),
// so it never asserts `coldStartReleaseEligible`.
const resolveFrozenPriceDeferralEligible = (params: {
  currentBooked: boolean;
  cheaperHourAhead: boolean;
  aheadOfHourMilestone: boolean;
}): boolean => params.currentBooked && params.cheaperHourAhead && params.aheadOfHourMilestone;

// Build a `DeferredObjectiveHorizonPlan` from the PERSISTED commitment + live
// inputs, WITHOUT running the bucket allocator. Used on the per-cycle (mid-hour)
// path: between hour settles the booked set, per-hour kWh, unit milestones and
// `cheaperHourAhead` are immutable, so the only live inputs are the measured value
// (already folded into `aheadOfHourMilestone` by the producer) and the persisted
// status. The allocator runs only at the `:58` settle and at bootstrap (no
// commitment), where a fresh plan is genuinely needed (the recorder re-commits).
//
// Release decision is the pure frozen read the design targets:
//   - released ⟺ current hour booked 0 (idle) — admission's existing
//     `plannedUsefulEnergyKWh ≤ 0` branch handles it, OR
//   - `priceDeferralEligible`  = current hour booked AND `aheadOfHourMilestone`
//     AND this hour's frozen `cheaperHourAhead`, OR
//   - `coldStartReleaseEligible` = current hour booked AND temperature AND this
//     hour's frozen `cheaperHourAhead` AND NOT ahead (the cold catch-up case:
//     the device is behind but a cheaper window can carry the load).
// Both reuse the SAME frozen `cheaperHourAhead` the producer stamped at `:58`
// (`feedback_layering_resolution_in_producer`); no live price series is rescanned.
export const buildFrozenHorizonPlan = (params: {
  nowMs: number;
  objectiveId: string;
  objectiveKind: DeferredObjectiveKind;
  enforcement: DeferredObjectiveHorizonPlan['enforcement'];
  deadlineAtMs: number;
  deadlineMarginMs: number;
  committedHours: readonly DeferredObjectiveActivePlanHourV1[];
  planStatus: DeferredObjectiveActivePlanStatusV1;
  energyNeededKWh: number;
  aheadOfHourMilestone: boolean;
  steps: DeferredObjectiveStep[];
  epsilonKWh: number;
}): DeferredObjectiveHorizonPlan => {
  const {
    nowMs, objectiveId, objectiveKind, enforcement, deadlineAtMs, deadlineMarginMs,
    committedHours, planStatus, energyNeededKWh, aheadOfHourMilestone, steps, epsilonKWh,
  } = params;
  const currentHourStartMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
  const currentHour = committedHours.find((hour) => hour.startsAtMs === currentHourStartMs) ?? null;
  const futureHours = committedHours
    .filter((hour) => hour.startsAtMs >= currentHourStartMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs);
  const plannedBuckets = buildFrozenPlannedBuckets(futureHours, currentHourStartMs);

  const currentBookedKWh = currentHour?.plannedKWh ?? 0;
  const requestedStep = currentHour
    ? selectMinimumStepForEnergy({ steps, energyKWh: currentBookedKWh, durationHours: 1, epsilonKWh })
    : null;
  const currentBucket = currentHour
    ? {
      bucketId: `frozen-${currentHourStartMs}`,
      sourceBucketId: new Date(currentHourStartMs).toISOString(),
      plannedUsefulEnergyKWh: currentBookedKWh,
      expectedStepId: requestedStep?.id ?? null,
    }
    : null;

  const priceDeferralEligible = resolveFrozenPriceDeferralEligible({
    currentBooked: currentBookedKWh > epsilonKWh,
    cheaperHourAhead: currentHour?.cheaperHourAhead === true,
    aheadOfHourMilestone,
  });

  const status = toPlannableStatus(planStatus);
  const plannedUsefulEnergyKWh = futureHours.reduce((sum, hour) => sum + Math.max(0, hour.plannedKWh), 0);

  return {
    objectiveId,
    kind: objectiveKind,
    enforcement,
    status,
    statusDetail: FROZEN_STATUS_DETAIL[status],
    horizonStartMs: nowMs,
    horizonEndMs: deadlineAtMs,
    planningEndMs: Math.max(nowMs, deadlineAtMs - deadlineMarginMs),
    deadlineMarginMs,
    energyNeededKWh,
    plannedUsefulEnergyKWh,
    // Shortfall estimate from frozen state (live buffered need minus the committed
    // current+future energy); the authoritative value is recomputed at the `:58`
    // settle. Keeps a `cannot_meet`/`at_risk` plan from reporting a 0 kWh shortfall.
    unplannedUsefulEnergyKWh: Math.max(0, energyNeededKWh - plannedUsefulEnergyKWh),
    expectedStepId: currentBucket?.expectedStepId ?? null,
    currentBucket,
    plannedBuckets,
    // Representative, kept consistent with the (representative) `statusDetail`; the
    // exact reason is recomputed and persisted at `:58` (mid-hour this is not an
    // admission input — admission gates on `status`, not the detail/reserve flag).
    usesDeadlineReserve: status === 'at_risk',
    priceDeferralEligible,
    // Cold-start is the allocator's `:58` booking decision (current hour booked 0 ⇒
    // deferred); the frozen read never asserts it mid-hour.
    coldStartReleaseEligible: false,
  };
};
