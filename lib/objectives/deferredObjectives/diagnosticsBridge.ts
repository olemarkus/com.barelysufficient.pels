import type { PowerTrackerState } from '../../power/tracker';
import type {
  DeferredObjectiveEnergyResolution,
} from './profileEnergyResolution';
import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type {
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { resolveObjectiveSteps } from './objectiveSteps';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';
import { isAheadOfHourMilestone } from './trajectoryMilestone';
import { isPastHourSettleMark } from './settleWindow';
import { resolveHigherPriorityContentionStatus } from './contentionOverlay';
import {
  resolveObjectiveProgress,
  type DeferredObjectiveProgressResolution,
} from './diagnosticProgress';
import {
  type DeferredObjectivePolicyHorizonResult,
  type DeferredObjectivePriorityReservation,
  type PriceHorizonEntry,
} from './policyHorizon';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from './settings';
import {
  buildAllocationContextSignature,
  buildPriorityReservations,
  buildTaskAllocationContextSignature,
  orderDeferredObjectives,
  type PriorityAllocationTracker,
} from './priorityAllocation';
import {
  stallEvidenceCoversTarget,
  type StallEvidence,
} from '../../../packages/shared-domain/src/idleClassificationCopy';
import {
  buildObjectiveDeviceExclusionPredicate,
  OBJECTIVE_EXCLUSION_REASON_CODES,
  type ObjectiveDeviceExclusion,
  type ResolveObjectiveDeviceExclusion,
} from './deviceExclusion';
import {
  resolvedTrajectoryStatus,
  type BuildPriceHorizon,
  type DeferredObjectiveDiagnostic,
  type DeferredObjectiveDiagnosticReasonCode,
} from './diagnosticTypes';
import {
  buildDiagnosticBase,
  buildKnownEnergyFields,
  mergeProgressFields,
  progressCurrentValue,
  resolveProgressEnergy,
  withUnavailableTrajectory,
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
} from './diagnosticTypes';
export { progressCurrentValue } from './diagnosticFields';
// Emission lives in its own module (the announce rule pushed this file past the
// 500-line cap); re-exported so callers keep a single bridge import surface.
export {
  emitDeferredObjectiveDiagnostics,
  type DeferredObjectiveAnnounce,
} from './diagnosticAnnounce';

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
  priorityAllocationTracker?: PriorityAllocationTracker;
  // Current mode-catalog priority producer. The batch allocator projects its
  // complete visible-plus-grace roster to unique relative ranks on every read.
  getBasePriorityForDevice?: (deviceId: string) => unknown;
  // Preview-only override: solve the candidate fresh while allowing tasks
  // ahead of it to keep their settled commitments.
  forceFreshDeviceId?: string;
  // Idle-classifier reader. When provided, the live (user-facing) status is
  // resolved to `satisfied` for devices parked in a stall classification so the
  // status chip, notifications and Flows agree with the postmortem recorder
  // (which already promotes such runs to `satisfied(stalled)`). The decoration /
  // actuation path deliberately OMITS this so admission keeps reading the raw
  // trajectory status — only `horizonPlan.status` (untouched) drives commitment.
  getStallClassification?: (deviceId: string) => StallEvidence | undefined;
  // Durable device-exclusion resolver, injected by the wiring layer (this
  // leafward subsystem reads neither home membership nor the managed-device map
  // itself). A non-null answer short-circuits the diagnostic to `unknown` with
  // that exclusion's dedicated code (see `deviceExclusion.ts`). Optional:
  // absent (tests, preview callers), or answering `null` everywhere, nothing
  // changes.
  resolveDeviceExclusion?: ResolveObjectiveDeviceExclusion;
}): DeferredObjectiveDiagnostic[] => {
  const deviceById = new Map(params.devices.map((device) => [device.id, device]));
  const isDeviceExcluded = buildObjectiveDeviceExclusionPredicate(params.resolveDeviceExclusion);
  params.priorityAllocationTracker?.observe({
    devices: params.devices,
    nowMs: params.nowMs,
    isDeviceExcluded,
  });
  const ordered = orderDeferredObjectives({
    settings: params.settings,
    deviceById,
    isDeviceExcluded,
    tracker: params.priorityAllocationTracker,
    activePlans: params.activePlans,
    nowMs: params.nowMs,
    getBasePriorityForDevice: params.getBasePriorityForDevice,
  });
  const reservations: DeferredObjectivePriorityReservation[] = [];
  let higherTaskBootstrapped = false;
  const diagnostics = ordered.map(({
    deviceId,
    objective,
    device,
    priority,
    reservationEligible,
  }, index) => {
    // Only this task and the tasks ahead of it can affect its allocation. A
    // lower-priority task being added, removed, or edited must not churn an
    // already-committed higher-priority schedule.
    const rosterSignature = buildAllocationContextSignature(ordered.slice(0, index + 1));
    const allocationContextSignature = buildTaskAllocationContextSignature({
      rosterSignature,
      higherPriorityReservations: reservations,
    });
    const latestSignature = params.activePlans?.plansByDeviceId[deviceId]
      ?.latest?.allocationContextSignature;
    // Legacy single-task revisions have no coordination signature, but their
    // frozen commitment is still safe to serve until the ordinary :58 settle.
    // A legacy task behind an actual higher claim must replan immediately so an
    // old equal-share commitment cannot overbook the residual slot.
    const allocationContextChanged = latestSignature === undefined
      ? reservations.length > 0
      : latestSignature !== allocationContextSignature;
    // Ordinary priority-context drift settles at `:58`, but two one-shot
    // bootstrap cases must coordinate the whole affected prefix immediately:
    // (1) a higher task just allocated fresh and made its first physical claim;
    // leaving lower commitments frozen would double-book that claim, and (2) a
    // legacy lower revision has no coordination signature and therefore predates
    // residual allocation entirely. These are bootstrap/migration reseeds, not a
    // second per-cycle allocator clock. The preview-only candidate override is
    // also explicitly fresh because it is never written by the recorder.
    const forceFreshAllocation = shouldForceFreshAllocation(
      higherTaskBootstrapped,
      latestSignature === undefined && reservations.length > 0,
      params.forceFreshDeviceId === deviceId,
    );
    const diagnostic = buildDeferredObjectiveDiagnostic({
      ...params,
      deviceId,
      objective,
      device,
      higherPriorityReservations: reservations,
      forceFreshAllocation,
    });
    const contentionResolved = resolveHigherPriorityContentionStatus({
      diagnostic,
      higherPriorityReservations: reservations,
      buildWithoutReservations: () => buildDeferredObjectiveDiagnostic({
        ...params,
        deviceId,
        objective,
        device,
        higherPriorityReservations: [],
        forceFreshAllocation: true,
      }),
    });
    const freshAllocation = contentionResolved.horizonPlan !== undefined
      && contentionResolved.horizonPlan.frozenRead !== true;
    const coordinated: DeferredObjectiveDiagnostic = {
      ...contentionResolved,
      devicePriority: priority,
      allocationContextSignature,
      ...(freshAllocation && (allocationContextChanged || reservations.length > 0)
        ? { replaceCommitment: true as const }
        : {}),
    };
    if (reservationEligible) {
      const previousReservationCount = reservations.length;
      reservations.push(...buildPriorityReservations({
        diagnostic: coordinated,
        objective,
        device,
        activePlans: params.activePlans,
        hardCapKw: params.hardCapKw,
      }));
      if (freshAllocation && reservations.length > previousReservationCount) {
        higherTaskBootstrapped = true;
      }
    }
    return resolveExternalOffReportedStatus(resolveStallReportedStatus(
      coordinated,
      params.getStallClassification?.(deviceId),
      hasEstablishedActivePlan(params.activePlans, deviceId, coordinated.deadlineAtMs),
    ), device);
  });
  // Excluded objectives (sub-home device, or a device the owner no longer
  // manages) remain visible as explicit unknown diagnostics but do not
  // participate in the main home's allocation context or reservation ledger.
  diagnostics.push(...Object.entries(params.settings.objectivesByDeviceId).flatMap(([deviceId, objective]) => {
    const exclusion = objective.enabled ? params.resolveDeviceExclusion?.(deviceId) ?? null : null;
    return exclusion === null ? [] : [buildDeferredObjectiveDiagnostic({
      ...params,
      deviceId,
      objective,
      device: deviceById.get(deviceId),
      exclusion,
    })];
  }));
  return diagnostics;
};

