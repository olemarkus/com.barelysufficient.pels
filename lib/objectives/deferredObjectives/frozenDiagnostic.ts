import { buildAllocatedTaskEvaluation } from './taskEvaluationProducer';
import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveEnergyResolution } from './profileEnergyResolution';
import type { DeferredObjectiveProgressResolution } from './diagnosticProgress';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';
import { buildFrozenHorizonPlan, type FrozenReadInputs } from './frozenHorizonPlan';
import {
  buildDeferredObjectivePolicyHorizon,
  type DeferredObjectivePolicyHorizonResult,
} from './policyHorizon';
import type { DeferredObjectiveSettingsEntry } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { DeferredObjectiveStep } from './types';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import type { ObjectiveProgressDirectionRead } from '../../objectives/types';
import {
  buildKnownEnergyFields,
  mergeProgressFields,
} from './diagnosticFields';


const ONE_HOUR_MS = 60 * 60 * 1000;

// Persisted-cause classification for the frozen read. `isOptionalFloorShortfallCause`
// (`activePlanSettings.ts`) deliberately admits ANY string, so a cause written by a
// newer build survives rehydration on an older one. That was harmless while the field
// only fed UI recourse copy; it now feeds a control decision through
// `resolveCurrentHourClaim`.
//
// This changes no behaviour today — an unrecognised string already misses that
// resolver's known-cause set and degrades to `'released'`. It makes the degradation
// INTENTIONAL rather than incidental: the adapter that reads persisted settings owns
// the complete classification (root `AGENTS.md`, "Validation belongs at the
// boundary"), so a later change to how the resolver handles an unmatched cause cannot
// silently turn an unknown string into a claim on the hour. Non-string garbage cannot
// reach here — the validator rejects it — so `'none'` covers both absence and any
// forward-compat string.
const KNOWN_FLOOR_SHORTFALL_CAUSES: ReadonlySet<string> = new Set([
  'budget', 'step_power', 'estimate', 'time_capacity', 'none',
]);
const toKnownFloorShortfallCause = (
  value: DeferredObjectiveActivePlanFloorShortfallCause | undefined,
): DeferredObjectiveActivePlanFloorShortfallCause => (
  typeof value === 'string' && KNOWN_FLOOR_SHORTFALL_CAUSES.has(value) ? value : 'none'
);

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
  progressDirection: ObjectiveProgressDirectionRead;
  nowMs: number;
}): FrozenReadInputs | null => {
  const activePlan = resolveActiveCommittedPlan({
    activePlans: params.activePlans,
    deviceId: params.deviceId,
    objective: params.objective,
    progressDirection: params.progressDirection,
  });
  if (activePlan === undefined) return null;
  const currentHourStartMs = Math.floor(params.nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
  if (!activePlan.commitmentHours.some((hour) => hour.startsAtMs >= currentHourStartMs)) return null;
  const { latest } = activePlan;
  return {
    planStatus: latest.planStatus,
    floorShortfallCause: toKnownFloorShortfallCause(latest.floorShortfallCause),
    budgetContributedToShortfall: latest.budgetContributedToShortfall === true,
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
  progressDirection: ObjectiveProgressDirectionRead;
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
  progress: Extract<DeferredObjectiveProgressResolution, { reasonCode: null }>;
  objective: DeferredObjectiveSettingsEntry;
  deviceId: string;
  profileEnergy: Extract<DeferredObjectiveEnergyResolution, { reasonCode: null }>;
  aheadOfHourMilestone: boolean;
  steps: DeferredObjectiveStep[];
  frozenRead: FrozenReadInputs;
  // Log-visibility marker (see `diagnosticTypes.ts`): this frozen serve bridges a
  // live step-ladder gap, so `steps` is empty and `expectedStepId` resolves null.
  liveStepsUnavailable?: boolean;
}): DeferredObjectiveDiagnostic => {
  const {
    nowMs, base, progress, objective, deviceId,
    profileEnergy, aheadOfHourMilestone, steps, frozenRead,
  } = params;
  const horizonPlan = buildFrozenHorizonPlan({
    nowMs,
    deviceId,
    objective,
    frozenRead,
    energyNeededKWh: profileEnergy.energyNeededKWh,
    aheadOfHourMilestone,
    steps,
  });
  const evaluation = buildAllocatedTaskEvaluation(deviceId, objective, progress, horizonPlan);
  return {
    ...mergeProgressFields(base, progress.currentValue),
    evaluation,
    completion: evaluation.completion,
    trajectory: { kind: 'resolved', status: horizonPlan.status },
    reasonCode: horizonPlan.statusDetail,
    ...buildKnownEnergyFields({ objective, profileEnergy }),
    horizonBucketCount: frozenRead.hours.length,
    expectedStepId: horizonPlan.expectedStepId,
    ...(params.liveStepsUnavailable === true ? { liveStepsUnavailable: true as const } : {}),
    budgetExemptApplied: evaluation.permissions.budgetExempt
      && evaluation.planning.kind === 'allocated' && evaluation.planning.plan.currentHourClaim === 'claimed',
    limitLowerPriorityApplied: evaluation.permissions.limitLowerPriority,
    pauseLowerPriorityApplied: evaluation.permissions.pauseLowerPriority,
    horizonPlan,
  };
};
