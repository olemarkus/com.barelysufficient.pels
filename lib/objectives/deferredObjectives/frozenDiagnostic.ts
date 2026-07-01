import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlansV1,
  DeferredObjectiveActivePlanStatusV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveEnergyResolution } from './profileEnergyResolution';
import type { DeferredObjectiveProgressResolution } from './diagnosticProgress';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';
import { buildFrozenHorizonPlan } from './frozenHorizonPlan';
import {
  buildDeferredObjectivePolicyHorizon,
  type DeferredObjectivePolicyHorizonResult,
} from './policyHorizon';
import type { DeferredObjectiveSettingsEntry } from './settings';
import type { DeferredObjectiveStep } from './types';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import {
  buildKnownEnergyFields,
  isCurrentBucketPlanned,
  mergeProgressFields,
} from './diagnosticFields';

// Frozen mid-hour metadata sourced from the coherent active committed-plan view.
// Present ⇒ the per-cycle path reads the frozen plan instead of running the
// allocator (see `buildFrozenHorizonPlan`).
export type FrozenReadInputs = {
  planStatus: DeferredObjectiveActivePlanStatusV1;
  dailyBudgetExhaustedBucketCount: number;
  // The SETTLED revision's hours (`latest.hours`), NOT the schedule-floor
  // `commitment.hours`. A `:58` revision that refines kWh on the same hour set
  // (`rate_refined`, `measured_deviation`) updates `latest` but not `commitment`
  // (the merge only re-commits on a schedule change), so reading `commitment`
  // would serve stale energy / `cheaperHourAhead`. `latest.hours` is the
  // Math.max-merged floored plan — the freshest thing the device should follow.
  hours: readonly DeferredObjectiveActivePlanHourV1[];
};

// Metadata-only deadline reserve for the frozen plan (matches rescueReplan's
// `DEFAULT_DEADLINE_RESERVE_MS`); used for `planningEndMs`/`horizonEndMs`, which no
// frozen-path consumer reads. The `:58` settle recomputes the authoritative plan.
const FROZEN_DEADLINE_RESERVE_MS = 60 * 60 * 1000;
const FROZEN_EPSILON_KWH = 0.001;
const ONE_HOUR_MS = 60 * 60 * 1000;

// Resolve the frozen-read inputs for the per-cycle (mid-hour) path, or null when
// the allocator must run instead. A frozen read requires a coherent active plan
// (`commitment` + `latest`) whose commitment still covers the active hour; legacy
// or corrupt shapes without `latest` are left to the fresh path. See
// execution-adaptation.md ("Interaction with the per-cycle frozen read"). The
// caller decides whether to use this vs re-plan — re-planning runs the allocator only at
// the `:58` settle AND when the price horizon is available, so a committed device
// is never dropped to inactive on a transient horizon gap.
const resolveFrozenReadInputs = (params: {
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  nowMs: number;
}): FrozenReadInputs | null => {
  const activePlan = resolveActiveCommittedPlan({
    activePlans: params.activePlans,
    deviceId: params.deviceId,
    objective: params.objective,
  });
  if (activePlan === undefined) return null;
  const currentHourStartMs = Math.floor(params.nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
  if (!activePlan.commitmentHours.some((hour) => hour.startsAtMs >= currentHourStartMs)) return null;
  const { latest } = activePlan;
  return {
    planStatus: latest.planStatus,
    dailyBudgetExhaustedBucketCount: latest.dailyBudgetExhaustedBucketCount ?? 0,
    // Settled revision's hours (freshest floored plan). The active-plan accessor
    // already rejected legacy/corrupt shapes without a latest revision, so the
    // frozen path never falls back to the commitment floor for control data.
    hours: latest.hours,
  };
};

export const resolveDeadlineBoundFrozenReadInputs = (params: {
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  nowMs: number;
}): FrozenReadInputs | null => (
  params.objective.deadlineAtMs > params.nowMs ? resolveFrozenReadInputs(params) : null
);

// Stand-in for the frozen mid-hour path, where the allocator is skipped so the
// policy horizon is unused. (Also reused when the price horizon is temporarily
// unavailable but a commitment exists — we serve frozen rather than going inactive.)
export const EMPTY_POLICY_HORIZON: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }> = {
  buckets: [],
  horizonBucketCount: 0,
  dailyBudgetExhaustedBucketCount: 0,
  reasonCode: null,
};

type DeferredObjectivePolicyHorizonParams = Parameters<typeof buildDeferredObjectivePolicyHorizon>[0];

export const buildDeadlineAwarePolicyHorizon = (
  params: DeferredObjectivePolicyHorizonParams,
): DeferredObjectivePolicyHorizonResult => (
  params.deadlineAtMs <= params.nowMs ? EMPTY_POLICY_HORIZON : buildDeferredObjectivePolicyHorizon(params)
);

// Assemble the diagnostic from the persisted commitment + live measured value
// (folded into `aheadOfHourMilestone`), skipping the allocator. Mirrors the shape
// `buildDiagnosticWithPolicyHorizon` returns on the fresh path.
export const buildFrozenDiagnostic = (params: {
  nowMs: number;
  base: DeferredObjectiveDiagnostic;
  progress: DeferredObjectiveProgressResolution;
  objective: DeferredObjectiveSettingsEntry;
  deviceId: string;
  deadlineAtMs: number;
  profileEnergy: Extract<DeferredObjectiveEnergyResolution, { reasonCode: null }>;
  aheadOfHourMilestone: boolean;
  steps: DeferredObjectiveStep[];
  frozenRead: FrozenReadInputs;
}): DeferredObjectiveDiagnostic => {
  const {
    nowMs, base, progress, objective, deviceId, deadlineAtMs,
    profileEnergy, aheadOfHourMilestone, steps, frozenRead,
  } = params;
  const horizonPlan = buildFrozenHorizonPlan({
    nowMs,
    objectiveId: `${deviceId}:${objective.kind}`,
    objectiveKind: objective.kind,
    enforcement: objective.enforcement,
    deadlineAtMs,
    deadlineMarginMs: FROZEN_DEADLINE_RESERVE_MS,
    committedHours: frozenRead.hours,
    planStatus: frozenRead.planStatus,
    energyNeededKWh: profileEnergy.energyNeededKWh,
    aheadOfHourMilestone,
    steps,
    epsilonKWh: FROZEN_EPSILON_KWH,
  });
  return {
    ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
    status: horizonPlan.status,
    reasonCode: horizonPlan.statusDetail,
    ...buildKnownEnergyFields({ objective, profileEnergy }),
    horizonBucketCount: frozenRead.hours.length,
    dailyBudgetExhaustedBucketCount: frozenRead.dailyBudgetExhaustedBucketCount,
    expectedStepId: horizonPlan.expectedStepId,
    budgetExemptApplied: objective.rescue?.exemptFromBudget === 'always'
      && isCurrentBucketPlanned(horizonPlan),
    limitLowerPriorityApplied: objective.rescue?.limitLowerPriorityDevices === 'always',
    pauseLowerPriorityApplied: objective.rescue?.pauseLowerPriorityDevices === 'always',
    horizonPlan,
  };
};
