import {
  allocateCommittedEnergyToBuckets,
  allocateEnergyToBuckets,
  normalizeHorizonBuckets,
  type BucketAllocationResult,
  type StepForBucket,
} from './bucketAllocation';
import {
  getActiveObjectiveSteps,
  normalizeObjectiveSteps,
  resolveHighestStepWithinHeadroom,
  selectMinimumStepForEnergy,
} from './stepSelection';

import { resolveColdStartFeasible } from './coldStartRelease';
import { bookBuckets, hasCheaperEnergyHourAhead } from './priceBand';
import { needsEveryHour, resolveCurrentHourBooking, resolveCurrentHourClaim } from './currentHourClaim';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import type {
  DeferredObjectiveCurrentBucketPlan,
  DeferredObjectiveCurrentHourFacts,
  DeferredObjectiveHorizonInput,
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveHorizonStatus,
  DeferredObjectiveHorizonStatusDetail,
  DeferredObjectivePlannedBucket,
  DeferredObjectiveStep,
} from './types';

const ENERGY_EPSILON_KWH = 0.001;
type NonEmptyObjectiveSteps = [DeferredObjectiveStep, ...DeferredObjectiveStep[]];

// Top rung of a non-empty ladder. The tuple guarantees the head exists but not
// the tail read, so a single-rung ladder falls back to the head — which IS its
// top rung.
const topObjectiveStep = (steps: NonEmptyObjectiveSteps): DeferredObjectiveStep => (
  steps.at(-1) ?? steps[0]
);

export const planDeferredObjectiveHorizon = (
  input: DeferredObjectiveHorizonInput,
): DeferredObjectiveHorizonPlan => {
  const epsilonKWh = ENERGY_EPSILON_KWH;
  const energyNeededKWh = normalizeEnergyNeededKWh(input.objective.energyNeededKWh);
  const varianceMarginKWh = normalizeVarianceMarginKWh(
    input.objective.energyExpectedKWh,
    energyNeededKWh,
  );
  const deadlineMarginMs = input.objective.deadlineMarginMs;
  const invalidDetail = resolveInvalidDetail({
    nowMs: input.nowMs,
    deadlineAtMs: input.objective.deadlineAtMs,
    energyNeededKWh,
  });
  if (invalidDetail) {
    return buildEmptyPlan({ input, deadlineMarginMs, energyNeededKWh, status: 'invalid', statusDetail: invalidDetail });
  }
  if (energyNeededKWh <= epsilonKWh) {
    return buildEmptyPlan({
      input,
      deadlineMarginMs,
      energyNeededKWh,
      status: 'satisfied',
      statusDetail: 'energy_already_met',
    });
  }
  if (input.objective.deadlineAtMs <= input.nowMs) {
    return buildEmptyPlan({
      input,
      deadlineMarginMs,
      energyNeededKWh,
      status: 'cannot_meet',
      statusDetail: 'deadline_passed',
    });
  }

  const steps = normalizeObjectiveSteps(input.steps);
  const activeSteps = getActiveObjectiveSteps(steps);
  if (!hasObjectiveSteps(activeSteps)) {
    return buildEmptyPlan({
      input,
      deadlineMarginMs,
      energyNeededKWh,
      status: 'invalid',
      statusDetail: 'missing_active_step',
    });
  }

  const buckets = normalizeHorizonBuckets({
    nowMs: input.nowMs,
    deadlineAtMs: input.objective.deadlineAtMs,
    deadlineMarginMs,
    buckets: input.buckets,
  });
  if (buckets.length === 0) {
    return buildEmptyPlan({
      input,
      deadlineMarginMs,
      energyNeededKWh,
      status: 'cannot_meet',
      statusDetail: 'no_bucket_capacity',
    });
  }

  // Floor commitment: by default the lowest active step is the only level we
  // can guarantee for the full hour (higher steps depend on transient
  // headroom). For a *fully-reserved* objective (both `exemptFromBudget` and
  // `limitLowerPriorityDevices` set to 'always'), `resolveStepForBucket`
  // promotes each bucket independently to the highest step its own
  // reserved-headroom forecast supports — those higher steps are then as
  // guaranteed as the min step *for that hour*, by construction of the
  // forecast. Different buckets across the horizon can land at different
  // steps. `hard-cap-is-physical` holds: each bucket commits at a step the
  // producer has verified against that bucket's forecast, and a wrong
  // forecast is caught by the per-cycle re-solve, the deadline-reserve
  // at-risk backstop, and the per-hour `reservedHeadroomKw × duration`
  // ceiling in `resolveBucketStepCapacityKWh`.
  const fullyReserved = input.objective.fullyReserved;
  const stepForBucket: StepForBucket = (bucket) => (
    resolveStepForBucket(bucket, activeSteps, fullyReserved)
  );
  const allocation = resolveAllocation({
    stepForBucket,
    buckets,
    commitment: input.commitment,
    energyNeededKWh,
    epsilonKWh,
  });
  const { feasibleOnClimbedBand, budgetRole } = resolveFloorFeasibility({
    activeSteps,
    buckets,
    commitment: input.commitment,
    energyNeededKWh,
    epsilonKWh,
    floorUnplannedKWh: allocation.unplannedUsefulEnergyKWh,
    stepForBucket,
  });
  const currentBucket = allocation.plannedBuckets.find((bucket) => bucket.current);
  const currentHourFacts: DeferredObjectiveCurrentHourFacts = {
    aheadOfHourMilestone: input.aheadOfHourMilestone,
    cheaperHourAhead: currentBucket !== undefined
      && hasCheaperEnergyHourAhead(allocation.plannedBuckets, currentBucket, epsilonKWh),
    coldStartFeasible: resolveColdStartFeasible({
      objectiveKind: input.objective.kind,
      buckets,
      stepForBucket,
      climbStep: topObjectiveStep(activeSteps),
      energyNeededKWh,
      epsilonKWh,
    }),
  };
  return buildPlanFromAllocation({
    input,
    deadlineMarginMs,
    energyNeededKWh,
    varianceMarginKWh,
    steps,
    allocation,
    epsilonKWh,
    feasibleOnClimbedBand,
    budgetRole,
    currentHourFacts,
  });
};