const shouldForceFreshAllocation = (
  higherTaskBootstrapped: boolean, legacyCommitmentNeedsMigration: boolean, previewForced: boolean,
): boolean => [higherTaskBootstrapped, legacyCommitmentNeedsMigration, previewForced].includes(true);

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
const STALL_RESOLVABLE_STATUSES = new Set<ReturnType<typeof resolvedTrajectoryStatus>>(
  ['on_track', 'at_risk', 'cannot_meet'],
);

const resolveStallReportedStatus = (
  diagnostic: DeferredObjectiveDiagnostic,
  evidence: StallEvidence | undefined,
  hasEstablishedPlan: boolean,
): DeferredObjectiveDiagnostic => {
  // First-seen tasks read a stale, device-keyed classifier verdict — wait until
  // the run is established (a committed revision exists) so the classification
  // belongs to THIS objective. See `hasEstablishedActivePlan`.
  if (!hasEstablishedPlan) return diagnostic;
  // Gate on the setpoint the verdict was measured against, not the verdict
  // alone: PELS parks a managed device by writing a lower setback setpoint, and
  // a device idling there is `near_target_idle` without having delivered this
  // task's target. Mirrors `maybePromoteOnStall` so the live status and the
  // recorded outcome cannot disagree.
  if (!stallEvidenceCoversTarget(evidence, diagnostic.targetValue)) return diagnostic;
  if (!STALL_RESOLVABLE_STATUSES.has(resolvedTrajectoryStatus(diagnostic))) return diagnostic;
  return {
    ...diagnostic,
    trajectory: { kind: 'resolved', status: 'satisfied' },
    reasonCode: evidence.classification === 'capped_idle'
      ? 'objective_stalled_device_capped'
      : 'objective_stalled_near_target',
  };
};

