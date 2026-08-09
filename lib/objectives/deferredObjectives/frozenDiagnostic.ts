import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
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
  // The settled revision's verdict on what bound the floor schedule. Read rather
  // than recomputed so the mid-hour claim (`resolveCurrentHourClaim`) stays on the
  // hour-boundary clock the two-clock design puts control decisions on. Absent on
  // revisions an older build persisted, which resolve to `'none'` — the "task can
  // finish without this hour" reading, i.e. the pre-change release posture.
  floorShortfallCause: DeferredObjectiveActivePlanFloorShortfallCause;
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
    floorShortfallCause: toKnownFloorShortfallCause(latest.floorShortfallCause),
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
  // Log-visibility marker (see `diagnosticTypes.ts`): this frozen serve bridges a
  // live step-ladder gap, so `steps` is empty and `expectedStepId` resolves null.
  liveStepsUnavailable?: boolean;
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
    floorShortfallCause: frozenRead.floorShortfallCause,
    energyNeededKWh: profileEnergy.energyNeededKWh,
    aheadOfHourMilestone,
    steps,
    epsilonKWh: FROZEN_EPSILON_KWH,
  });
  return {
    ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
    trajectory: { kind: 'resolved', status: horizonPlan.status },
    reasonCode: horizonPlan.statusDetail,
    ...buildKnownEnergyFields({ objective, profileEnergy }),
    horizonBucketCount: frozenRead.hours.length,
    expectedStepId: horizonPlan.expectedStepId,
    ...(params.liveStepsUnavailable === true ? { liveStepsUnavailable: true as const } : {}),
    budgetExemptApplied: objective.rescue?.exemptFromBudget === 'always'
      && isCurrentBucketPlanned(horizonPlan),
    limitLowerPriorityApplied: objective.rescue?.limitLowerPriorityDevices === 'always',
    pauseLowerPriorityApplied: objective.rescue?.pauseLowerPriorityDevices === 'always',
    horizonPlan,
  };
};