// Resolve both floor-feasibility signals together: whether the target fits by
// climbing to a higher step (`feasibleOnClimbedBand`) and how far the soft
// daily budget accounts for what remains (`budgetRole`). The role probe
// consumes `feasibleOnClimbedBand`, so they are resolved here in one pass to keep
// `planDeferredObjectiveHorizon` lean.
const resolveFloorFeasibility = (params: {
  activeSteps: NonEmptyObjectiveSteps;
  buckets: Parameters<typeof allocateEnergyToBuckets>[0]['buckets'];
  commitment: DeferredObjectiveHorizonInput['commitment'];
  energyNeededKWh: number;
  epsilonKWh: number;
  floorUnplannedKWh: number;
  stepForBucket: StepForBucket;
}): { feasibleOnClimbedBand: boolean; budgetRole: BudgetShortfallRole } => {
  const climbedBand = resolveClimbedBandFeasibility(params);
  const budgetRole = resolveBudgetBoundFeasibility({ ...params, climbedBand });
  return { feasibleOnClimbedBand: climbedBand.feasible, budgetRole };
};

// The commitment is sized against the lowest non-zero step (`activeSteps[0]`,
// since `normalizeObjectiveSteps` sorts ascending by `usefulPowerKw` and
// `getActiveObjectiveSteps` drops zero-power entries). That is the only level
// we can guarantee for the full hour — higher steps depend on transient
// headroom and could be denied mid-bucket. Callers pass the step explicitly so
// the same allocator can also run a climbed-band feasibility probe (see
// `resolveClimbedBandFeasibility`) without re-introducing optimism into the
// commitment.
const resolveAllocation = (params: {
  stepForBucket: StepForBucket;
  buckets: Parameters<typeof allocateEnergyToBuckets>[0]['buckets'];
  commitment: DeferredObjectiveHorizonInput['commitment'];
  energyNeededKWh: number;
  epsilonKWh: number;
}): BucketAllocationResult => {
  const { stepForBucket } = params;
  // Branch on commitment kind, not hours.length. An active commitment
  // with zero allocated hours (e.g. a previously stored `cannot_meet` plan)
  // must stay on the committed-replan path so the allocator cannot silently
  // recover by re-running the fresh optimizer against the new horizon.
  if (params.commitment.kind === 'committed') {
    return allocateCommittedEnergyToBuckets({
      buckets: params.buckets,
      stepForBucket,
      energyNeededKWh: params.energyNeededKWh,
      epsilonKWh: params.epsilonKWh,
      committedHours: params.commitment.hours,
    });
  }
  return allocateEnergyToBuckets({
    buckets: params.buckets,
    stepForBucket,
    energyNeededKWh: params.energyNeededKWh,
    epsilonKWh: params.epsilonKWh,
  });
};

