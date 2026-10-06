import { buildAllocatedTaskEvaluation, buildUnallocatedTaskEvaluation } from './taskEvaluationProducer';
import type { PowerTrackerState } from '../../power/tracker';
import type { DeferredObjectiveEnergyResolution } from './profileEnergyResolution';
import type { OrderedDeferredObjective } from './priorityAllocation';
import type { DeferredObjectiveProgressResolution } from './diagnosticProgress';
import {
  resolvePriceHorizonAvailableUpToMs,
  type DeferredObjectivePolicyHorizonResult,
  type DeferredObjectivePolicyHorizonUnavailableReason,
  type PriceHorizonEntry,
} from './policyHorizon';
import type { DeferredObjectiveHorizonPlan } from './types';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import {
  buildKnownEnergyFields,
  canReportFreshProgressWhileUnknown,
  mergeProgressFields,
  resolveProgressEnergy,
  withUnavailableTrajectory,
} from './diagnosticFields';

export const buildPolicyGatedKnownInputs = (
  base: DeferredObjectiveDiagnostic,
  progress: DeferredObjectiveProgressResolution,
  policyReasonCode: DeferredObjectivePolicyHorizonUnavailableReason,
  task: OrderedDeferredObjective,
  powerTracker: PowerTrackerState,
): DeferredObjectiveDiagnostic => {
  const { deviceId, objective } = task;
  const { remainingUnits } = progress;
  const evaluation = buildUnallocatedTaskEvaluation(deviceId, objective, progress);
  if (!canReportFreshProgressWhileUnknown(policyReasonCode)) {
    return { ...base, evaluation, completion: evaluation.completion };
  }

  const profileEnergy = !progress.reasonCode && remainingUnits > 0
    && policyReasonCode === 'objective_missing_price_horizon'
    ? resolveProgressEnergy({ powerTracker, deviceId, objective, remainingUnits, progress })
    : null;

  const withProgress = mergeProgressFields(base, progress.reasonCode ? null : progress.currentValue);
  return {
    ...withProgress,
    evaluation,
    completion: evaluation.completion,
    ...(!progress.reasonCode && remainingUnits <= 0 ? { energyNeededKWh: 0 } : {}),
    ...(profileEnergy && !profileEnergy.reasonCode ? buildKnownEnergyFields({ objective, profileEnergy }) : {}),
  };
};

// Shape the `unknown` diagnostic for an unavailable policy horizon (price feature
// off, or a transient missing horizon with no frozen fallback). Folds the gated
// known-progress inputs and the horizon's bucket counts onto the verdict.
type UnavailablePolicyHorizon = Extract<
  DeferredObjectivePolicyHorizonResult,
  { reasonCode: DeferredObjectivePolicyHorizonUnavailableReason }
>;

export const buildHorizonUnavailableDiagnostic = (
  base: DeferredObjectiveDiagnostic,
  progress: DeferredObjectiveProgressResolution,
  rawPolicyHorizon: UnavailablePolicyHorizon,
  task: OrderedDeferredObjective,
  powerTracker: PowerTrackerState,
): DeferredObjectiveDiagnostic => withUnavailableTrajectory({
  ...buildPolicyGatedKnownInputs(base, progress, rawPolicyHorizon.reasonCode, task, powerTracker),
  horizonBucketCount: rawPolicyHorizon.horizonBucketCount,
}, rawPolicyHorizon.reasonCode);

// Fresh-path diagnostic: shape the plan the allocator produced (via the rescue
// resolver). The bootstrap / `:58`-settle counterpart to `buildFrozenDiagnostic`.
export const buildFreshDiagnostic = (
  task: OrderedDeferredObjective,
  base: DeferredObjectiveDiagnostic,
  progress: Extract<DeferredObjectiveProgressResolution, { reasonCode: null }>,
  profileEnergy: Extract<DeferredObjectiveEnergyResolution, { reasonCode: null }>,
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>,
  horizonPlan: DeferredObjectiveHorizonPlan,
  priceHorizon: readonly PriceHorizonEntry[],
): DeferredObjectiveDiagnostic => {
  const { deviceId, objective } = task;
  // Stamp the price-availability watermark from the SOURCE price horizon (not the
  // deadline-clamped allocator buckets), so the recorder can tell a genuine
  // price-publication advance (`prices_revised`) from an internal schedule
  // reshuffle (`schedule_revised`). The fresh path always has the real horizon
  // here; the planner deliberately never sees `priceHorizon`, so we resolve it at
  // the bridge and attach it to the plan it produced.
  const planWithPriceWatermark: DeferredObjectiveHorizonPlan = {
    ...horizonPlan,
    pricesAvailableUpToMs: resolvePriceHorizonAvailableUpToMs(priceHorizon),
  };

  const evaluation = buildAllocatedTaskEvaluation(deviceId, objective, progress, planWithPriceWatermark);
  return {
    ...mergeProgressFields(base, progress.currentValue),
    evaluation,
    completion: evaluation.completion,
    trajectory: { kind: 'resolved', status: planWithPriceWatermark.status },
    reasonCode: planWithPriceWatermark.statusDetail,
    ...buildKnownEnergyFields({ objective, profileEnergy }),
    horizonBucketCount: policyHorizon.horizonBucketCount,
    expectedStepId: planWithPriceWatermark.expectedStepId,
    budgetExemptApplied: evaluation.permissions.budgetExempt
      && evaluation.planning.kind === 'allocated' && evaluation.planning.plan.currentHourClaim === 'claimed',
    limitLowerPriorityApplied: evaluation.permissions.limitLowerPriority,
    pauseLowerPriorityApplied: evaluation.permissions.pauseLowerPriority,
    horizonPlan: planWithPriceWatermark,
  };
};
