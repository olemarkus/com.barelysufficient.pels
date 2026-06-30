import type { PowerTrackerState } from '../../power/tracker';
import type { DeferredObjectiveEnergyResolution } from './profileEnergyResolution';
import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type { DeferredObjectiveActivePlanHourV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { resolveHorizonPlanWithRescue } from './rescueReplan';
import type { DeferredObjectiveProgressResolution } from './diagnosticProgress';
import {
  resolvePriceHorizonAvailableUpToMs,
  type DeferredObjectivePolicyHorizonResult,
  type DeferredObjectivePolicyHorizonUnavailableReason,
  type PriceHorizonEntry,
} from './policyHorizon';
import type { DeferredObjectiveSettingsEntry } from './settings';
import type { DeferredObjectiveHorizonPlan, DeferredObjectiveStep } from './types';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import {
  buildKnownEnergyFields,
  canReportFreshProgressWhileUnknown,
  isCurrentBucketPlanned,
  mergeProgressFields,
  resolveProgressEnergy,
  withUnknown,
} from './diagnosticFields';

export const buildPolicyGatedKnownInputs = (
  base: DeferredObjectiveDiagnostic,
  progress: DeferredObjectiveProgressResolution,
  policyReasonCode: DeferredObjectivePolicyHorizonUnavailableReason,
  ctx: { powerTracker: PowerTrackerState; deviceId: string; objective: DeferredObjectiveSettingsEntry },
): DeferredObjectiveDiagnostic => {
  const { powerTracker, deviceId, objective } = ctx;
  const { remainingUnits } = progress;
  if (!canReportFreshProgressWhileUnknown(policyReasonCode)) return base;

  const profileEnergy = !progress.reasonCode && remainingUnits > 0
    && policyReasonCode === 'objective_missing_price_horizon'
    ? resolveProgressEnergy({ powerTracker, deviceId, objective, remainingUnits, progress })
    : null;

  const withProgress = mergeProgressFields(
    base,
    !progress.reasonCode ? progress.currentPercent : null,
    !progress.reasonCode ? progress.currentTemperatureC : null,
  );
  return {
    ...withProgress,
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
  ctx: { powerTracker: PowerTrackerState; deviceId: string; objective: DeferredObjectiveSettingsEntry },
): DeferredObjectiveDiagnostic => withUnknown({
  ...buildPolicyGatedKnownInputs(base, progress, rawPolicyHorizon.reasonCode, ctx),
  horizonBucketCount: rawPolicyHorizon.horizonBucketCount,
  dailyBudgetExhaustedBucketCount: rawPolicyHorizon.dailyBudgetExhaustedBucketCount,
}, rawPolicyHorizon.reasonCode);

// Fresh-path diagnostic: run the allocator (via the rescue resolver) and shape the
// result. The bootstrap / `:58`-settle counterpart to `buildFrozenDiagnostic`.
export const buildFreshDiagnostic = (params: {
  nowMs: number;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  device: ObjectiveDeviceInput;
  base: DeferredObjectiveDiagnostic;
  progress: DeferredObjectiveProgressResolution;
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>;
  deadlineAtMs: number;
  priceOptimizationEnabled: boolean;
  priceHorizon: PriceHorizonEntry[];
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  steps: DeferredObjectiveStep[];
  commitment: DeferredObjectiveActivePlanHourV1[] | undefined;
  aheadOfHourMilestone: boolean;
  profileEnergy: Extract<DeferredObjectiveEnergyResolution, { reasonCode: null }>;
  hardCapKw?: number | null;
  concurrentEligibleCount?: number | ((bucketStartMs: number) => number);
}): DeferredObjectiveDiagnostic => {
  const {
    nowMs, deviceId, objective, device, base, progress, policyHorizon, deadlineAtMs,
    priceOptimizationEnabled, priceHorizon, dailyBudgetSnapshot, steps, commitment,
    aheadOfHourMilestone, profileEnergy,
  } = params;
  const { plan: horizonPlan, dailyBudgetExhaustedBucketCount } = resolveHorizonPlanWithRescue({
    nowMs,
    deviceId,
    objective,
    energyNeededKWh: profileEnergy.energyNeededKWh,
    energyExpectedKWh: profileEnergy.energyExpectedKWh,
    deadlineAtMs,
    steps,
    commitment,
    aheadOfHourMilestone,
    policyHorizon,
    priceOptimizationEnabled,
    priceHorizon,
    dailyBudgetSnapshot,
    hardCapKw: params.hardCapKw,
    // Strict top-priority gate for Slice-2 floor promotion; see comment in
    // rescueReplan.ts. Lower number = more important on PELS's planSort scale;
    // `=== 1` is the only safe v1 floor for the reserved-headroom forecast.
    devicePriority: device.priority,
    // Producer-resolved equal-share allocator for the reserved-headroom forecast
    // when more than one priority-1 fully-reserved task shares the cycle. The
    // exempt rebuild reuses it so the rebuilt buckets carry the same divided
    // forecast as the baseline buckets above.
    concurrentEligibleCount: params.concurrentEligibleCount,
  });

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

  return {
    ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
    status: planWithPriceWatermark.status,
    reasonCode: planWithPriceWatermark.statusDetail,
    ...buildKnownEnergyFields({ objective, profileEnergy }),
    horizonBucketCount: policyHorizon.horizonBucketCount,
    dailyBudgetExhaustedBucketCount,
    expectedStepId: planWithPriceWatermark.expectedStepId,
    budgetExemptApplied: objective.rescue?.exemptFromBudget === 'always'
      && isCurrentBucketPlanned(planWithPriceWatermark),
    limitLowerPriorityApplied: objective.rescue?.limitLowerPriorityDevices === 'always',
    horizonPlan: planWithPriceWatermark,
  };
};