// A floor-step shortfall is not necessarily a miss: the executor climbs to
// higher steps whenever capacity allows, so the device often delivers more than
// the guaranteed floor. We re-run the allocator at the *highest* active step,
// in the same commitment mode as the floor pass, purely to classify the
// shortfall — if the energy fits there, the target is reachable by climbing and
// the status is `at_risk` ('feasible_above_floor') rather than a flat
// `cannot_meet`. This never feeds the commitment, so `hard-cap-is-physical`
// holds: we still only *plan* against the guaranteed floor.
//
// Mirroring the commitment mode matters: an active commitment with zero hours
// (a previously stored `cannot_meet` plan) has an empty committed map, so the
// climbed probe also allocates nothing and the verdict stays `cannot_meet` —
// the probe must not silently recover by re-running the fresh optimizer.
// Single-step devices (e.g. EV chargers) cannot climb, so they skip the probe
// and keep the floor verdict.
// What the climbed-band pass found: whether climbing alone closes the gap, and
// how much it still left unplanned. The second figure is what makes the budget
// probe honest — it compares an UNCAPPED climbed allocation against a CAPPED
// climbed one, so the difference is the budget cap and nothing else. Against the
// floor pass it would credit the budget for every kWh climbing unlocked.
type ClimbedBandProbe = { feasible: boolean; cappedUnplannedKWh: number };

const resolveClimbedBandFeasibility = (params: {
  activeSteps: NonEmptyObjectiveSteps;
  buckets: Parameters<typeof allocateEnergyToBuckets>[0]['buckets'];
  commitment: DeferredObjectiveHorizonInput['commitment'];
  energyNeededKWh: number;
  epsilonKWh: number;
  floorUnplannedKWh: number;
  // Per-bucket floor step resolver used by the floor pass. With per-bucket
  // promotion, different buckets land at different steps; the probe runs
  // at the highest step each bucket's own headroom forecast admits, which is
  // the feasibility upper bound the executor could actually reach there. The
  // probe is skipped when no bucket would gain capacity by climbing.
  stepForBucket: StepForBucket;
}): ClimbedBandProbe => {
  // Climbing gains nothing here, so the floor pass IS the capped-climbed result.
  const climbChangesNothing = { feasible: false, cappedUnplannedKWh: params.floorUnplannedKWh };
  if (params.floorUnplannedKWh <= params.epsilonKWh) return climbChangesNothing;
  const topStep = topObjectiveStep(params.activeSteps);
  // Highest rung each bucket's own headroom admits; the top rung when it has no
  // forecast. `resolveBucketStepCapacityKWh` ZEROES a bucket whose step draws more
  // than its headroom, so probing the uniform top rung answered "does not fit" for
  // every device whose ladder reaches past the hard cap, whatever the budget did.
  const climbStepFor = (bucket: { reservedHeadroomKw?: number | undefined }): DeferredObjectiveStep => (
    resolveHighestStepWithinHeadroom(params.activeSteps, bucket.reservedHeadroomKw) ?? topStep
  );
  // No bucket can gain capacity if its climb step doesn't exceed its floor step.
  // (For non-fully-reserved / single-step devices the floor is always
  // `activeSteps[0]`, so this short-circuits on a single-rung ladder — and now
  // also when every bucket's headroom already pins the climb back to the floor.)
  const climbAddsCapacity = params.buckets.some(
    (bucket) => climbStepFor(bucket).usefulPowerKw > params.stepForBucket(bucket).usefulPowerKw,
  );
  if (!climbAddsCapacity) return climbChangesNothing;
  const climbed = resolveAllocation({
    stepForBucket: climbStepFor,
    buckets: params.buckets,
    commitment: params.commitment,
    energyNeededKWh: params.energyNeededKWh,
    epsilonKWh: params.epsilonKWh,
  });
  const cappedUnplannedKWh = climbed.unplannedUsefulEnergyKWh;
  return { feasible: cappedUnplannedKWh <= params.epsilonKWh, cappedUnplannedKWh };
};

