import {
  allocateEnergyToBuckets,
  normalizeHorizonBuckets,
  type BucketAllocationResult,
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
type AllocationCandidate = {
  allocation: BucketAllocationResult;
  step: DeferredObjectiveStep;
};

export const planDeferredObjectiveHorizon = (
  input: DeferredObjectiveHorizonInput,
): DeferredObjectiveHorizonPlan => {
  const epsilonKWh = normalizeEpsilon(input.epsilonKWh);
  const energyNeededKWh = normalizeEnergyNeededKWh(input.objective.energyNeededKWh);
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

  const allocation = resolveAllocation({
    activeSteps,
    buckets,
    energyNeededKWh,
    epsilonKWh,
  });
  return buildPlanFromAllocation({
    input,
    deadlineMarginMs,
    energyNeededKWh,
    steps,
    allocation,
    epsilonKWh,
  });
};

const resolveAllocation = (params: {
  activeSteps: NonEmptyObjectiveSteps;
  buckets: Parameters<typeof allocateEnergyToBuckets>[0]['buckets'];
  energyNeededKWh: number;
  epsilonKWh: number;
}): BucketAllocationResult => {
  const {
    activeSteps,
    buckets,
    energyNeededKWh,
    epsilonKWh,
  } = params;
  let best = buildAllocationCandidate({ buckets, step: activeSteps[0], energyNeededKWh, epsilonKWh });

  for (let index = 1; index < activeSteps.length; index += 1) {
    const candidate = buildAllocationCandidate({ buckets, step: activeSteps[index], energyNeededKWh, epsilonKWh });
    if (compareAllocationCandidates(candidate, best, epsilonKWh) < 0) {
      best = candidate;
    }
  }

  return best.allocation;
};

const buildAllocationCandidate = (params: {
  buckets: Parameters<typeof allocateEnergyToBuckets>[0]['buckets'];
  step: DeferredObjectiveStep;
  energyNeededKWh: number;
  epsilonKWh: number;
}): AllocationCandidate => ({
  step: params.step,
  allocation: allocateEnergyToBuckets({
    buckets: params.buckets,
    step: params.step,
    energyNeededKWh: params.energyNeededKWh,
    epsilonKWh: params.epsilonKWh,
  }),
});

const compareAllocationCandidates = (
  left: AllocationCandidate,
  right: AllocationCandidate,
  epsilonKWh: number,
): number => (
  compareFeasibility(left.allocation, right.allocation, epsilonKWh)
  || compareUnplannedEnergy(left.allocation, right.allocation, epsilonKWh)
  || compareAllocationRisk(left.allocation, right.allocation)
  || compareCurrentPlannedEnergy(left.allocation, right.allocation, epsilonKWh)
  || left.step.usefulPowerKw - right.step.usefulPowerKw
);

const compareFeasibility = (
  left: BucketAllocationResult,
  right: BucketAllocationResult,
  epsilonKWh: number,
): number => {
  const leftFeasible = left.unplannedUsefulEnergyKWh <= epsilonKWh;
  const rightFeasible = right.unplannedUsefulEnergyKWh <= epsilonKWh;
  if (leftFeasible === rightFeasible) return 0;
  return leftFeasible ? -1 : 1;
};

const compareUnplannedEnergy = (
  left: BucketAllocationResult,
  right: BucketAllocationResult,
  epsilonKWh: number,
): number => {
  const delta = left.unplannedUsefulEnergyKWh - right.unplannedUsefulEnergyKWh;
  return Math.abs(delta) <= epsilonKWh ? 0 : delta;
};

const compareAllocationRisk = (
  left: BucketAllocationResult,
  right: BucketAllocationResult,
): number => (
  compareBooleanRisk(left.usesDeadlineReserve, right.usesDeadlineReserve)
  || compareBooleanRisk(left.usesPolicyAvoid, right.usesPolicyAvoid)
);

const compareBooleanRisk = (left: boolean, right: boolean): number => {
  if (left === right) return 0;
  return left ? 1 : -1;
};

const compareCurrentPlannedEnergy = (
  left: BucketAllocationResult,
  right: BucketAllocationResult,
  epsilonKWh: number,
): number => {
  const delta = sumCurrentPlannedEnergyKWh(left) - sumCurrentPlannedEnergyKWh(right);
  return Math.abs(delta) <= epsilonKWh ? 0 : delta;
};

const sumCurrentPlannedEnergyKWh = (allocation: BucketAllocationResult): number => {
  let total = 0;
  for (const bucket of allocation.plannedBuckets) {
    if (bucket.current) total += bucket.plannedUsefulEnergyKWh;
  }
  return total;
};

const buildPlanFromAllocation = (params: {
  input: DeferredObjectiveHorizonInput;
  deadlineMarginMs: number;
  energyNeededKWh: number;
  steps: DeferredObjectiveStep[];
  allocation: BucketAllocationResult;
  epsilonKWh: number;
}): DeferredObjectiveHorizonPlan => {
  const {
    input,
    deadlineMarginMs,
    energyNeededKWh,
    steps,
    allocation,
    epsilonKWh,
  } = params;
  const statusResult = resolveStatus({
    allocation,
    enforcement: input.objective.enforcement,
    epsilonKWh,
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
}): { status: DeferredObjectiveHorizonStatus; statusDetail: DeferredObjectiveHorizonStatusDetail } => {
  const { allocation, enforcement, epsilonKWh } = params;
  if (allocation.unplannedUsefulEnergyKWh > epsilonKWh) {
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
