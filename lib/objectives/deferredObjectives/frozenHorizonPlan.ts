import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanStatusV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveSettingsEntry } from '../../../packages/contracts/src/deferredObjectiveSettings';
import { resolveCurrentHourBooking, resolveCurrentHourClaim } from './currentHourClaim';
import { selectMinimumStepForEnergy } from './stepSelection';
import type {
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveHorizonStatus,
  DeferredObjectiveHorizonStatusDetail,
  DeferredObjectivePlannedBucket,
  DeferredObjectiveStep,
} from './types';

const ONE_HOUR_MS = 60 * 60 * 1000;
// Metadata-only deadline reserve for the frozen plan (matches rescueReplan's
// `DEFAULT_DEADLINE_RESERVE_MS`); used for `planningEndMs`/`horizonEndMs`, which no
// frozen-path consumer reads. The `:58` settle recomputes the authoritative plan.
const FROZEN_DEADLINE_RESERVE_MS = 60 * 60 * 1000;
const FROZEN_EPSILON_KWH = 0.001;

// Frozen mid-hour metadata sourced from the coherent active committed-plan view.
// Present ⇒ the per-cycle path reads the frozen plan instead of running the
// allocator (see `buildFrozenHorizonPlan`).
export type FrozenReadInputs = {
  planStatus: DeferredObjectiveActivePlanStatusV1;
  // The settled revision's verdict on what bound the floor schedule. Read rather
  // than recomputed so the mid-hour claim (`resolveCurrentHourClaim`) stays on the
  // hour-boundary clock the two-clock design puts control decisions on. Absent on
  // revisions an older build persisted, which resolve to `'none'` — the "task can
  // finish without this hour" reading, i.e. the pre-change release posture.
  floorShortfallCause: DeferredObjectiveActivePlanFloorShortfallCause;
  // The settled revision's verdict on whether the soft daily budget had a hand
  // in the shortfall. Resolved at this boundary like the cause above it:
  // revisions an older build persisted carry no flag, which reads as `false` —
  // "the budget was not implicated", the pre-change posture.
  budgetContributedToShortfall: boolean;
  // The SETTLED revision's hours (`latest.hours`), NOT the schedule-floor
  // `commitment.hours`. A `:58` revision that refines kWh on the same hour set
  // (`rate_refined`, `measured_deviation`) updates `latest` but not `commitment`
  // (the merge only re-commits on a schedule change), so reading `commitment`
  // would serve stale energy / `cheaperHourAhead`. `latest.hours` is the
  // Math.max-merged floored plan — the freshest thing the device should follow.
  hours: readonly DeferredObjectiveActivePlanHourV1[];
};

// Representative `statusDetail` for a frozen status. This placeholder is never
// persisted: the recorder refuses to settle a replan revision from a
// frozen-served diagnostic (`isFrozenServedDiagnostic`, keyed on the plan's
// `frozenRead` marker — a settle can coincide with a frozen serve on a
// transient price-horizon gap or throughout a live step-ladder gap), and
// admission gates on the status, not the detail — so a status-aligned neutral
// detail is sufficient.
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
// top-level `withStallSatisfiedStatus` re-derives `satisfied` from the live stall
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
  plannedAdmissionPowerKw: hour.plannedAdmissionPowerKw ?? 0,
  booked: true,
}));