// Per-bucket floor step selection for fully-reserved smart tasks. By default
// each bucket's floor stays at `activeSteps[0]` (the min step is the only
// level guaranteed for the full hour). When the objective holds both the
// `exemptFromBudget` and `limitLowerPriorityDevices === 'always'` rescue
// permissions, each bucket can be promoted independently to the highest
// active step whose `admissionPowerKw` (its nameplate) fits THAT bucket's own
// `reservedHeadroomKw` forecast. Hours with generous forecast headroom
// commit at a higher step's capacity; hours with tight forecast headroom
// stay at the lower step. Buckets lacking a forecast fall back to
// `activeSteps[0]` (we cannot promise more than the producer has verified).
// Single-step devices (`activeSteps.length === 1`) trivially keep the min
// step on every bucket.
//
// `hard-cap-is-physical` holds: each bucket commits at a step the producer
// has verified against THAT bucket's forecast. A drift in the forecast (an
// unexpected non-sheddable surge) is caught by the per-cycle re-solve, the
// deadline-reserve at-risk backstop, and — load-bearing — the per-hour
// `reservedHeadroomKw × duration` ceiling stacked into
// `resolveBucketStepCapacityKWh` (`bucketAllocation.ts`). A transient
// forecast spike that promotes the step is harmless because the SAME
// `reservedHeadroomKw` also caps the planned kWh, so a wrongly-promoted
// step cannot grow the bucket's committed energy beyond what the forecast
// also allows. Keep step selection and the kWh ceiling using the same
// `reservedHeadroomKw` source so this invariant doesn't decouple.
const resolveStepForBucket = (
  bucket: { reservedHeadroomKw?: number | undefined },
  activeSteps: NonEmptyObjectiveSteps,
  fullyReserved: boolean,
): DeferredObjectiveStep => {
  if (!fullyReserved || activeSteps.length === 1) return activeSteps[0];
  // Same scan the feasibility probes use, with the opposite default: no forecast ⇒
  // the FLOOR step, because we cannot promise more than the producer has verified.
  return resolveHighestStepWithinHeadroom(activeSteps, bucket.reservedHeadroomKw) ?? activeSteps[0];
};

// A floor shortfall that disappears once the per-bucket daily-budget cap is
// lifted is *budget-bound*, not physical: the soft daily budget (the per-bucket
// pacing slice net of forecast background) is the binding constraint, while
// physical capacity and time would fit. We re-allocate on a copy of the buckets
// with only the daily-budget slice lifted, preserving higher-priority energy
// reservations and mirroring the floor pass's commitment mode.
//
// Only the soft cap is lifted: `reservedHeadroomKw` still bounds each hour, so the
// probe cannot answer "yes" on room the hard cap does not have — and the step is
// the highest rung that headroom admits, not the ladder's top rung, or the capacity
// gate would zero every bucket for a device whose ladder reaches past the cap.
//
// If the energy then fits, the shortfall is the daily budget's doing → recoverable
// `at_risk`, not a physical `cannot_meet`.
//
// Distinct from the climbed-band probe, which keeps the budget cap and only
// raises the step — that cannot rescue a budget-bound shortfall because the cap
// bounds every step equally. Classification only; never feeds the commitment,
// so `hard-cap-is-physical` and the soft-budget throttle stay enforced in what
// we actually plan — only the status label softens. Mirroring the commitment
// mode keeps it conservative: a committed, already-budget-shaped schedule stays
// `cannot_meet` (the committed caps bind in the probe too), while the common
// fresh-plan case reclassifies correctly.
// How far the soft daily budget accounts for a floor shortfall. `sole` is the
// long-standing "lift the per-bucket cap and it fits" test, and the ONLY value
// that moves the primary status — a shortfall the budget fully explains is
// recoverable, not physical. `contributing` means uncapping plans strictly more
// yet the target still misses: the status stays honest about reachability while
// the surface gains the one fact it was missing.
type BudgetShortfallRole = 'none' | 'contributing' | 'sole';