/**
 * Mark the diagnostic when the user has turned the device off outside PELS and
 * asked PELS to leave it off. An explicit off action is meant to win over a smart
 * task, but the task must not keep claiming `on_track` just because future hours
 * are still scheduled — those hours cannot run while the device stays off.
 *
 * A LIVE OVERLAY, NOT A VERDICT. This deliberately does NOT rewrite `status`,
 * because `status` is what the recorder freezes into a committed revision at the
 * `:58` settle. A frozen `at_risk` would outlive the hold: turning the device
 * back on clears the live signal, but the settled status keeps every surface
 * reporting risk until the next settle, up to an hour later. Instead the cause
 * travels as its own `externalOffHoldActive` flag → `diagnosticReasonCode`, which
 * the recorder refreshes
 * every cycle, so both directions are immediate. This is exactly the mechanism
 * `objective_invalid_session` (EV unplugged) already uses; consumers resolve the
 * reported status from it via `resolveEffectivePlanStatus`.
 *
 * Only a healthy trajectory is overlaid: `cannot_meet` is already the honest
 * answer once the latest feasible start has passed and must not be softened, and
 * `satisfied` / `invalid` / `unknown` are not trajectory claims at all.
 *
 * An EV that is also unplugged keeps its own reason: `Paused — unplugged` is the
 * more immediate thing for the user to act on, and the hold is still stored, so
 * it reappears once the car is reconnected.
 */
/**
 * The flag records a fact about the DEVICE, so it is carried whatever the live
 * trajectory says — including `unknown`.
 *
 * Gating it on the live status was wrong: when device data goes stale (missing
 * temperature/SoC, capacity, or charge step) the diagnostic degrades to
 * `unknown`, and dropping the flag there cleared `diagnosticReasonCode` on the
 * committed plan. Every surface then reverted to the cached `on_track` while the
 * device was still held off, and no status-change event fired — potentially for
 * the whole outage. Nothing about a data gap means the user turned the device
 * back on.
 *
 * Deciding what to REPORT stays in one place downstream
 * (`resolveEffectivePlanStatus`), which overlays only a healthy verdict, so
 * `satisfied` and `cannot_meet` are still never softened by carrying the flag here.
 */