// Build a `DeferredObjectiveHorizonPlan` from the PERSISTED commitment + live
// inputs, WITHOUT running the bucket allocator. Used on the per-cycle (mid-hour)
// path: between hour settles the booked set, per-hour kWh, unit milestones and
// `cheaperHourAhead` are immutable, so the only live inputs are the measured value
// (already folded into `aheadOfHourMilestone` by the producer) and the persisted
// status. The allocator runs only at the `:58` settle and at bootstrap (no
// commitment), where a fresh plan is genuinely needed (the recorder re-commits).
//
// The release decision is `resolveCurrentHourClaim`'s, over the frozen facts:
//   - `cheaperHourAhead` is this hour's value as the `:58` settle stamped it
//     (`stampCheaperHourAhead`; `feedback_layering_resolution_in_producer`), so no
//     live price series is rescanned;
//   - `coldStartFeasible` is always `false`. Cold-start release is NOT a mid-hour
//     decision: "should the expensive current hour be booked, or deferred into the
//     cheaper window?" is the allocator's `:58` call, recorded in the committed
//     current-hour kWh (0 ⇒ deferred). The frozen read just delivers up to whatever
//     the commitment booked (current hour 0 ⇒ idle).
export const buildFrozenHorizonPlan = (params: {
  nowMs: number;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  frozenRead: FrozenReadInputs;
  energyNeededKWh: number;
  aheadOfHourMilestone: boolean;
  steps: DeferredObjectiveStep[];
}): DeferredObjectiveHorizonPlan => {
  const {
    nowMs, deviceId, objective, frozenRead, energyNeededKWh, aheadOfHourMilestone, steps,
  } = params;
  const { deadlineAtMs } = objective;
  const currentHourStartMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
  // Every saved hour is a booking; its kWh is what it promises, possibly 0.
  const currentHour = frozenRead.hours.find((hour) => hour.startsAtMs === currentHourStartMs) ?? null;
  const futureHours = frozenRead.hours
    .filter((hour) => hour.startsAtMs >= currentHourStartMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs);
  const plannedBuckets = buildFrozenPlannedBuckets(futureHours, currentHourStartMs);

  const currentBookedKWh = currentHour?.plannedKWh ?? 0;
  const requestedStep = currentHour
    ? selectMinimumStepForEnergy({
      steps, energyKWh: currentBookedKWh, durationHours: 1, epsilonKWh: FROZEN_EPSILON_KWH,
    })
    : null;
  const currentBucket = currentHour
    ? {
      bucketId: `frozen-${currentHourStartMs}`,
      sourceBucketId: new Date(currentHourStartMs).toISOString(),
      plannedUsefulEnergyKWh: currentBookedKWh,
      booked: true,
      expectedStepId: requestedStep?.id ?? null,
    }
    : null;

  const currentHourFacts = {
    aheadOfHourMilestone,
    cheaperHourAhead: currentHour?.cheaperHourAhead === true,
    coldStartFeasible: false,
  };

  const status = toPlannableStatus(frozenRead.planStatus);
  const plannedUsefulEnergyKWh = futureHours.reduce((sum, hour) => sum + Math.max(0, hour.plannedKWh), 0);
  const unplannedUsefulEnergyKWh = Math.max(0, energyNeededKWh - plannedUsefulEnergyKWh);

  return {
    objectiveId: `${deviceId}:${objective.kind}`,
    kind: objective.kind,
    enforcement: objective.enforcement,
    status,
    statusDetail: FROZEN_STATUS_DETAIL[status],
    // Restored from the settled revision: a frozen read reports the budget's role as
    // the settle recorded it, rather than re-probing an allocation it is
    // deliberately not re-running.
    budgetContributedToShortfall: frozenRead.budgetContributedToShortfall,
    horizonStartMs: nowMs,
    horizonEndMs: deadlineAtMs,
    planningEndMs: Math.max(nowMs, deadlineAtMs - FROZEN_DEADLINE_RESERVE_MS),
    deadlineMarginMs: FROZEN_DEADLINE_RESERVE_MS,
    energyNeededKWh,
    plannedUsefulEnergyKWh,
    // Shortfall estimate from frozen state (live buffered need minus the committed
    // current+future energy); the authoritative value is recomputed at the `:58`
    // settle. Keeps a `cannot_meet`/`at_risk` plan from reporting a 0 kWh shortfall.
    unplannedUsefulEnergyKWh,
    expectedStepId: currentBucket?.expectedStepId ?? null,
    currentBucket,
    plannedBuckets,
    // Representative, kept consistent with the (representative) `statusDetail`; the
    // exact reason is recomputed and persisted at `:58` (mid-hour this is not an
    // admission input — admission gates on `status`, not the detail/reserve flag).
    usesDeadlineReserve: status === 'at_risk',
    currentHourFacts,
    // Resolved through the SAME function as the fresh path, on the settle's
    // persisted verdict — so the mid-hour answer cannot drift from the one the
    // allocator reached, and cannot move within the hour.
    currentHourClaim: resolveCurrentHourClaim({
      currentHourBooking: resolveCurrentHourBooking(currentBucket),
      facts: currentHourFacts,
      floorShortfallCause: frozenRead.floorShortfallCause,
    }),
    // Declares "no new allocation here" to the recorder — see the field doc on
    // `DeferredObjectiveHorizonPlan`.
    frozenRead: true,
  };
};
