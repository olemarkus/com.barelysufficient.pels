import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
  DeferredObjectivePlanInterval,
  DeferredObjectiveActivePlanStatusV1,
  DeferredObjectivePartialPriceSchedule,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  resolveRemainingPlannedKWh, scheduledTaskIntervals,
} from '../../../packages/shared-domain/src/deferredPlanBookedHours';
import { resolveCurrentHourBooking, resolveCurrentHourClaim } from './currentHourClaim';
import { selectMinimumStepForEnergy } from './stepSelection';
import { servePartialPriceSchedule } from './partialPriceSchedule';
import type { ScheduledDeferredObjective } from './priorityAllocation';
import type { DeferredObjectiveEnergyResolution } from './profileEnergyResolution';
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
  hours: readonly DeferredObjectivePlanInterval[];
  // When within those hours the booked energy is due: the settled revision's exact
  // segments (`latest.reservationSegments`), one per allocator bucket that booked
  // energy. A revision saved before exact segments resolves at the boundary to one
  // window per booked hour. An hour shared with a higher-priority booking carries
  // a window over only its own part, so the frozen read promises energy where the
  // fresh allocation did and nowhere else in the hour.
  drawWindows: readonly FrozenDrawWindow[];
  partialPriceSchedule?: DeferredObjectivePartialPriceSchedule;
};

export type FrozenDrawWindow = { startMs: number; endMs: number; plannedKWh: number };

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

// The frozen read serves committed tasks with remaining work. A persisted
// `satisfied`/`invalid` verdict can be a stall overlay or stale, so admission
// starts from the plannable `on_track` posture. The diagnostic still resolves
// satisfaction from live evidence. Other settled statuses survive the replay.
const PLANNABLE_PLAN_STATUSES = new Set<DeferredObjectiveActivePlanStatusV1>([
  'on_track', 'at_risk', 'cannot_meet',
]);
const toPlannableStatus = (planStatus: DeferredObjectiveActivePlanStatusV1): DeferredObjectiveHorizonStatus => (
  PLANNABLE_PLAN_STATUSES.has(planStatus) ? planStatus : 'on_track'
);

const updateFallbackFeasibility = (
  plan: DeferredObjectiveHorizonPlan,
  frozenRead: FrozenReadInputs,
  expectedEnergyKWh: number,
  steps: readonly DeferredObjectiveStep[],
): DeferredObjectiveHorizonPlan => {
  const fallbackStartMs = frozenRead.partialPriceSchedule?.fallbackStartsAtMs;
  if (fallbackStartMs === undefined || fallbackStartMs > plan.horizonStartMs) return plan;
  if (plan.status === 'cannot_meet' || plan.budgetContributedToShortfall) return plan;
  const maximumUsefulPowerKw = Math.max(0, ...steps.map((step) => step.usefulPowerKw));
  if (maximumUsefulPowerKw <= 0) return plan;
  // Use the mean-based need so estimation padding alone cannot make it impossible.
  const remainingHours = (plan.horizonEndMs - plan.horizonStartMs) / ONE_HOUR_MS;
  if (expectedEnergyKWh > maximumUsefulPowerKw * remainingHours + FROZEN_EPSILON_KWH) {
    return { ...plan, status: 'cannot_meet', statusDetail: 'target_cannot_be_met' };
  }
  if (plan.status !== 'on_track') return plan;
  let scheduledKWh = 0;
  for (const interval of scheduledTaskIntervals(frozenRead)) {
    scheduledKWh += resolveRemainingPlannedKWh(interval, plan.horizonStartMs, plan.horizonEndMs);
  }
  return plan.energyNeededKWh > scheduledKWh + FROZEN_EPSILON_KWH
    ? { ...plan, status: 'at_risk', statusDetail: 'feasible_above_floor' } : plan;
};