const resolveExternalOffReportedStatus = (
  diagnostic: DeferredObjectiveDiagnostic,
  device: ObjectiveDeviceInput | undefined,
): DeferredObjectiveDiagnostic => {
  if (device?.externalOffHoldActive !== true) return diagnostic;
  // A charger with no creditable session keeps its own, more immediate reason;
  // the hold is still stored and reappears once the car is reconnected. Asked of
  // the producer-resolved boolean, not the plug-state — which this layer no
  // longer receives (`toPlanDevice` strips it), so the EV-shaped test this
  // replaced could never be true.
  //
  // Scoped to the session question on purpose. Widening it to `commandableNow`
  // would drop the hold for ANY device that is momentarily unavailable or inside
  // PELS's own command back-off — a data gap, and the docblock above is about
  // exactly why a data gap must not clear this flag.
  if (device.objectiveSessionInactive) return diagnostic;
  return { ...diagnostic, externalOffHoldActive: true };
};

// Exported for focused single-objective callers. The plan-preview composition
// uses the batch bridge when a live roster is available so higher-priority
// tasks reserve first; legacy isolated preview callers still use this leaf.
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
  higherPriorityReservations?: readonly DeferredObjectivePriorityReservation[];
  forceFreshAllocation?: boolean;
  // Producer-resolved exclusion (see `buildDeferredObjectiveDiagnostics`): a
  // non-null value short-circuits to that exclusion's dedicated unknown
  // diagnostic BEFORE the missing-device check. Both arms describe a device
  // that is absent from `devices` while still existing — a sub-home device
  // under main-only planner scoping, or one the owner stopped managing — so
  // falling through would mislabel it as missing. Preview callers omit it
  // (candidates are main-home-gated and managed-gated at the write lanes).
  exclusion?: ObjectiveDeviceExclusion;
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
  // Exclusion check FIRST: the device may well be present (or planner scoping
  // may have dropped it) — either way the honest story is the exclusion itself
  // ("out of the main home's meter scope", "not managed"), never "missing
  // device".
  if (params.exclusion) {
    return withUnavailableTrajectory(base, OBJECTIVE_EXCLUSION_REASON_CODES[params.exclusion]);
  }
  if (!device) return withUnavailableTrajectory(base, 'objective_missing_device');

  if (!Number.isFinite(objective.deadlineAtMs) || objective.deadlineAtMs <= 0) {
    return withUnavailableTrajectory(base, 'objective_invalid_deadline');
  }
  const withDeadline = base;
  // Allocation-horizon price source, resolved by the wiring-injected producer.
  const priceHorizon = buildPriceHorizon(nowMs, objective.deadlineAtMs);
  const progress = resolveObjectiveProgress({ objective, device });
  if (!progress.reasonCode && progress.remainingUnits <= 0) {
    return withRawActuationSatisfaction(buildDiagnosticWithPolicyHorizon({
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
      higherPriorityReservations: params.higherPriorityReservations,
    }));
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
    higherPriorityReservations: params.higherPriorityReservations,
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
  const replanRequested = params.forceFreshAllocation === true
    || !frozenFallback
    || isPastHourSettleMark(nowMs);
  const replan = replanRequested && horizonAvailable;
  if (!frozenFallback && rawPolicyHorizon.reasonCode !== null) {
    // Bootstrap (or empty/all-elapsed commitment) with no usable horizon (transient
    // `objective_missing_price_horizon`): nothing to serve frozen, can't allocate → unknown.
    return buildHorizonUnavailableDiagnostic(withDeadline, progress, rawPolicyHorizon, unavailableCtx);
  }
  const policyHorizon = rawPolicyHorizon.reasonCode === null ? rawPolicyHorizon : EMPTY_POLICY_HORIZON;

  return withRawActuationSatisfaction(buildDiagnosticWithPolicyHorizon({
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
    higherPriorityReservations: params.higherPriorityReservations,
    // Serve frozen unless we are re-planning; `replan` already required the horizon
    // to be available, so the fresh path always has a usable `policyHorizon`.
    frozenRead: replan ? null : frozenFallback,
    // Degradation fallback for a live step-ladder gap: when the fresh path cannot
    // allocate (no executable steps), a committed task is served frozen even on a
    // replan-due cycle — the replan is deferred, not the commitment dropped. Null
    // exactly when there is no commitment to serve.
    frozenFallback,
  }));
};