const resolveBudgetBoundFeasibility = (params: {
  activeSteps: NonEmptyObjectiveSteps;
  buckets: Parameters<typeof allocateEnergyToBuckets>[0]['buckets'];
  commitment: DeferredObjectiveHorizonInput['commitment'];
  energyNeededKWh: number;
  epsilonKWh: number;
  floorUnplannedKWh: number;
  climbedBand: ClimbedBandProbe;
}): BudgetShortfallRole => {
  // No shortfall, or climbing within the budget already fits — neither is a
  // budget-bound classification.
  if (params.floorUnplannedKWh <= params.epsilonKWh || params.climbedBand.feasible) {
    return 'none';
  }
  const uncappedBuckets = params.buckets.map((bucket) => ({
    ...bucket,
    budgetCapPolicy: 'lifted' as const,
  }));
  const uncapped = resolveAllocation({
    // Same per-bucket climb as the band probe, for the same reason.
    stepForBucket: (bucket) => resolveHighestStepWithinHeadroom(
      params.activeSteps,
      bucket.reservedHeadroomKw,
    ) ?? topObjectiveStep(params.activeSteps),
    buckets: uncappedBuckets,
    commitment: params.commitment,
    energyNeededKWh: params.energyNeededKWh,
    epsilonKWh: params.epsilonKWh,
  });
  if (uncapped.unplannedUsefulEnergyKWh <= params.epsilonKWh) return 'sole';
  // Uncapping planned strictly more and STILL missed: the budget is not the whole
  // story, but it is part of it. Compared against the CAPPED CLIMBED residue so
  // the only difference between the two allocations is the per-bucket cap.
  const uncappingHelped = uncapped.unplannedUsefulEnergyKWh + params.epsilonKWh
    < params.climbedBand.cappedUnplannedKWh;
  return uncappingHelped ? 'contributing' : 'none';
};

const buildPlanFromAllocation = (params: {
  input: DeferredObjectiveHorizonInput;
  deadlineMarginMs: number;
  energyNeededKWh: number;
  steps: DeferredObjectiveStep[];
  allocation: BucketAllocationResult;
  epsilonKWh: number;
  feasibleOnClimbedBand: boolean;
  budgetRole: BudgetShortfallRole;
  varianceMarginKWh: number;
  currentHourFacts: DeferredObjectiveCurrentHourFacts;
}): DeferredObjectiveHorizonPlan => {
  const {
    input,
    deadlineMarginMs,
    energyNeededKWh,
    steps,
    allocation,
    epsilonKWh,
    feasibleOnClimbedBand,
    budgetRole,
    varianceMarginKWh,
    currentHourFacts,
  } = params;
  const statusResult = resolveStatus({
    allocation,
    epsilonKWh,
    feasibleOnClimbedBand,
    budgetRole,
    varianceMarginKWh,
  });
  const floorShortfallCause = resolveFloorShortfallCause(statusResult.statusDetail);
  const plannedBuckets = bookBuckets(allocation.plannedBuckets, needsEveryHour(floorShortfallCause));
  const currentBucket = resolveCurrentBucketPlan({
    plannedBuckets,
    steps,
    epsilonKWh,
  });

  return {
    objectiveId: input.objective.id,
    kind: input.objective.kind,
    enforcement: input.objective.enforcement,
    status: statusResult.status,
    statusDetail: statusResult.statusDetail,
    horizonStartMs: input.nowMs,
    horizonEndMs: input.objective.deadlineAtMs,
    planningEndMs: resolvePlanningEndMs(input.nowMs, input.objective.deadlineAtMs, deadlineMarginMs),
    deadlineMarginMs,
    energyNeededKWh,
    plannedUsefulEnergyKWh: allocation.plannedUsefulEnergyKWh,
    unplannedUsefulEnergyKWh: allocation.unplannedUsefulEnergyKWh,
    budgetContributedToShortfall: budgetRole !== 'none',
    expectedStepId: currentBucket?.expectedStepId ?? null,
    currentBucket,
    plannedBuckets,
    usesDeadlineReserve: allocation.usesDeadlineReserve,
    currentHourFacts,
    // The cause is the same signal the recorder persists onto the revision, so the
    // frozen mid-hour read replays exactly this verdict instead of recomputing one.
    currentHourClaim: resolveCurrentHourClaim({
      currentHourBooking: resolveCurrentHourBooking(currentBucket),
      facts: currentHourFacts,
      floorShortfallCause,
    }),
  };
};

