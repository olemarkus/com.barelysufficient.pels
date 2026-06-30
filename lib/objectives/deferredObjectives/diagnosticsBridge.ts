import type { PowerTrackerState } from '../../power/tracker';
import type {
  DeferredObjectiveEnergyResolution,
} from './profileEnergyResolution';
import { buildDeferredObjectiveDebugPayload } from './diagnosticDebugPayload';
import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import { getLogger } from '../../logging/logger';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type {
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { resolveObjectiveSteps } from './objectiveSteps';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';
import { isAheadOfHourMilestone } from './trajectoryMilestone';
import { isPastHourSettleMark } from './settleWindow';
import {
  resolveObjectiveProgress,
  type DeferredObjectiveProgressResolution,
} from './diagnosticProgress';
import {
  type DeferredObjectivePolicyHorizonResult,
  type PriceHorizonEntry,
} from './policyHorizon';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from './settings';
import {
  ConcurrentEligibleTaskTracker,
  resolveConcurrentEligibleCount,
} from './concurrentEligibleTasks';
import {
  classificationImpliesStallSatisfied,
  type IdleClassification,
} from '../../../packages/shared-domain/src/idleClassificationCopy';
import type {
  BuildPriceHorizon,
  DeferredObjectiveDiagnostic,
  DeferredObjectiveDiagnosticReasonCode,
} from './diagnosticTypes';
import {
  buildDiagnosticBase,
  buildKnownEnergyFields,
  mergeProgressFields,
  progressCurrentValue,
  resolveProgressEnergy,
  withUnknown,
  ZERO_ENERGY_RESOLUTION,
} from './diagnosticFields';
import {
  buildDeadlineAwarePolicyHorizon,
  buildFrozenDiagnostic,
  EMPTY_POLICY_HORIZON,
  resolveDeadlineBoundFrozenReadInputs,
  type FrozenReadInputs,
} from './frozenDiagnostic';
import {
  buildFreshDiagnostic,
  buildHorizonUnavailableDiagnostic,
} from './freshDiagnostic';

export type {
  BuildPriceHorizon,
  DeferredObjectiveDiagnostic,
  DeferredObjectiveDiagnosticReasonCode,
  DeferredObjectiveKwhPerUnitSource,
} from './diagnosticTypes';
export { progressCurrentValue } from './diagnosticFields';

const logger = getLogger('plan/deferred-diag-bridge');

export const buildDeferredObjectiveDiagnostics = (params: {
  nowMs: number;
  timeZone: string;
  devices: ObjectiveDeviceInput[];
  settings: DeferredObjectiveSettingsV1;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  // Price-layer source for the allocation horizon (price + grid), injected by
  // the wiring layer. The daily-budget snapshot above is now only the optional
  // budget overlay.
  buildPriceHorizon: BuildPriceHorizon;
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
  buildPriceHorizon: BuildPriceHorizon;
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
    buildPriceHorizon,
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
    kWhPerUnitBanded: null,
    rateConfidence: null,
    displayConfidence: null,
    kwhPerUnitSource: null,
  });
  if (!device) return withUnknown(base, 'objective_missing_device');

  if (!Number.isFinite(objective.deadlineAtMs) || objective.deadlineAtMs <= 0) {
    return withUnknown(base, 'objective_invalid_deadline');
  }
  const withDeadline = base;
  // Allocation-horizon price source, resolved by the wiring-injected producer.
  const priceHorizon = buildPriceHorizon(nowMs, objective.deadlineAtMs);
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
      policyHorizon: EMPTY_POLICY_HORIZON,
      deadlineAtMs: objective.deadlineAtMs,
      priceOptimizationEnabled,
      priceHorizon,
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
    priceHorizon,
    dailyBudgetSnapshot,
    hardCapKw: params.hardCapKw,
    concurrentEligibleCount: params.concurrentEligibleCount,
  });
  // Price optimization turned OFF is a deliberate config state, not a transient data
  // gap: the deferred objective is price-dependent, so it goes inactive (the device
  // returns to normal control) — exactly as before C. We must NOT keep serving the
  // stale price-optimized commitment frozen here. Only a transient
  // `objective_missing_price_horizon` (SDK read gap) is served frozen below.
  const unavailableCtx = { powerTracker, deviceId, objective };
  if (rawPolicyHorizon.reasonCode === 'objective_price_feature_disabled') {
    return buildHorizonUnavailableDiagnostic(withDeadline, progress, rawPolicyHorizon, unavailableCtx);
  }
  const horizonAvailable = rawPolicyHorizon.reasonCode === null;
  const replan = !frozenFallback || (isPastHourSettleMark(nowMs) && horizonAvailable);
  if (replan && rawPolicyHorizon.reasonCode !== null) {
    // Bootstrap (or empty/all-elapsed commitment) with no usable horizon (transient
    // `objective_missing_price_horizon`): nothing to serve frozen, can't allocate → unknown.
    return buildHorizonUnavailableDiagnostic(withDeadline, progress, rawPolicyHorizon, unavailableCtx);
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
    priceHorizon,
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
  priceHorizon: PriceHorizonEntry[];
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
    priceHorizon,
    dailyBudgetSnapshot,
    activePlans,
    frozenRead,
  } = params;
  const unknownWithProgress = (
    reasonCode: DeferredObjectiveDiagnosticReasonCode,
    extra?: ReturnType<typeof buildKnownEnergyFields>,
  ) => withUnknown({
    ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
    ...(extra ?? {}),
    horizonBucketCount: policyHorizon.horizonBucketCount,
    dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
  }, reasonCode);
  if (progress.reasonCode) return unknownWithProgress(progress.reasonCode);

  const profileEnergy: DeferredObjectiveEnergyResolution = progress.remainingUnits > 0
    ? resolveProgressEnergy({ powerTracker, deviceId, objective, remainingUnits: progress.remainingUnits, progress })
    : ZERO_ENERGY_RESOLUTION;
  if (profileEnergy.reasonCode) return unknownWithProgress(profileEnergy.reasonCode);

  const steps = profileEnergy.energyNeededKWh > 0 ? resolveObjectiveSteps(device) : [];
  if (profileEnergy.energyNeededKWh > 0 && steps.length === 0) {
    return unknownWithProgress('objective_missing_charge_rate', buildKnownEnergyFields({ objective, profileEnergy }));
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
    priceHorizon,
    dailyBudgetSnapshot,
    steps,
    commitment,
    aheadOfHourMilestone,
    profileEnergy,
    hardCapKw: params.hardCapKw,
    concurrentEligibleCount: params.concurrentEligibleCount,
  });
};
