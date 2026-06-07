import type { PowerTrackerState } from '../../power/tracker';
import {
  resolveProfileEnergy,
  type DeferredObjectiveEnergyResolution,
  type DeferredObjectiveKwhPerUnitSource,
} from './profileEnergyResolution';
import { buildDeferredObjectiveDebugPayload } from './diagnosticDebugPayload';
import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import { getLogger } from '../../logging/logger';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlansV1,
  DeferredObjectiveActivePlanStatusV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { formatDeadlineLocalTime } from './deadline';
import { resolveHorizonPlanWithRescue } from './rescueReplan';
import { resolveObjectiveSteps } from './objectiveSteps';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';
import { isAheadOfHourMilestone } from './trajectoryMilestone';
import { isPastHourSettleMark } from './settleWindow';
import { buildFrozenHorizonPlan } from './frozenHorizonPlan';
import { resolvePlanningSpeedKw } from './planningSpeed';
import {
  resolveObjectiveProgress,
  type DeferredObjectiveProgressResolution,
} from './diagnosticProgress';
import type { DeferredObjectiveKind } from './types';
import {
  classificationImpliesStallSatisfied,
  type IdleClassification,
} from '../../../packages/shared-domain/src/idleClassificationCopy';
import {
  buildDeferredObjectivePolicyHorizon,
  type DeferredObjectivePolicyHorizonResult,
  type DeferredObjectivePolicyHorizonUnavailableReason,
} from './policyHorizon';
import type {
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from './settings';
import {
  ConcurrentEligibleTaskTracker,
  resolveConcurrentEligibleCount,
} from './concurrentEligibleTasks';
import type { DeferredObjectiveHorizonPlan, DeferredObjectiveStep } from './types';

// Frozen mid-hour metadata sourced from the coherent active committed-plan view.
// Present ⇒ the per-cycle path reads the frozen plan instead of running the
// allocator (see `buildFrozenHorizonPlan`).
type FrozenReadInputs = {
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

// Energy resolution for an already-satisfied objective (`remainingUnits <= 0`):
// no energy needed, no rate consulted.
const ZERO_ENERGY_RESOLUTION: DeferredObjectiveEnergyResolution = {
  energyNeededKWh: 0,
  energyExpectedKWh: 0,
  kWhPerUnit: null,
  kWhPerUnitBuffered: null,
  kWhPerUnitMean: null,
  rateConfidence: null,
  displayConfidence: null,
  kwhPerUnitSource: null,
  reasonCode: null,
};

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

const resolveDeadlineBoundFrozenReadInputs = (params: {
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
const EMPTY_POLICY_HORIZON: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }> = {
  buckets: [],
  horizonBucketCount: 0,
  dailyBudgetExhaustedBucketCount: 0,
  reasonCode: null,
};

type DeferredObjectivePolicyHorizonParams = Parameters<typeof buildDeferredObjectivePolicyHorizon>[0];

const buildDeadlineAwarePolicyHorizon = (
  params: DeferredObjectivePolicyHorizonParams,
): DeferredObjectivePolicyHorizonResult => (
  params.deadlineAtMs <= params.nowMs ? EMPTY_POLICY_HORIZON : buildDeferredObjectivePolicyHorizon(params)
);

// Assemble the diagnostic from the persisted commitment + live measured value
// (folded into `aheadOfHourMilestone`), skipping the allocator. Mirrors the shape
// `buildDiagnosticWithPolicyHorizon` returns on the fresh path.
const buildFrozenDiagnostic = (params: {
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
    horizonPlan,
  };
};

const logger = getLogger('plan/deferred-diag-bridge');

export type DeferredObjectiveDiagnosticReasonCode =
  | DeferredObjectivePolicyHorizonUnavailableReason
  | 'objective_charger_not_resumable'
  | 'objective_invalid_deadline'
  | 'objective_invalid_session'
  | 'objective_missing_capacity'
  | 'objective_missing_charge_rate'
  | 'objective_missing_device'
  | 'objective_missing_temperature'
  | 'objective_progress_stale'
  // Live status resolved to `satisfied` because the device parked in a stall
  // classification (see `resolveStallReportedStatus`). `near_target` = inside
  // the hysteresis band; `device_capped` = at the device's own internal cap.
  | 'objective_stalled_near_target'
  | 'objective_stalled_device_capped';

export type { DeferredObjectiveKwhPerUnitSource } from './profileEnergyResolution';

type BaseDeferredObjectiveDiagnostic = {
  deviceId: string;
  deviceName?: string;
  objectiveId: string;
  enforcement: DeferredObjectiveSettingsEntry['enforcement'];
  status: 'unknown' | DeferredObjectiveHorizonPlan['status'];
  reasonCode: DeferredObjectiveDiagnosticReasonCode | DeferredObjectiveHorizonPlan['statusDetail'];
  targetPercent: number | null;
  currentPercent: number | null;
  deadlineAtMs: number | null;
  deadlineLocalTime: string;
  energyNeededKWh: number | null;
  // Mean-based estimate (no variance buffer). Pairs with the buffered
  // `energyNeededKWh` so the UI can render an `expected…planned` range. Omitted
  // on the unresolved paths; absent or equal to `energyNeededKWh` means there is
  // no buffer to show (cold-start, bootstrap, steady device).
  energyExpectedKWh?: number | null;
  kWhPerPercent: number | null;
  kWhPerDegreeC: number | null;
  // Buffered per-unit rate (`energyNeededKWh / remainingUnits`), kind-agnostic.
  // The buffered-currency analog of the mean `kWhPerPercent`/`kWhPerDegreeC`.
  // Consumed by the unit-milestone stamp so the cumulative milestone lands on
  // target instead of overshooting by the buffer ratio. Optional/back-compatible:
  // absent on legacy diagnostics, where the stamp falls back to the mean rate.
  kWhPerUnitBuffered?: number | null;
  // Sample-driven global learned mean (kWh/unit), kind-agnostic. Distinct from
  // the kind-split `kWhPerPercent`/`kWhPerDegreeC`, which are the banded
  // remaining-interval display average and so shift as a task crosses bands.
  // This only moves on genuine rate drift, so it is the stable statistic the
  // active-plan recorder's `measured_deviation` detector compares. Null on
  // bootstrap / unresolved. See `profileEnergyResolution.kWhPerUnitMean`.
  kwhPerUnitLearnedMean: number | null;
  rateConfidence: string | null;
  // Band-aware aggregated confidence for the smart-task chip. Honest about
  // whether the *model in use* (bands integrated for this resolution) is
  // well-supported, instead of the raw per-sample CV which sits at "low" on
  // thermal devices effectively forever. Null on bootstrap / unresolved.
  displayConfidence: 'low' | 'medium' | 'high' | null;
  kwhPerUnitSource: DeferredObjectiveKwhPerUnitSource | null;
  // Number of accepted samples that produced the learned profile mean. Zero
  // when `kwhPerUnitSource` is `bootstrap` or null. Surfaced so the UI can
  // explain EV learning progress without re-reading the profile store.
  kwhPerUnitAcceptedSamples: number;
  // UTC ms of the last accepted sample. Null when no learned profile exists
  // yet (bootstrap or unresolved).
  kwhPerUnitLastAcceptedAtMs: number | null;
  // The "useful" planning power in kW that the planner would commit per
  // active hour. For stepped devices this is the lowest non-zero step's
  // useful power; for binary devices (EV chargers) it is the single step's
  // useful power. Null when no steps were resolvable. Surfaced as the
  // "Y.Y kW" speed-mode reading in the hero meta line.
  planningSpeedKw: number | null;
  // Planning-affecting rescue permissions participate in the active-plan signature
  // so permission edits invalidate stale committed schedules.
  rescue?: DeferredObjectiveRescuePermissions;
  horizonBucketCount: number;
  // Number of buckets in the horizon whose per-bucket cap collapsed to zero
  // because the daily budget cap had already been reached at the start of the
  // bucket. Lets the UI explain a `cannot_meet` outcome that would otherwise
  // look like a device or schedule problem.
  dailyBudgetExhaustedBucketCount: number;
  expectedStepId: string | null;
  horizonPlan?: DeferredObjectiveHorizonPlan;
  // True only while the current bucket is a planned bucket for a smart task whose "exempt
  // from budget" rescue permission is active. Admission consumes this flat flag to set the
  // device's existing `budgetExempt` for that bucket; idle/background cycles stay normal.
  budgetExemptApplied?: boolean;
  // True when the "limit lower-priority devices" rescue permission is granted (mode
  // 'always'). Admission consumes this flat flag to engage the device's boost while the
  // task is in its planned hours, so the existing escalation/shedding machinery claims
  // capacity from lower-priority devices. Producer resolves it; consumers don't re-derive.
  limitLowerPriorityApplied?: boolean;
};

// Discriminated by `objectiveKind`. Temperature variants always carry a
// numeric `targetTemperatureC` (the setting requires it); EV variants omit
// both temperature fields entirely so consumers can't accidentally read
// them. `currentTemperatureC` stays `number | null` on the temperature
// variant because sensor reads can legitimately fail.
export type DeferredObjectiveDiagnostic =
  | (BaseDeferredObjectiveDiagnostic & {
    objectiveKind: 'temperature';
    targetTemperatureC: number;
    currentTemperatureC: number | null;
  })
  | (BaseDeferredObjectiveDiagnostic & {
    objectiveKind: 'ev_soc';
    targetTemperatureC?: never;
    currentTemperatureC?: never;
  });

export const buildDeferredObjectiveDiagnostics = (params: {
  nowMs: number;
  timeZone: string;
  devices: ObjectiveDeviceInput[];
  settings: DeferredObjectiveSettingsV1;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  priceOptimizationEnabled: boolean;
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  hardCapKw?: number | null;
  // Optional stateful tracker that remembers each eligible device across
  // cycles so a transient SDK-side device-snapshot eviction does not flicker
  // the eligibility count downward for one cycle (`feedback_homey_sdk_unreliable`).
  // The tracker also caches each task's deadline so per-bucket counts can drop
  // tasks once their deadline has passed (late-horizon buckets). Callers that
  // omit it fall back to a one-shot count, which is fine for tests but lets
  // verdicts flicker in production — see the rationale on
  // `ConcurrentEligibleTaskTracker`.
  concurrentEligibleTracker?: ConcurrentEligibleTaskTracker;
  // Idle-classifier reader. When provided, the live (user-facing) status is
  // resolved to `satisfied` for devices parked in a stall classification so the
  // status chip, notifications and Flows agree with the postmortem recorder
  // (which already promotes such runs to `satisfied(stalled)`). The decoration /
  // actuation path deliberately OMITS this so admission keeps reading the raw
  // trajectory status — only `horizonPlan.status` (untouched) drives commitment.
  getStallClassification?: (deviceId: string) => IdleClassification | undefined;
}): DeferredObjectiveDiagnostic[] => {
  const deviceById = new Map(params.devices.map((device) => [device.id, device]));
  // Resolve the priority-1 fully-reserved smart-task count once per cycle so
  // the per-task `policyHorizon` producer can split each bucket's reserved
  // headroom equally across siblings instead of each eligible task promoting
  // to the full forecast and double-booking the slot. With a tracker present
  // we hand the producer a per-bucket resolver so a task whose deadline has
  // passed mid-horizon stops counting in later buckets' denominators; without
  // one we fall back to the legacy one-shot count.
  const concurrentEligibleCount = resolveConcurrentEligibleCount({
    settings: params.settings,
    deviceById,
    nowMs: params.nowMs,
    tracker: params.concurrentEligibleTracker,
  });
  return Object.entries(params.settings.objectivesByDeviceId)
    .flatMap(([deviceId, objective]) => {
      if (!objective.enabled) return [];
      const diagnostic = buildDeferredObjectiveDiagnostic({
        ...params,
        deviceId,
        objective,
        device: deviceById.get(deviceId),
        concurrentEligibleCount,
      });
      return [resolveStallReportedStatus(
        diagnostic,
        params.getStallClassification?.(deviceId),
        hasEstablishedActivePlan(params.activePlans, deviceId, diagnostic.deadlineAtMs),
      )];
    });
};

// True once the active-plan recorder has committed a `latest` revision for this
// exact (device, deadline) run. Used to suppress stall resolution on a
// first-seen task: the idle classifier ticks AFTER plan emission and is keyed by
// device only, so on a brand-new objective's first cycle `getStallClassification`
// returns the PREVIOUS cycle's verdict — which belongs to whatever ran on that
// device before. Resolving on that stale value would flash a brand-new deadline
// as `satisfied` (and could write a first revision / fire a Flow) until the
// classifier re-ticks. Mirrors the postmortem's "skip stall promotion on
// first-seen records" guard (planHistory `observeDiagnostic`). Inlined rather
// than reusing `findPlanForRecord` to avoid a diagnosticsBridge↔planHistory
// import cycle.
const hasEstablishedActivePlan = (
  activePlans: DeferredObjectiveActivePlansV1 | null | undefined,
  deviceId: string,
  deadlineAtMs: number | null,
): boolean => {
  if (deadlineAtMs === null) return false;
  const plan = activePlans?.plansByDeviceId[deviceId];
  return plan?.deadlineAtMs === deadlineAtMs && plan?.latest != null;
};

// Resolve the user-facing `status` (NOT `horizonPlan.status`, which stays the
// raw trajectory verdict) when the device's own controller has parked it: a
// `near_target_idle` / `capped_idle` device won't move further, so the
// objective is "as met as it gets". Only the live trajectory verdicts are
// overridden — `unknown` / `invalid` / an already-`satisfied` run are left
// alone, and `unresponsive` (a likely fault) never counts as satisfied
// (`classificationImpliesStallSatisfied`). Mirrors the postmortem's
// `stallClassificationToMetReason`.
const STALL_RESOLVABLE_STATUSES = new Set<DeferredObjectiveDiagnostic['status']>([
  'on_track',
  'at_risk',
  'cannot_meet',
]);

const resolveStallReportedStatus = (
  diagnostic: DeferredObjectiveDiagnostic,
  classification: IdleClassification | undefined,
  hasEstablishedPlan: boolean,
): DeferredObjectiveDiagnostic => {
  // First-seen tasks read a stale, device-keyed classifier verdict — wait until
  // the run is established (a committed revision exists) so the classification
  // belongs to THIS objective. See `hasEstablishedActivePlan`.
  if (!hasEstablishedPlan) return diagnostic;
  if (!classificationImpliesStallSatisfied(classification)) return diagnostic;
  if (!STALL_RESOLVABLE_STATUSES.has(diagnostic.status)) return diagnostic;
  return {
    ...diagnostic,
    status: 'satisfied',
    reasonCode: classification === 'capped_idle'
      ? 'objective_stalled_device_capped'
      : 'objective_stalled_near_target',
  };
};

export const emitDeferredObjectiveDiagnostics = (params: {
  diagnostics: DeferredObjectiveDiagnostic[];
  debugStructured?: StructuredDebugEmitter;
}): void => {
  const { diagnostics, debugStructured } = params;
  for (const diagnostic of diagnostics) {
    const payload = buildDeferredObjectiveDebugPayload(diagnostic);
    if (debugStructured) {
      debugStructured(payload);
    } else {
      logger.debug(payload);
    }
  }
};

// Maps the progress resolution back to a single input-value for the banded
// estimator. Temperature objectives integrate by °C, EV SoC objectives by %.
// `generic_energy` has no profile-band path so we return undefined and the
// estimator falls back to the global mean.
export const progressCurrentValue = (params: {
  progress: DeferredObjectiveProgressResolution;
  objectiveKind: DeferredObjectiveKind;
}): number | undefined => {
  const { progress, objectiveKind } = params;
  if (progress.reasonCode) return undefined;
  if (objectiveKind === 'ev_soc') {
    return typeof progress.currentPercent === 'number' ? progress.currentPercent : undefined;
  }
  if (objectiveKind === 'temperature') {
    return typeof progress.currentTemperatureC === 'number' ? progress.currentTemperatureC : undefined;
  }
  return undefined;
};

const canReportFreshProgressWhileUnknown = (reasonCode: DeferredObjectiveDiagnosticReasonCode): boolean => (
  reasonCode === 'objective_missing_price_horizon'
    || reasonCode === 'objective_price_feature_disabled'
);

// Single entry point for resolving learned/buffered energy from progress, so
// both diagnostic paths pass the objective's enforcement (which sets the
// variance buffer `k`) and current value identically.
const resolveProgressEnergy = (params: {
  powerTracker: PowerTrackerState;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  remainingUnits: number;
  progress: DeferredObjectiveProgressResolution;
}): DeferredObjectiveEnergyResolution => resolveProfileEnergy({
  powerTracker: params.powerTracker,
  deviceId: params.deviceId,
  objectiveKind: params.objective.kind,
  enforcement: params.objective.enforcement,
  remainingUnits: params.remainingUnits,
  currentValue: progressCurrentValue({ progress: params.progress, objectiveKind: params.objective.kind }),
});

// Variant-preserving merge of progress-derived fields onto an existing
// diagnostic. The discriminated union forbids assigning
// `currentTemperatureC` on the EV variant, so we branch on the diagnostic's
// own `objectiveKind` rather than spreading both fields blindly.
const mergeProgressFields = (
  base: DeferredObjectiveDiagnostic,
  currentPercent: number | null,
  currentTemperatureC: number | null,
): DeferredObjectiveDiagnostic => {
  if (base.objectiveKind === 'temperature') {
    return { ...base, currentPercent, currentTemperatureC };
  }
  return { ...base, currentPercent };
};

const buildPolicyGatedKnownInputs = (
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

// Exported so the plan-preview composition (`previewDeferredObjectivePlan`)
// can build a diagnostic for a single CANDIDATE objective through the exact
// same pipeline the live cycle uses — guaranteeing the preview's horizon plan
// matches what the planner would produce. Preview callers omit `activePlans`
// (a candidate has no committed schedule) and `concurrentEligibleCount` (it is
// projected in isolation, so it sees the single-task share).
export const buildDeferredObjectiveDiagnostic = (params: {
  nowMs: number;
  timeZone: string;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  device?: ObjectiveDeviceInput;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  priceOptimizationEnabled: boolean;
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  hardCapKw?: number | null;
  concurrentEligibleCount?: number | ((bucketStartMs: number) => number);
}): DeferredObjectiveDiagnostic => {
  const {
    nowMs,
    timeZone,
    deviceId,
    objective,
    device,
    powerTracker,
    dailyBudgetSnapshot,
    priceOptimizationEnabled,
    activePlans,
  } = params;
  const base = buildDiagnosticBase({
    deviceId,
    device,
    objective,
    timeZone,
    powerTracker,
    currentPercent: null,
    currentTemperatureC: null,
    energyNeededKWh: null,
    kWhPerPercent: null,
    kWhPerDegreeC: null,
    rateConfidence: null,
    displayConfidence: null,
    kwhPerUnitSource: null,
  });
  if (!device) return withUnknown(base, 'objective_missing_device');

  if (!Number.isFinite(objective.deadlineAtMs) || objective.deadlineAtMs <= 0) {
    return withUnknown(base, 'objective_invalid_deadline');
  }
  const withDeadline = base;
  const progress = resolveObjectiveProgress({ objective, device, nowMs });
  if (!progress.reasonCode && progress.remainingUnits <= 0) {
    return buildDiagnosticWithPolicyHorizon({
      nowMs,
      deviceId,
      objective,
      device,
      powerTracker,
      base: withDeadline,
      progress,
      policyHorizon: { buckets: [], horizonBucketCount: 0, dailyBudgetExhaustedBucketCount: 0, reasonCode: null },
      deadlineAtMs: objective.deadlineAtMs,
      priceOptimizationEnabled,
      dailyBudgetSnapshot,
      activePlans,
      hardCapKw: params.hardCapKw,
      concurrentEligibleCount: params.concurrentEligibleCount,
    });
  }

  // Per-cycle (mid-hour) frozen read: between hour settles the committed set,
  // per-hour kWh and unit milestones are immutable, so the mid-hour path skips the
  // bucket ALLOCATOR and assembles the plan from the persisted commitment + live
  // measured. Re-planning (running the allocator) happens only when it is DUE and
  // POSSIBLE: at bootstrap (no committed fallback ⇒ `resolveCommittedHours`
  // undefined / empty / all-elapsed — also covers an objective edit via the
  // signature check), or at the `:58` settle when the price horizon is available.
  // Otherwise we serve the frozen commitment — a committed device is NEVER dropped
  // to inactive for want of a live horizon (transient price/budget-snapshot gap, or
  // a gap that coincides with the settle window). See
  // notes/deferred-load-objectives/execution-adaptation.md.
  const frozenFallback = resolveDeadlineBoundFrozenReadInputs({ activePlans, deviceId, objective, nowMs });
  const rawPolicyHorizon = buildDeadlineAwarePolicyHorizon({
    nowMs,
    deadlineAtMs: objective.deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
    hardCapKw: params.hardCapKw,
    concurrentEligibleCount: params.concurrentEligibleCount,
  });
  // Price optimization turned OFF is a deliberate config state, not a transient data
  // gap: the deferred objective is price-dependent, so it goes inactive (the device
  // returns to normal control) — exactly as before C. We must NOT keep serving the
  // stale price-optimized commitment frozen here. Only a transient
  // `objective_missing_price_horizon` (SDK read gap) is served frozen below.
  if (rawPolicyHorizon.reasonCode === 'objective_price_feature_disabled') {
    const knownInputs = buildPolicyGatedKnownInputs(
      withDeadline,
      progress,
      rawPolicyHorizon.reasonCode,
      { powerTracker, deviceId, objective },
    );
    return withUnknown({
      ...knownInputs,
      horizonBucketCount: rawPolicyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: rawPolicyHorizon.dailyBudgetExhaustedBucketCount,
    }, rawPolicyHorizon.reasonCode);
  }
  const horizonAvailable = rawPolicyHorizon.reasonCode === null;
  const replan = !frozenFallback || (isPastHourSettleMark(nowMs) && horizonAvailable);
  if (replan && rawPolicyHorizon.reasonCode !== null) {
    // Bootstrap (or empty/all-elapsed commitment) with no usable horizon (transient
    // `objective_missing_price_horizon`): nothing to serve frozen, can't allocate → unknown.
    const knownInputs = buildPolicyGatedKnownInputs(
      withDeadline,
      progress,
      rawPolicyHorizon.reasonCode,
      { powerTracker, deviceId, objective },
    );
    return withUnknown({
      ...knownInputs,
      horizonBucketCount: rawPolicyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: rawPolicyHorizon.dailyBudgetExhaustedBucketCount,
    }, rawPolicyHorizon.reasonCode);
  }
  const policyHorizon = rawPolicyHorizon.reasonCode === null ? rawPolicyHorizon : EMPTY_POLICY_HORIZON;

  return buildDiagnosticWithPolicyHorizon({
    nowMs,
    deviceId,
    objective,
    device,
    powerTracker,
    base: withDeadline,
    progress,
    policyHorizon,
    deadlineAtMs: objective.deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
    activePlans,
    hardCapKw: params.hardCapKw,
    concurrentEligibleCount: params.concurrentEligibleCount,
    // Serve frozen unless we are re-planning; `replan` already required the horizon
    // to be available, so the fresh path always has a usable `policyHorizon`.
    frozenRead: replan ? null : frozenFallback,
  });
};

const buildDiagnosticWithPolicyHorizon = (params: {
  nowMs: number;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  device: ObjectiveDeviceInput;
  powerTracker: PowerTrackerState;
  base: DeferredObjectiveDiagnostic;
  progress: DeferredObjectiveProgressResolution;
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>;
  deadlineAtMs: number;
  priceOptimizationEnabled: boolean;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  hardCapKw?: number | null;
  concurrentEligibleCount?: number | ((bucketStartMs: number) => number);
  frozenRead?: FrozenReadInputs | null;
}): DeferredObjectiveDiagnostic => {
  const {
    nowMs,
    deviceId,
    objective,
    device,
    powerTracker,
    base,
    progress,
    policyHorizon,
    deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
    activePlans,
    frozenRead,
  } = params;
  if (progress.reasonCode) {
    return withUnknown({
      ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
      horizonBucketCount: policyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    }, progress.reasonCode);
  }

  const profileEnergy: DeferredObjectiveEnergyResolution = progress.remainingUnits > 0
    ? resolveProgressEnergy({ powerTracker, deviceId, objective, remainingUnits: progress.remainingUnits, progress })
    : ZERO_ENERGY_RESOLUTION;
  if (profileEnergy.reasonCode) {
    return withUnknown({
      ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
      horizonBucketCount: policyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    }, profileEnergy.reasonCode);
  }

  const steps = profileEnergy.energyNeededKWh > 0 ? resolveObjectiveSteps(device) : [];
  if (profileEnergy.energyNeededKWh > 0 && steps.length === 0) {
    return withUnknown({
      ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
      ...buildKnownEnergyFields({ objective, profileEnergy }),
      horizonBucketCount: policyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    }, 'objective_missing_charge_rate');
  }

  const activeCommittedPlan = resolveActiveCommittedPlan({
    activePlans,
    deviceId,
    objective,
  });
  const commitment = activeCommittedPlan?.commitmentHours;
  const milestoneHours = frozenRead ? frozenRead.hours : (activeCommittedPlan?.latest.hours ?? []);
  // Trajectory gate for mid-execution price deferral. Resolved here (not in the
  // planner) because it compares the buffered energy still needed
  // (`profileEnergy.energyNeededKWh`, derived from the RAW measured value) against
  // the committed plan's future hours — the planner sees neither the measured
  // value nor the committed/frozen hours. Use the SAME latest-hour source that
  // drives `buildFrozenHorizonPlan`; same-schedule settle revisions can refine
  // milestones in `latest` while leaving the allocator's commitment envelope
  // intact. No hours ⇒ never ahead.
  //
  // PRECONDITION: this point is only reached on `progress.reasonCode === null`
  // (every stale/missing/invalid read short-circuits to `withUnknown` above) and
  // `energyNeededKWh` is the buffered floor for the current remaining units. A
  // stale read returns `remainingUnits: 0 ⇒ energyNeededKWh: 0`, which would
  // falsely read "ahead" — so the gate must never be relocated past that guard.
  const aheadOfHourMilestone = isAheadOfHourMilestone({
    energyNeededKWh: profileEnergy.energyNeededKWh,
    // Live measured progress in the objective's own unit — drives the preferred
    // unit-milestone comparison (rate-free); `energyNeededKWh` is the legacy
    // fallback for commitments without persisted `plannedUnitMilestone`.
    measuredValue: progressCurrentValue({ progress, objectiveKind: objective.kind }),
    committedHours: milestoneHours,
    nowMs,
  });
  // Mid-hour frozen read: assemble from the persisted commitment + the live measured
  // value (folded into `aheadOfHourMilestone`), skipping the allocator. The caller
  // sets `frozenRead` exactly when it has decided to serve frozen rather than
  // re-plan, so this is a pure gate — no cold-start determination here (the device
  // delivers up to the committed hour's milestone; whether the current hour was
  // booked at all is the allocator's `:58` decision, read off the commitment).
  if (frozenRead) {
    return buildFrozenDiagnostic({
      nowMs,
      base,
      progress,
      objective,
      deviceId,
      deadlineAtMs,
      profileEnergy,
      aheadOfHourMilestone,
      steps,
      frozenRead,
    });
  }
  return buildFreshDiagnostic({
    nowMs,
    deviceId,
    objective,
    device,
    base,
    progress,
    policyHorizon,
    deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
    steps,
    commitment,
    aheadOfHourMilestone,
    profileEnergy,
    hardCapKw: params.hardCapKw,
    concurrentEligibleCount: params.concurrentEligibleCount,
  });
};

// Fresh-path diagnostic: run the allocator (via the rescue resolver) and shape the
// result. The bootstrap / `:58`-settle counterpart to `buildFrozenDiagnostic`.
const buildFreshDiagnostic = (params: {
  nowMs: number;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  device: ObjectiveDeviceInput;
  base: DeferredObjectiveDiagnostic;
  progress: DeferredObjectiveProgressResolution;
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>;
  deadlineAtMs: number;
  priceOptimizationEnabled: boolean;
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
    priceOptimizationEnabled, dailyBudgetSnapshot, steps, commitment, aheadOfHourMilestone, profileEnergy,
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

  return {
    ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
    status: horizonPlan.status,
    reasonCode: horizonPlan.statusDetail,
    ...buildKnownEnergyFields({ objective, profileEnergy }),
    horizonBucketCount: policyHorizon.horizonBucketCount,
    dailyBudgetExhaustedBucketCount,
    expectedStepId: horizonPlan.expectedStepId,
    budgetExemptApplied: objective.rescue?.exemptFromBudget === 'always'
      && isCurrentBucketPlanned(horizonPlan),
    limitLowerPriorityApplied: objective.rescue?.limitLowerPriorityDevices === 'always',
    horizonPlan,
  };
};

// "Is the current bucket actually running this cycle?" — gates the
// `budgetExemptApplied` diagnostic. A price-deferral-eligible OR cold-start-released
// hour is released (admission idles the device), so the budget exemption is NOT
// active even though the committed bucket still carries booked energy; report it
// false so the structured log matches what the device is actually doing. Mirrors
// admission's `isReleasedCurrentHour` for the booked-but-released cases.
const isCurrentBucketPlanned = (horizonPlan: DeferredObjectiveHorizonPlan): boolean => (
  !horizonPlan.priceDeferralEligible
  && !horizonPlan.coldStartReleaseEligible
  && (horizonPlan.currentBucket?.plannedUsefulEnergyKWh ?? 0) > 0
);

const buildDiagnosticBase = (params: {
  deviceId: string;
  device?: ObjectiveDeviceInput;
  objective: DeferredObjectiveSettingsEntry;
  timeZone: string;
  powerTracker: PowerTrackerState;
  currentPercent: number | null;
  currentTemperatureC: number | null;
  energyNeededKWh: number | null;
  kWhPerPercent: number | null;
  kWhPerDegreeC: number | null;
  rateConfidence: string | null;
  displayConfidence: 'low' | 'medium' | 'high' | null;
  kwhPerUnitSource: DeferredObjectiveKwhPerUnitSource | null;
}): DeferredObjectiveDiagnostic => {
  const deadlineAtMs = Number.isFinite(params.objective.deadlineAtMs) && params.objective.deadlineAtMs > 0
    ? params.objective.deadlineAtMs
    : null;
  const profileSnapshot = resolveProfileSnapshot({
    powerTracker: params.powerTracker,
    deviceId: params.deviceId,
    objectiveKind: params.objective.kind,
  });
  const common: BaseDeferredObjectiveDiagnostic = {
    deviceId: params.deviceId,
    deviceName: params.device?.name,
    objectiveId: `${params.deviceId}:${params.objective.kind}`,
    enforcement: params.objective.enforcement,
    ...(params.objective.rescue ? { rescue: params.objective.rescue } : {}),
    status: 'unknown',
    reasonCode: 'objective_progress_stale',
    targetPercent: params.objective.kind === 'ev_soc' ? params.objective.targetPercent : null,
    currentPercent: params.currentPercent,
    deadlineAtMs,
    deadlineLocalTime: deadlineAtMs !== null ? formatDeadlineLocalTime(deadlineAtMs, params.timeZone) : '',
    energyNeededKWh: params.energyNeededKWh,
    kWhPerPercent: params.kWhPerPercent,
    kWhPerDegreeC: params.kWhPerDegreeC,
    // Base default; resolved diagnostics override via `buildKnownEnergyFields`.
    kwhPerUnitLearnedMean: null,
    rateConfidence: params.rateConfidence,
    displayConfidence: params.displayConfidence,
    kwhPerUnitSource: params.kwhPerUnitSource,
    kwhPerUnitAcceptedSamples: profileSnapshot.acceptedSamples,
    kwhPerUnitLastAcceptedAtMs: profileSnapshot.lastAcceptedAtMs,
    planningSpeedKw: resolvePlanningSpeedKw(params.device),
    horizonBucketCount: 0,
    dailyBudgetExhaustedBucketCount: 0,
    expectedStepId: null,
  };
  if (params.objective.kind === 'temperature') {
    return {
      ...common,
      objectiveKind: 'temperature',
      targetTemperatureC: params.objective.targetTemperatureC,
      currentTemperatureC: params.currentTemperatureC,
    };
  }
  return {
    ...common,
    objectiveKind: 'ev_soc',
  };
};

// Pulls accepted-sample provenance from the active learned profile. Returns
// zeros / nulls when no profile or the profile's kind doesn't match the
// objective so legacy callers see safe defaults.
const resolveProfileSnapshot = (params: {
  powerTracker: PowerTrackerState;
  deviceId: string;
  objectiveKind: DeferredObjectiveSettingsEntry['kind'];
}): { acceptedSamples: number; lastAcceptedAtMs: number | null } => {
  const profile = params.powerTracker.objectiveProfiles?.[params.deviceId];
  if (!profile || profile.kind !== params.objectiveKind) {
    return { acceptedSamples: 0, lastAcceptedAtMs: null };
  }
  const lastAcceptedAtMs = profile.kwhPerUnit?.lastUpdatedMs ?? null;
  return {
    acceptedSamples: profile.acceptedSamples,
    lastAcceptedAtMs: Number.isFinite(lastAcceptedAtMs) ? lastAcceptedAtMs : null,
  };
};

const withUnknown = (
  diagnostic: DeferredObjectiveDiagnostic,
  reasonCode: DeferredObjectiveDiagnosticReasonCode,
): DeferredObjectiveDiagnostic => ({
  ...diagnostic,
  status: 'unknown',
  reasonCode,
  expectedStepId: null,
});

const buildKnownEnergyFields = (params: {
  objective: DeferredObjectiveSettingsEntry;
  profileEnergy: Extract<DeferredObjectiveEnergyResolution, { reasonCode: null }>;
}): Pick<
  DeferredObjectiveDiagnostic,
  'energyNeededKWh' | 'energyExpectedKWh' | 'kWhPerPercent' | 'kWhPerDegreeC'
  | 'kWhPerUnitBuffered' | 'kwhPerUnitLearnedMean' | 'rateConfidence' | 'displayConfidence' | 'kwhPerUnitSource'
> => ({
  energyNeededKWh: params.profileEnergy.energyNeededKWh,
  energyExpectedKWh: params.profileEnergy.energyExpectedKWh,
  kWhPerPercent: params.objective.kind === 'ev_soc' ? params.profileEnergy.kWhPerUnit : null,
  kWhPerDegreeC: params.objective.kind === 'temperature' ? params.profileEnergy.kWhPerUnit : null,
  kWhPerUnitBuffered: params.profileEnergy.kWhPerUnitBuffered,
  kwhPerUnitLearnedMean: params.profileEnergy.kWhPerUnitMean,
  rateConfidence: params.profileEnergy.rateConfidence,
  displayConfidence: params.profileEnergy.displayConfidence,
  kwhPerUnitSource: params.profileEnergy.kwhPerUnitSource,
});