const resolveCurrentBucketPlan = (params: {
  plannedBuckets: DeferredObjectivePlannedBucket[];
  steps: DeferredObjectiveStep[];
  epsilonKWh: number;
}): DeferredObjectiveCurrentBucketPlan | null => {
  const {
    plannedBuckets,
    steps,
    epsilonKWh,
  } = params;
  const currentBucket = plannedBuckets.find((bucket) => bucket.current) ?? null;
  if (!currentBucket) return null;
  const requestedStep = selectMinimumStepForEnergy({
    steps,
    energyKWh: currentBucket.plannedUsefulEnergyKWh,
    durationHours: currentBucket.durationHours,
    epsilonKWh,
  });
  return {
    bucketId: currentBucket.id,
    sourceBucketId: currentBucket.sourceBucketId,
    plannedUsefulEnergyKWh: currentBucket.plannedUsefulEnergyKWh,
    booked: currentBucket.booked,
    expectedStepId: requestedStep?.id ?? null,
  };
};

const resolveStatus = (params: {
  allocation: BucketAllocationResult;
  epsilonKWh: number;
  feasibleOnClimbedBand: boolean;
  budgetRole: BudgetShortfallRole;
  varianceMarginKWh: number;
}): { status: DeferredObjectiveHorizonStatus; statusDetail: DeferredObjectiveHorizonStatusDetail } => {
  const {
    allocation,
    epsilonKWh,
    feasibleOnClimbedBand,
    budgetRole,
    varianceMarginKWh,
  } = params;
  if (allocation.unplannedUsefulEnergyKWh > epsilonKWh) {
    // The guaranteed floor cannot fit the target. Only call it impossible when
    // climbing to a higher step would not fit it either; otherwise the device
    // can likely finish by climbing, which is `at_risk`, not a flat miss.
    if (feasibleOnClimbedBand) {
      return { status: 'at_risk', statusDetail: 'feasible_above_floor' };
    }
    // The same energy fits once the per-bucket daily-budget cap is lifted: the
    // soft daily budget is the binding constraint, not physical capacity/time.
    // Surface it as recoverable `at_risk` (the user can lower the daily budget
    // or exempt the task) rather than a physical `cannot_meet`.
    if (budgetRole === 'sole') {
      return { status: 'at_risk', statusDetail: 'limited_by_daily_budget' };
    }
    // The shortfall fits within the producer's variance margin (the integrated
    // `k·SE` buffer baked into `energyNeededKWh` on top of the mean-based
    // `energyExpectedKWh`). That means the *mean* rate would fit and only the
    // conservative padding causes the gap — the estimate is uncertain, not the
    // physics. Soften to `at_risk` so users aren't told "Cannot finish" purely
    // because of an estimator buffer. The margin is itself confidence-aware (it
    // scales with the band-residual SE from Step 2), so a high-confidence run
    // has a small margin and this branch fires only on a correspondingly small
    // shortfall.
    if (
      varianceMarginKWh > epsilonKWh
      && allocation.unplannedUsefulEnergyKWh <= varianceMarginKWh + epsilonKWh
    ) {
      return { status: 'at_risk', statusDetail: 'estimate_uncertain' };
    }
    return { status: 'cannot_meet', statusDetail: 'target_cannot_be_met' };
  }
  if (allocation.usesDeadlineReserve) {
    return { status: 'at_risk', statusDetail: 'planned_using_deadline_reserve' };
  }
  return { status: 'on_track', statusDetail: 'planned_with_margin' };
};