const withRawActuationSatisfaction = (
  diagnostic: DeferredObjectiveDiagnostic,
): DeferredObjectiveDiagnostic => ({
  ...diagnostic,
  actuationSatisfied: resolvedTrajectoryStatus(diagnostic) === 'satisfied',
});

// Which frozen read (if any) this cycle serves. Normal path: the caller's replan
// decision (`frozenRead`). Step-gap degradation: a committed task whose live step
// ladder is missing serves its commitment even on a replan-due cycle, because
// re-planning without steps is impossible. Null ⇒ fresh path (or, when steps are
// missing with no commitment to serve, the caller resolves `unknown`).
const resolveServedFrozenRead = (params: {
  liveStepsUnavailable: boolean;
  frozenRead?: FrozenReadInputs | null;
  frozenFallback?: FrozenReadInputs | null;
}): FrozenReadInputs | null => {
  if (params.frozenRead) return params.frozenRead;
  if (params.liveStepsUnavailable) return params.frozenFallback ?? null;
  return null;
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
  higherPriorityReservations?: readonly DeferredObjectivePriorityReservation[];
  frozenRead?: FrozenReadInputs | null;
  frozenFallback?: FrozenReadInputs | null;
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
    frozenFallback,
  } = params;
  const unknownWithProgress = (
    reasonCode: DeferredObjectiveDiagnosticReasonCode,
    extra?: ReturnType<typeof buildKnownEnergyFields>,
  ) => withUnavailableTrajectory({
    ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
    ...(extra ?? {}),
    horizonBucketCount: policyHorizon.horizonBucketCount,
  }, reasonCode);
  if (progress.reasonCode) return unknownWithProgress(progress.reasonCode);

  const profileEnergy: DeferredObjectiveEnergyResolution = progress.remainingUnits > 0
    ? resolveProgressEnergy({ powerTracker, deviceId, objective, remainingUnits: progress.remainingUnits, progress })
    : ZERO_ENERGY_RESOLUTION;
  if (profileEnergy.reasonCode) return unknownWithProgress(profileEnergy.reasonCode);

  const steps = profileEnergy.energyNeededKWh > 0 ? resolveObjectiveSteps(device) : [];
  // Live step-ladder gap. The ladder is a live transport input — a flow-registered
  // stepped profile does not survive an app restart until the Flow re-fires, and
  // SDK reads transiently fail — so a COMMITTED task must not be dropped to
  // `unknown` for want of it: the commitment already encodes what to deliver each
  // hour (prod 2026-08-01: a restart's step gap stripped the water heater's budget
  // exemption for 9.5 h while its committed plan sat untouched in settings). Serve
  // the frozen committed plan through the gap — even on a settle cycle, because
  // re-planning without steps is impossible (same "replan only when due AND
  // possible" rule as the missing-price-horizon case above). `expectedStepId`
  // degrades to null; the executor drives the device via its remaining controls.
  // Only a task with no commitment to serve (bootstrap/new objective) still
  // resolves `unknown`.
  const liveStepsUnavailable = profileEnergy.energyNeededKWh > 0 && steps.length === 0;
  const effectiveFrozenRead = resolveServedFrozenRead({ liveStepsUnavailable, frozenRead, frozenFallback });
  if (liveStepsUnavailable && !effectiveFrozenRead) {
    return unknownWithProgress('objective_missing_charge_rate', buildKnownEnergyFields({ objective, profileEnergy }));
  }

  const activeCommittedPlan = resolveActiveCommittedPlan({
    activePlans,
    deviceId,
    objective,
  });
  const commitment = activeCommittedPlan?.commitmentHours;
  const milestoneHours = effectiveFrozenRead ? effectiveFrozenRead.hours : (activeCommittedPlan?.latest.hours ?? []);
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
  // (every stale/missing/invalid read short-circuits to `withUnavailableTrajectory` above) and
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
  // re-plan (plus the step-gap degradation above), so this is a pure gate — no
  // cold-start determination here (the device delivers up to the committed hour's
  // milestone; whether the current hour was booked at all is the allocator's `:58`
  // decision, read off the commitment).
  if (effectiveFrozenRead) {
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
      frozenRead: effectiveFrozenRead,
      liveStepsUnavailable,
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
    higherPriorityReservations: params.higherPriorityReservations,
  });
};