// Replay exact saved coverage and its energy. The requested step comes from
// the saved draw window's whole duration, never the shrinking time remaining;
// passing a quarter boundary changes the current booking without reallocation.
const buildFrozenPlannedBuckets = (
  futureHours: readonly DeferredObjectivePlanInterval[],
  nowMs: number,
  prefersContinuousCharging: boolean,
): DeferredObjectivePlannedBucket[] => futureHours.map((hour) => ({
  id: `frozen-${hour.startsAtMs}`,
  sourceBucketId: new Date(hour.startsAtMs).toISOString(),
  startMs: hour.coversFromMs ?? hour.startsAtMs,
  endMs: hour.endsAtMs,
  durationHours: (hour.endsAtMs - (hour.coversFromMs ?? hour.startsAtMs)) / ONE_HOUR_MS,
  price: null,
  reserve: false,
  current: (hour.coversFromMs ?? hour.startsAtMs) <= nowMs && nowMs < hour.endsAtMs,
  usefulEnergyCapacityKWh: hour.plannedKWh,
  plannedUsefulEnergyKWh: hour.plannedKWh,
  plannedAdmissionPowerKw: hour.plannedAdmissionPowerKw ?? 0,
  booked: true,
  keepCharging: prefersContinuousCharging && hour.keepCharging === true,
}));

// Build a `DeferredObjectiveHorizonPlan` from the PERSISTED commitment + live
// inputs, WITHOUT running the bucket allocator. Used on the per-cycle (mid-hour)
// path: between hour settles the booked set, per-hour kWh, unit milestones and
// `cheaperHourAhead` are immutable, so the only live inputs are the measured value
// (already folded into `aheadOfHourMilestone` by the producer) and energy need.
// Live progress can update a running fallback's feasibility without changing
// the settled claim or bookings. The allocator runs on a fresh planning turn.
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
export const buildFrozenHorizonPlan = (
  nowMs: number,
  task: Pick<ScheduledDeferredObjective, 'deviceId' | 'objective' | 'prefersContinuousCharging'>,
  frozenRead: FrozenReadInputs,
  energy: Pick<
    Extract<DeferredObjectiveEnergyResolution, { reasonCode: null }>, 'energyNeededKWh' | 'energyExpectedKWh'
  >,
  aheadOfHourMilestone: boolean,
  steps: DeferredObjectiveStep[],
): DeferredObjectiveHorizonPlan => {
  const { deviceId, objective, prefersContinuousCharging } = task;
  const { deadlineAtMs } = objective;
  const { energyNeededKWh, energyExpectedKWh } = energy;
  // Every saved hour is a booking; its kWh is what it promises, possibly 0.
  const currentHour = frozenRead.hours.find((hour) => (
    (hour.coversFromMs ?? hour.startsAtMs) <= nowMs && nowMs < hour.endsAtMs
  )) ?? null;
  const futureHours = frozenRead.hours
    .filter((hour) => hour.endsAtMs > nowMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs);
  const plannedBuckets = buildFrozenPlannedBuckets(futureHours, nowMs, prefersContinuousCharging);

  // The current bucket is the saved window that covers now, as the fresh allocation's
  // current bucket was: its energy over its own duration, so the requested step
  // recovers the committed step. Before the window opens, or after it closes, the
  // booked hour promises nothing here, and admission withholds escalation
  // (`admission.resolveDecision`), which keeps a lower task's boost out of the part
  // of an hour a higher-priority task reserved.
  const currentWindow = currentHour
    ? frozenRead.drawWindows.find((window) => window.startMs <= nowMs && nowMs < window.endMs)
    : undefined;
  const currentBookedKWh = currentWindow?.plannedKWh ?? 0;
  const requestedStep = currentWindow
    ? selectMinimumStepForEnergy(
      steps,
      currentWindow.plannedKWh,
      (currentWindow.endMs - currentWindow.startMs) / ONE_HOUR_MS,
      FROZEN_EPSILON_KWH,
    )
    : null;
  const currentBucket = currentHour
    ? {
      keepCharging: prefersContinuousCharging && currentHour.keepCharging === true,
      bucketId: `frozen-${currentHour.startsAtMs}`,
      sourceBucketId: new Date(currentHour.startsAtMs).toISOString(),
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

  const plan: DeferredObjectiveHorizonPlan = {
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
    // allocator reached; the current booking changes at its explicit boundary.
    currentHourClaim: resolveCurrentHourClaim(
      resolveCurrentHourBooking(currentBucket),
      currentHourFacts,
      frozenRead.floorShortfallCause,
    ),
    // Declares "no new allocation here" to the recorder — see the field doc on
    // `DeferredObjectiveHorizonPlan`.
    frozenRead: true,
  };
  if (frozenRead.partialPriceSchedule === undefined) return plan;
  const served = servePartialPriceSchedule(plan, frozenRead.partialPriceSchedule, frozenRead.floorShortfallCause);
  return updateFallbackFeasibility(served, frozenRead, energyExpectedKWh, steps);
};
