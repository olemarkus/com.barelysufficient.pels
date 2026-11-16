import { reportAppliedPermissions } from './completionDiagnostic';
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
import type { ObjectiveDeviceInput } from '../types';
import {
  buildKnownEnergyFields,
  canReportFreshProgressWhileUnknown,
  mergeProgressFields,
  resolveProgressEnergy,
  withUnavailableTrajectory,
} from './diagnosticFields';

// A task whose device is in this cycle's roster: progress was resolved from it.
type PresentOrderedObjective = OrderedDeferredObjective & { device: ObjectiveDeviceInput };

export const buildPolicyGatedKnownInputs = (
  base: DeferredObjectiveDiagnostic,
  progress: DeferredObjectiveProgressResolution,
  policyReasonCode: DeferredObjectivePolicyHorizonUnavailableReason,
  task: PresentOrderedObjective,
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
    ? resolveProgressEnergy(powerTracker, task.device, objective, remainingUnits, progress)
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
  task: PresentOrderedObjective,
  powerTracker: PowerTrackerState,
): DeferredObjectiveDiagnostic => withUnavailableTrajectory({
  ...buildPolicyGatedKnownInputs(base, progress, rawPolicyHorizon.reasonCode, task, powerTracker),
  horizonBucketCount: rawPolicyHorizon.horizonBucketCount,
}, rawPolicyHorizon.reasonCode);

// The allocator keeps the last hour before the deadline as its reserve
// (`rescueReplan.ts`); the latest start leaves the same room.
const LATEST_START_RESERVE_MS = 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * A task that cannot be allocated because prices do not yet reach its deadline
 * (before the next day's prices are published, for a deadline the next day)
 * still governs its device. It holds the device, as an interval it released for
 * cheaper hours, until the latest start: the last moment the remaining energy
 * still fits before the deadline reserve at the device's slowest useful rung.
 * From then the device runs toward the target on free capacity, so prices that
 * never arrive cannot make the task miss.
 *
 * The latest start needs the task's progress, its remaining energy and the
 * device's speed. A task missing any of them stays inactive: PELS does not hold
 * a device it cannot say when to start.
 *
 * Waiting means prices exist for now and stop short of the deadline. With no
 * price for the current interval there is nothing cheaper to wait for, so the
 * task stays inactive and the device keeps its normal control.
 */
export const withAwaitingPricesPlanning = (
  diagnostic: DeferredObjectiveDiagnostic,
  priceHorizon: readonly PriceHorizonEntry[],
  nowMs: number,
): DeferredObjectiveDiagnostic => {
  const { evaluation, energyNeededKWh, planningSpeedKw } = diagnostic;
  if (!priceHorizon.some((entry) => entry.startMs <= nowMs && nowMs < entry.endMs)) return diagnostic;
  if (evaluation.progress.kind !== 'known') return diagnostic;
  if (energyNeededKWh === null || planningSpeedKw === null) return diagnostic;
  const runMs = (energyNeededKWh / planningSpeedKw) * MS_PER_HOUR;
  const latestStartMs = evaluation.deadlineAtMs - LATEST_START_RESERVE_MS - runMs;
  return {
    ...diagnostic,
    evaluation: {
      ...evaluation,
      planning: { kind: 'awaiting_prices', device: nowMs < latestStartMs ? 'held' : 'running' },
    },
  };
};

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
    ...reportAppliedPermissions(evaluation),
    horizonPlan: planWithPriceWatermark,
  };
};