const buildEmptyPlan = (params: {
  input: DeferredObjectiveHorizonInput;
  deadlineMarginMs: number;
  energyNeededKWh: number;
  status: DeferredObjectiveHorizonStatus;
  statusDetail: DeferredObjectiveHorizonStatusDetail;
}): DeferredObjectiveHorizonPlan => {
  const {
    input,
    deadlineMarginMs,
    energyNeededKWh,
    status,
    statusDetail,
  } = params;
  return {
    objectiveId: input.objective.id,
    kind: input.objective.kind,
    enforcement: input.objective.enforcement,
    status,
    statusDetail,
    budgetContributedToShortfall: false,
    horizonStartMs: input.nowMs,
    horizonEndMs: input.objective.deadlineAtMs,
    planningEndMs: resolvePlanningEndMs(input.nowMs, input.objective.deadlineAtMs, deadlineMarginMs),
    deadlineMarginMs,
    energyNeededKWh,
    plannedUsefulEnergyKWh: 0,
    unplannedUsefulEnergyKWh: status === 'satisfied' ? 0 : energyNeededKWh,
    expectedStepId: null,
    currentBucket: null,
    plannedBuckets: [],
    usesDeadlineReserve: false,
    currentHourFacts: { aheadOfHourMilestone: false, cheaperHourAhead: false, coldStartFeasible: false },
    // An empty plan has no schedule at all — a passed deadline, or a price window
    // that failed to cover the horizon. There is nothing demanding this hour and no
    // allocation whose shortfall could speak for it, so the device keeps its
    // pre-existing release posture.
    currentHourClaim: 'released',
  };
};

const resolveInvalidDetail = (params: {
  nowMs: number;
  deadlineAtMs: number;
  energyNeededKWh: number;
}): DeferredObjectiveHorizonStatusDetail | null => {
  const {
    nowMs,
    deadlineAtMs,
    energyNeededKWh,
  } = params;
  if (!Number.isFinite(nowMs)) return 'invalid_now';
  if (!Number.isFinite(deadlineAtMs)) return 'invalid_deadline';
  if (!Number.isFinite(energyNeededKWh)) return 'invalid_energy';
  return null;
};

const normalizeEnergyNeededKWh = (energyNeededKWh: number): number => {
  if (!Number.isFinite(energyNeededKWh)) return Number.NaN;
  return Math.max(0, energyNeededKWh);
};

// Width of the producer's variance buffer (`energyNeededKWh − energyExpectedKWh`,
// the integrated `k·SE`). Clamped at 0 when the expected estimate is missing or
// not strictly less than the buffered need, so legacy callers / high-confidence
// runs collapse the `estimate_uncertain` branch and behave exactly as before.
const normalizeVarianceMarginKWh = (
  energyExpectedKWh: number | undefined,
  energyNeededKWh: number,
): number => {
  if (typeof energyExpectedKWh !== 'number' || !Number.isFinite(energyExpectedKWh)) return 0;
  return Math.max(0, energyNeededKWh - energyExpectedKWh);
};

const hasObjectiveSteps = (
  steps: DeferredObjectiveStep[],
): steps is NonEmptyObjectiveSteps => steps.length > 0;

const resolvePlanningEndMs = (
  nowMs: number,
  deadlineAtMs: number,
  deadlineMarginMs: number,
): number => {
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineAtMs)) return Number.NaN;
  return Math.max(nowMs, deadlineAtMs - deadlineMarginMs);
};
