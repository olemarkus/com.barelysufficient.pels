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
  selectMinimumStepForEnergy,
} from './stepSelection';
import type {
  DeferredObjectiveCurrentBucketPlan,
  DeferredObjectiveHorizonInput,
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveHorizonStatus,
  DeferredObjectiveHorizonStatusDetail,
  DeferredObjectivePlannedBucket,
  DeferredObjectiveStep,
} from './types';

const DEFAULT_EPSILON_KWH = 0.001;
type NonEmptyObjectiveSteps = [DeferredObjectiveStep, ...DeferredObjectiveStep[]];

export const planDeferredObjectiveHorizon = (
  input: DeferredObjectiveHorizonInput,
): DeferredObjectiveHorizonPlan => {
  const epsilonKWh = normalizeEpsilon(input.epsilonKWh);
  const energyNeededKWh = normalizeEnergyNeededKWh(input.objective.energyNeededKWh);
  const varianceMarginKWh = normalizeVarianceMarginKWh(
    input.objective.energyExpectedKWh,
    energyNeededKWh,
  );
  const deadlineMarginMs = normalizeDeadlineMarginMs(input.objective.deadlineMarginMs);
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

  const committed = resolveCommittedFlag({
    committed: input.committed,
    committedHours: input.committedHours,
  });
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
  const fullyReserved = input.objective.fullyReserved ?? false;
  const stepForBucket: StepForBucket = (bucket) => (
    resolveStepForBucket(bucket, activeSteps, fullyReserved)
  );
  const allocation = resolveAllocation({
    stepForBucket,
    buckets,
    committed,
    committedHours: input.committedHours,
    energyNeededKWh,
    epsilonKWh,
  });
  const feasibleOnClimbedBand = resolveClimbedBandFeasibility({
    activeSteps,
    buckets,
    committed,
    committedHours: input.committedHours,
    energyNeededKWh,
    epsilonKWh,
    floorUnplannedKWh: allocation.unplannedUsefulEnergyKWh,
    stepForBucket,
  });
  const budgetBound = resolveBudgetBoundFeasibility({
    activeSteps,
    buckets,
    committed,
    committedHours: input.committedHours,
    energyNeededKWh,
    epsilonKWh,
    floorUnplannedKWh: allocation.unplannedUsefulEnergyKWh,
    feasibleOnClimbedBand,
  });
  const priceDeferralEligible = resolvePriceDeferralEligible({
    allocation,
    aheadOfHourMilestone: input.aheadOfHourMilestone ?? false,
    epsilonKWh,
  });
  return buildPlanFromAllocation({
    input,
    deadlineMarginMs,
    energyNeededKWh,
    varianceMarginKWh,
    steps,
    allocation,
    epsilonKWh,
    feasibleOnClimbedBand,
    budgetBound,
    priceDeferralEligible,
  });
};

// Backward-compatible resolution of the committed flag. New callers pass an
// explicit boolean (`true` enters the committed-replan path, `false` forces
// the fresh optimizer regardless of `committedHours`). Legacy callers that
// only supplied `committedHours` and left `committed` undefined fall back to
// the historical length-based gate so we don't silently break them during the
// migration window — they will keep behaving as before until updated to pass
// an explicit boolean.
const resolveCommittedFlag = (params: {
  committed: DeferredObjectiveHorizonInput['committed'];
  committedHours: DeferredObjectiveHorizonInput['committedHours'];
}): boolean => {
  if (params.committed === true) return true;
  if (params.committed === undefined) {
    return (params.committedHours?.length ?? 0) > 0;
  }
  return false;
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
  committed: boolean;
  committedHours: DeferredObjectiveHorizonInput['committedHours'];
  energyNeededKWh: number;
  epsilonKWh: number;
}): BucketAllocationResult => {
  const { stepForBucket } = params;
  // Branch on `committed`, not `committedHours.length`. An active commitment
  // with zero allocated hours (e.g. a previously stored `cannot_meet` plan)
  // must stay on the committed-replan path so the allocator cannot silently
  // recover by re-running the fresh optimizer against the new horizon.
  if (params.committed) {
    return allocateCommittedEnergyToBuckets({
      buckets: params.buckets,
      stepForBucket,
      energyNeededKWh: params.energyNeededKWh,
      epsilonKWh: params.epsilonKWh,
      committedHours: params.committedHours ?? [],
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
const resolveClimbedBandFeasibility = (params: {
  activeSteps: NonEmptyObjectiveSteps;
  buckets: Parameters<typeof allocateEnergyToBuckets>[0]['buckets'];
  committed: boolean;
  committedHours: DeferredObjectiveHorizonInput['committedHours'];
  energyNeededKWh: number;
  epsilonKWh: number;
  floorUnplannedKWh: number;
  // Per-bucket floor step resolver used by the floor pass. With per-bucket
  // promotion, different buckets land at different steps; the probe runs
  // at the *uniform* max step for every bucket as the feasibility upper
  // bound. The probe is skipped when no bucket would gain capacity by
  // climbing (climb step ≤ every bucket's floor step).
  stepForBucket: StepForBucket;
}): boolean => {
  if (params.floorUnplannedKWh <= params.epsilonKWh) return false;
  const climbStep = params.activeSteps[params.activeSteps.length - 1];
  // No bucket can gain capacity if climb step doesn't exceed every bucket's
  // floor step. (For non-fully-reserved / single-step devices the floor is
  // always `activeSteps[0]`, so this only short-circuits when activeSteps
  // has a single rung.)
  const climbAddsCapacity = params.buckets.some(
    (bucket) => climbStep.usefulPowerKw > params.stepForBucket(bucket).usefulPowerKw,
  );
  if (!climbAddsCapacity) return false;
  const climbed = resolveAllocation({
    stepForBucket: () => climbStep,
    buckets: params.buckets,
    committed: params.committed,
    committedHours: params.committedHours,
    energyNeededKWh: params.energyNeededKWh,
    epsilonKWh: params.epsilonKWh,
  });
  return climbed.unplannedUsefulEnergyKWh <= params.epsilonKWh;
};

// Per-bucket floor step selection for fully-reserved smart tasks. By default
// each bucket's floor stays at `activeSteps[0]` (the min step is the only
// level guaranteed for the full hour). When the objective holds both the
// `exemptFromBudget` and `limitLowerPriorityDevices === 'always'` rescue
// permissions, each bucket can be promoted independently to the highest
// active step whose `usefulPowerKw` fits THAT bucket's own
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
  const headroom = bucket.reservedHeadroomKw;
  if (typeof headroom !== 'number' || !Number.isFinite(headroom)) return activeSteps[0];
  // `activeSteps` is sorted ascending by `usefulPowerKw` (see
  // `normalizeObjectiveSteps`). Pick the rightmost step that fits; default to
  // the min step when even it does not.
  let promotedIndex = 0;
  for (let i = 1; i < activeSteps.length; i += 1) {
    if (activeSteps[i].usefulPowerKw <= headroom) {
      promotedIndex = i;
    }
  }
  return activeSteps[promotedIndex];
};

// A floor shortfall that disappears once the per-bucket daily-budget cap is
// lifted — with everything else held constant — is *budget-bound*, not
// physical: the soft daily budget (the per-bucket pacing slice net of forecast
// background) is the binding constraint, while physical capacity and time would
// fit. We re-allocate the highest active step on a copy of the buckets with the
// per-bucket cap removed (`usefulEnergyCapKWh → Infinity`), mirroring the floor
// pass's commitment mode so that only the budget cap changes between the two
// passes. If the energy then fits, the shortfall is the daily budget's doing →
// recoverable `at_risk`, not a physical `cannot_meet`.
//
// Distinct from the climbed-band probe, which keeps the budget cap and only
// raises the step — that cannot rescue a budget-bound shortfall because the cap
// bounds every step equally. Classification only; never feeds the commitment,
// so `hard-cap-is-physical` and the soft-budget throttle stay enforced in what
// we actually plan — only the status label softens. Mirroring the commitment
// mode keeps it conservative: a committed, already-budget-shaped schedule stays
// `cannot_meet` (the committed caps bind in the probe too), while the common
// fresh-plan case reclassifies correctly.
const resolveBudgetBoundFeasibility = (params: {
  activeSteps: NonEmptyObjectiveSteps;
  buckets: Parameters<typeof allocateEnergyToBuckets>[0]['buckets'];
  committed: boolean;
  committedHours: DeferredObjectiveHorizonInput['committedHours'];
  energyNeededKWh: number;
  epsilonKWh: number;
  floorUnplannedKWh: number;
  feasibleOnClimbedBand: boolean;
}): boolean => {
  // No shortfall, or climbing within the budget already fits — neither is a
  // budget-bound classification.
  if (params.floorUnplannedKWh <= params.epsilonKWh || params.feasibleOnClimbedBand) {
    return false;
  }
  const uncappedBuckets = params.buckets.map((bucket) => ({
    ...bucket,
    usefulEnergyCapKWh: Number.POSITIVE_INFINITY,
  }));
  const climbStep = params.activeSteps[params.activeSteps.length - 1];
  const uncapped = resolveAllocation({
    stepForBucket: () => climbStep,
    buckets: uncappedBuckets,
    committed: params.committed,
    committedHours: params.committedHours,
    energyNeededKWh: params.energyNeededKWh,
    epsilonKWh: params.epsilonKWh,
  });
  return uncapped.unplannedUsefulEnergyKWh <= params.epsilonKWh;
};

// Relative price margin a later hour must beat to be worth deferring into. A
// pure ratio (later ≤ current × (1 − margin)) — unit-invariant, since the price
// series carries no currency at this layer — so near-equal hours keep the
// earlier (safer-to-heat-early) slot. ~5%.
const PRICE_DEFERRAL_MARGIN = 0.05;

// Price-deferral release probe (mid-execution price deferral). Eligible when
// BOTH hold:
//  1. `aheadOfHourMilestone` — the device's MEASURED value is already at/above
//     the committed plan's end-of-this-hour milestone in the objective's own
//     unit (resolved by the producer in `isAheadOfHourMilestone`; the planner
//     has no measured value or committed rate). Being at/ahead of a trajectory
//     that was built to meet the deadline makes coasting this hour self-feasible
//     — so no residual re-allocation safety check is needed.
//  2. A later, NON-reserve hour is cheaper than the current hour by more than
//     `PRICE_DEFERRAL_MARGIN` (raw-price ratio). Deadline-reserve hours are
//     excluded so we never defer into the reserve; a negative later price
//     naturally satisfies the inequality (heat when paid). The current hour must
//     still carry booked energy (else it is already idle and admission releases
//     it via the `plannedUsefulEnergyKWh ≤ 0` branch — nothing to defer).
// When true the decoration controller's admission idles the device this cycle so
// a cheaper hour carries the load. Classification only — never writes a revision.
const resolvePriceDeferralEligible = (params: {
  allocation: BucketAllocationResult;
  aheadOfHourMilestone: boolean;
  epsilonKWh: number;
}): boolean => {
  if (!params.aheadOfHourMilestone) return false;
  const current = params.allocation.plannedBuckets.find((bucket) => bucket.current);
  if (!current || current.plannedUsefulEnergyKWh <= params.epsilonKWh) return false;
  const currentPrice = current.price;
  if (typeof currentPrice !== 'number' || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return false;
  }
  const threshold = currentPrice * (1 - PRICE_DEFERRAL_MARGIN);
  return params.allocation.plannedBuckets.some((bucket) => (
    !bucket.current
    && !bucket.reserve
    && bucket.startMs >= current.endMs
    // The cheaper hour must be one the plan actually carries load in. A bucket
    // the allocation booked nothing into (zero-capacity, or simply not part of
    // the committed/expanded set) is cheap on paper but won't take the deferred
    // energy — the committed reallocation fills the planned hours first, so
    // releasing toward it would just push the load into the remaining (possibly
    // pricier) committed hours at the next settle. Requiring booked energy keeps
    // the price signal aligned with where the load really goes.
    && bucket.plannedUsefulEnergyKWh > params.epsilonKWh
    && typeof bucket.price === 'number'
    && Number.isFinite(bucket.price)
    && bucket.price <= threshold
  ));
};

const buildPlanFromAllocation = (params: {
  input: DeferredObjectiveHorizonInput;
  deadlineMarginMs: number;
  energyNeededKWh: number;
  steps: DeferredObjectiveStep[];
  allocation: BucketAllocationResult;
  epsilonKWh: number;
  feasibleOnClimbedBand: boolean;
  budgetBound: boolean;
  varianceMarginKWh: number;
  priceDeferralEligible: boolean;
}): DeferredObjectiveHorizonPlan => {
  const {
    input,
    deadlineMarginMs,
    energyNeededKWh,
    steps,
    allocation,
    epsilonKWh,
    feasibleOnClimbedBand,
    budgetBound,
    varianceMarginKWh,
    priceDeferralEligible,
  } = params;
  const statusResult = resolveStatus({
    allocation,
    enforcement: input.objective.enforcement,
    epsilonKWh,
    feasibleOnClimbedBand,
    budgetBound,
    varianceMarginKWh,
  });
  const currentBucket = resolveCurrentBucketPlan({
    plannedBuckets: allocation.plannedBuckets,
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
    requestedMinimumStepId: currentBucket?.requestedMinimumStepId ?? null,
    currentBucket,
    plannedBuckets: allocation.plannedBuckets,
    usesDeadlineReserve: allocation.usesDeadlineReserve,
    usesPolicyAvoid: allocation.usesPolicyAvoid,
    priceDeferralEligible,
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
    requestedMinimumStepId: requestedStep?.id ?? null,
  };
};

const resolveStatus = (params: {
  allocation: BucketAllocationResult;
  enforcement: DeferredObjectiveHorizonInput['objective']['enforcement'];
  epsilonKWh: number;
  feasibleOnClimbedBand: boolean;
  budgetBound: boolean;
  varianceMarginKWh: number;
}): { status: DeferredObjectiveHorizonStatus; statusDetail: DeferredObjectiveHorizonStatusDetail } => {
  const {
    allocation,
    enforcement,
    epsilonKWh,
    feasibleOnClimbedBand,
    budgetBound,
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
    if (budgetBound) {
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
  if (enforcement === 'soft' && allocation.usesPolicyAvoid) {
    return { status: 'at_risk', statusDetail: 'planned_using_policy_avoid' };
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
    horizonStartMs: input.nowMs,
    horizonEndMs: input.objective.deadlineAtMs,
    planningEndMs: resolvePlanningEndMs(input.nowMs, input.objective.deadlineAtMs, deadlineMarginMs),
    deadlineMarginMs,
    energyNeededKWh,
    plannedUsefulEnergyKWh: 0,
    unplannedUsefulEnergyKWh: status === 'satisfied' ? 0 : energyNeededKWh,
    requestedMinimumStepId: null,
    currentBucket: null,
    plannedBuckets: [],
    usesDeadlineReserve: false,
    usesPolicyAvoid: false,
    priceDeferralEligible: false,
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

const normalizeDeadlineMarginMs = (deadlineMarginMs: number | undefined): number => (
  typeof deadlineMarginMs === 'number' && Number.isFinite(deadlineMarginMs)
    ? Math.max(0, deadlineMarginMs)
    : 0
);

const normalizeEpsilon = (epsilonKWh: number | undefined): number => (
  typeof epsilonKWh === 'number' && Number.isFinite(epsilonKWh) && epsilonKWh > 0
    ? epsilonKWh
    : DEFAULT_EPSILON_KWH
);

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
