import type { PowerLimitSettings } from '../../../packages/contracts/src/capacitySettings';
import { buildUnallocatedTaskEvaluation } from './taskEvaluationProducer';
import { hasEstablishedActivePlan } from './completionDiagnostic';
import { resolveTaskCompletion } from './taskCompletion';
import type { TaskEvaluation } from './taskEvaluation';
import type { TaskReservationReader } from './taskDeliveryState';
import type { ModePriorityOrder } from '../../../packages/shared-domain/src/settings/modePriorities';
import type { PowerTrackerState } from '../../power/tracker';
import type {
  DeferredObjectiveEnergyResolution,
} from './profileEnergyResolution';
import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type {
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import type { DeliveredEnergyReader } from './energyDelivery';
import { resolveObjectiveSteps } from './objectiveSteps';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';
import { isAheadOfHourMilestone } from './trajectoryMilestone';
import { isPastHourSettleMark } from './settleWindow';
import { resolveHigherPriorityContentionEvaluation } from './contentionOverlay';
import { reportHigherPriorityContention } from './contentionReporting';
import {
  resolveObjectiveProgress,
  isObjectiveProgressSatisfied,
  type DeferredObjectiveProgressResolution,
} from './diagnosticProgress';
import {
  type DeferredObjectivePolicyHorizonInputs,
  type DeferredObjectivePolicyHorizonResult,
  type DeferredObjectivePriorityReservation,
} from './policyHorizon';
import { resolveHorizonPlanWithRescue } from './rescueReplan';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import {
  buildAllocationContextSignature,
  buildPriorityReservations,
  buildTaskAllocationContextSignature,
  orderDeferredObjectives,
  type CoordinatedDeferredObjective,
  type OrderedDeferredObjective,
  type PriorityAllocationTracker,
} from './priorityAllocation';
import {
  buildObjectiveDeviceExclusionPredicate,
  OBJECTIVE_EXCLUSION_REASON_CODES,
  type ResolveObjectiveDeviceExclusion,
} from './deviceExclusion';
import {
  type BuildPriceHorizon,
  type DeferredObjectiveStallClassificationReader,
  type DeferredObjectiveDiagnostic,
  type DeferredObjectiveDiagnosticReasonCode,
} from './diagnosticTypes';
import {
  buildDiagnosticBase,
  buildKnownEnergyFields,
  mergeProgressFields,
  resolveProgressEnergy,
  UNRESOLVED_PROGRESS,
  withUnavailableTrajectory,
  ZERO_ENERGY_RESOLUTION,
} from './diagnosticFields';
import {
  buildDeadlineAwarePolicyHorizon,
  buildFrozenDiagnostic,
  EMPTY_POLICY_HORIZON,
  resolveDeadlineBoundFrozenReadInputs,
} from './frozenDiagnostic';
import type { FrozenReadInputs } from './frozenHorizonPlan';
import {
  buildFreshDiagnostic,
  buildHorizonUnavailableDiagnostic,
} from './freshDiagnostic';

export type {
  BuildPriceHorizon,
  DeferredObjectiveDiagnostic,
} from './diagnosticTypes';
/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
export type TaskEvaluationReport = { evaluation: TaskEvaluation; diagnostic: DeferredObjectiveDiagnostic };

const shouldReplaceCommitment = (fresh: boolean, contextChanged: boolean, reservationCount: number): boolean => (
  fresh && (contextChanged || reservationCount > 0)
);

const canAcceptThermalCompletion = (
  objective: DeferredObjectiveSettingsEntry,
  activePlans: DeferredObjectiveActivePlansV1 | null,
  deviceId: string,
): boolean => objective.kind === 'temperature'
  && hasEstablishedActivePlan(activePlans, deviceId, objective.deadlineAtMs);

const completionWithEvidence = (
  evaluation: TaskEvaluation,
  evidence: ReturnType<DeferredObjectiveStallClassificationReader>,
): TaskEvaluation['completion'] => {
  if (evaluation.progress.kind === 'unobserved') return { kind: 'inactive' };
  return resolveTaskCompletion({
    currentValue: evaluation.progress.value, requestedTarget: evaluation.requestedTarget,
    direction: evaluation.progress.direction,
    thermalEvidence: evidence ? { kind: 'accepted', evidence } : { kind: 'none' },
  });
};

// What one evaluation cycle observed, shared by every task evaluated in it.
export type TaskEvaluationSnapshot = {
  nowMs: number;
  timeZone: string;
  devices: ObjectiveDeviceInput[];
  settings: DeferredObjectiveSettingsV1;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  priceOptimizationEnabled: boolean;
  activePlans: DeferredObjectiveActivePlansV1 | null;
  // The house's power-limit settings; the policy horizon and the reservation
  // ledger resolve the planning ceiling from them.
  powerLimits: PowerLimitSettings;
  // Whether the home has solar production; see `DeferredObjectivePolicyHorizonInputs`.
  hasSolarProduction: boolean;
};

// The readers an evaluation consults, supplied once by the lane that owns them.
export type TaskEvaluationReaders = {
  // Price-layer source for the allocation horizon (price + grid). The snapshot's
  // daily budget is only the optional budget overlay.
  buildPriceHorizon: BuildPriceHorizon;
  // Current mode-catalog priority producer. The batch allocator projects its
  // complete visible-plus-grace roster to unique relative ranks on every read.
  getPrioritiesForDevices: (deviceIds: readonly string[]) => ModePriorityOrder;
  // Idle-classifier reader. A task whose device is parked at its target (the
  // stall verdict below) reserves nothing against lower-priority tasks: the
  // device is not drawing its booking, so holding step power for it only
  // starves the tasks behind it. If the device's own controller starts it
  // again, it competes live and the capacity guard orders the two by priority.
  // Every path that allocates passes it — the lifecycle emitter commits the
  // lower tasks' schedules, the decoration path re-allocates them at the
  // settle, and the preview projects them — so all three read the same
  // reservation ledger. It never changes a status here: see
  // `reportStalledTasksAsSatisfied`.
  getStallClassification: DeferredObjectiveStallClassificationReader;
  // Durable device-exclusion resolver (this leafward subsystem reads neither
  // home membership nor the managed-device map itself). A non-null answer
  // short-circuits the diagnostic to `unknown` with that exclusion's dedicated
  // code (see `deviceExclusion.ts`); answering `null` everywhere changes nothing.
  resolveDeviceExclusion: ResolveObjectiveDeviceExclusion;
  getDeliveredEnergyKWh: DeliveredEnergyReader;
  isReservationSuppressed: TaskReservationReader;
};

// Which lane evaluates. The live lanes (lifecycle emitter, decoration) serve
// settled commitments between settles. A preview solves its candidate fresh while
// the tasks ahead of it keep their settled commitments; the recorder never writes it.
export type TaskEvaluationLane =
  | { kind: 'live' }
  | { kind: 'preview'; candidateDeviceId: string };

export const LIVE_LANE: TaskEvaluationLane = { kind: 'live' };

const isPreviewCandidate = (lane: TaskEvaluationLane, deviceId: string): boolean => (
  lane.kind === 'preview' && lane.candidateDeviceId === deviceId
);

// A task holds its bookings against the tasks below while it may reserve, has not
// been accepted as finished at its target, and its reservations are not
// suppressed. Short-circuits so the suppression reader runs only for such a task.
const holdsItsBookings = (
  task: OrderedDeferredObjective,
  completion: TaskEvaluation['completion'],
  readers: TaskEvaluationReaders,
): boolean => task.reservationEligible && completion.kind !== 'accepted_near_target'
  && !readers.isReservationSuppressed(task.deviceId, task.objective.deadlineAtMs);

// A task that holds its bookings counts toward a lower one's booked ranks only
// while it governs its device through its plan: allocated, unfinished and before
// its deadline. Otherwise the device is back under ordinary control and its draw
// reaches the tasks below as nothing, like a plain device's.
const governsItsDevice = (
  task: OrderedDeferredObjective,
  evaluation: TaskEvaluation,
  nowMs: number,
): boolean => task.objective.deadlineAtMs > nowMs
  && evaluation.planning.kind === 'allocated'
  && evaluation.completion.kind !== 'target_reached';

export const buildDeferredObjectiveTaskResults = (
  snapshot: TaskEvaluationSnapshot,
  readers: TaskEvaluationReaders,
  tracker: PriorityAllocationTracker,
  lane: TaskEvaluationLane,
): TaskEvaluationReport[] => {
  const { nowMs, activePlans } = snapshot;
  const deviceById = new Map(snapshot.devices.map((device) => [device.id, device]));
  const isDeviceExcluded = buildObjectiveDeviceExclusionPredicate(readers.resolveDeviceExclusion);
  tracker.observe({ devices: snapshot.devices, nowMs, isDeviceExcluded });
  const ordered = orderDeferredObjectives({
    settings: snapshot.settings,
    deviceById,
    isDeviceExcluded,
    tracker,
    activePlans,
    nowMs,
    getPrioritiesForDevices: readers.getPrioritiesForDevices,
  });
  const reservations: DeferredObjectivePriorityReservation[] = [];
  let higherTaskBootstrapped = false;
  // Tasks ahead that govern their device. Active ranks are unique and dense over
  // the whole roster, so the devices above a task number exactly `priority - 1`:
  // when the governing tasks ahead account for all of them, every load this task
  // cannot displace reaches it as bookings, which gates its floor promotion.
  let governingTasksAhead = 0;
  const results = ordered.map((orderedTask, index) => {
    const task = { ...orderedTask, higherRankedLoadBooked: governingTasksAhead === orderedTask.priority - 1 };
    const { deviceId, objective, device } = task;
    // Lower-priority edits cannot churn an already-committed higher task.
    const rosterSignature = buildAllocationContextSignature(ordered.slice(0, index + 1));
    const allocationContextSignature = buildTaskAllocationContextSignature({
      rosterSignature,
      higherPriorityReservations: reservations,
    });
    const latestSignature = activePlans?.plansByDeviceId[deviceId]?.latest?.allocationContextSignature;
    // Legacy single-task revisions have no coordination signature, but their
    // frozen commitment is still safe to serve until the ordinary :58 settle.
    // Legacy lower tasks must replan immediately to prevent residual overbooking.
    const allocationContextChanged = latestSignature === undefined
      ? reservations.length > 0
      : latestSignature !== allocationContextSignature;
    // Ordinary priority-context drift settles at `:58`, but two one-shot
    // bootstrap cases must coordinate the whole affected prefix immediately:
    // (1) a higher task just allocated fresh and made its first physical claim;
    // leaving lower commitments frozen would double-book that claim, and (2) a
    // legacy lower revision has no coordination signature and therefore predates
    // residual allocation entirely. These are bootstrap/migration reseeds, not a
    // second per-cycle allocator clock. The preview's candidate is also
    // explicitly fresh because it is never written by the recorder.
    const forceFreshAllocation = shouldForceFreshAllocation(
      higherTaskBootstrapped,
      latestSignature === undefined && reservations.length > 0,
      isPreviewCandidate(lane, deviceId),
    );
    const diagnostic = buildDeferredObjectiveDiagnostic(snapshot, readers, task, reservations, forceFreshAllocation);
    const contentionEvaluation = resolveHigherPriorityContentionEvaluation({
      evaluation: diagnostic.evaluation,
      higherPriorityReservations: reservations,
      buildWithoutReservations: () => buildDeferredObjectiveDiagnostic(snapshot, readers, task, [], true).evaluation,
    });
    const contentionResolved = reportHigherPriorityContention(diagnostic, contentionEvaluation);
    const freshAllocation = contentionEvaluation.planning.kind === 'allocated'
      && contentionEvaluation.planning.plan.frozenRead !== true;
    const coordinated: DeferredObjectiveDiagnostic = {
      ...contentionResolved,
      allocationContextSignature,
      ...(shouldReplaceCommitment(freshAllocation, allocationContextChanged, reservations.length)
        ? { replaceCommitment: true as const }
        : {}),
    };
    const evaluation = coordinated.evaluation;
    const thermalEvidence = canAcceptThermalCompletion(objective, activePlans, deviceId)
      ? readers.getStallClassification(deviceId) : undefined;
    const acceptedCompletion = completionWithEvidence(evaluation, thermalEvidence);
    const evaluationResult = { ...evaluation, completion: acceptedCompletion };
    const holdsBookings = holdsItsBookings(task, acceptedCompletion, readers);
    if (holdsBookings) {
      const previousReservationCount = reservations.length;
      reservations.push(...buildPriorityReservations({
        evaluation: coordinated.evaluation,
        objective,
        device,
        activePlans,
        powerLimits: snapshot.powerLimits,
        nowMs,
      }));
      if (freshAllocation && reservations.length > previousReservationCount) {
        higherTaskBootstrapped = true;
      }
    }
    if (holdsBookings && governsItsDevice(task, evaluationResult, nowMs)) governingTasksAhead += 1;
    return {
      evaluation: evaluationResult,
      diagnostic: { ...coordinated, evaluation: evaluationResult, completion: acceptedCompletion },
    };
  });
  results.push(...buildExcludedObjectiveDiagnostics(
    snapshot.settings, readers.resolveDeviceExclusion, deviceById, snapshot.timeZone, snapshot.powerTracker,
  ).map((diagnostic) => ({ evaluation: diagnostic.evaluation, diagnostic })));
  return results;
};

// Excluded objectives (sub-home device, or a device the owner no longer
// manages) remain visible as explicit unknown diagnostics but do not
// participate in the main home's allocation context or reservation ledger.
const buildExcludedObjectiveDiagnostics = (
  settings: DeferredObjectiveSettingsV1,
  resolveDeviceExclusion: ResolveObjectiveDeviceExclusion,
  deviceById: ReadonlyMap<string, ObjectiveDeviceInput>,
  timeZone: string,
  powerTracker: PowerTrackerState,
): DeferredObjectiveDiagnostic[] => (
  Object.entries(settings.objectivesByDeviceId).flatMap(([deviceId, objective]) => {
    const exclusion = objective.enabled ? resolveDeviceExclusion(deviceId) : null;
    // The device may well be present (or planner scoping may have dropped it)
    // — either way the honest story is the exclusion itself ("out of the main
    // home's meter scope", "not managed"), never "missing device".
    return exclusion === null ? [] : [withUnavailableTrajectory(buildDiagnosticBase({
      deviceId,
      device: deviceById.get(deviceId),
      objective,
      timeZone,
      powerTracker,
      ...UNRESOLVED_PROGRESS,
    }), OBJECTIVE_EXCLUSION_REASON_CODES[exclusion])];
  })
);
/* eslint-enable functional/immutable-data */

const shouldForceFreshAllocation = (
  higherTaskBootstrapped: boolean, legacyCommitmentNeedsMigration: boolean, previewForced: boolean,
): boolean => [higherTaskBootstrapped, legacyCommitmentNeedsMigration, previewForced].includes(true);

// A task whose device is in this cycle's roster.
type PresentDeferredObjective = CoordinatedDeferredObjective & { device: ObjectiveDeviceInput };

const hasDevice = (task: CoordinatedDeferredObjective): task is PresentDeferredObjective => task.device !== undefined;

const buildTaskDiagnosticBase = (
  snapshot: TaskEvaluationSnapshot,
  task: CoordinatedDeferredObjective,
): DeferredObjectiveDiagnostic => buildDiagnosticBase({
  deviceId: task.deviceId,
  device: task.device,
  objective: task.objective,
  timeZone: snapshot.timeZone,
  powerTracker: snapshot.powerTracker,
  ...UNRESOLVED_PROGRESS,
});

// One objective, given the reservations of the tasks ahead of it. Every caller
// goes through `buildDeferredObjectiveTaskResults`, which supplies that ledger.
const buildDeferredObjectiveDiagnostic = (
  snapshot: TaskEvaluationSnapshot,
  readers: TaskEvaluationReaders,
  task: CoordinatedDeferredObjective,
  higherPriorityReservations: readonly DeferredObjectivePriorityReservation[],
  forceFreshAllocation: boolean,
): DeferredObjectiveDiagnostic => {
  const { nowMs, powerTracker, activePlans } = snapshot;
  const { deviceId, objective } = task;
  // Built on the path that returns it; the policy-horizon path builds its own.
  if (!hasDevice(task)) {
    return withUnavailableTrajectory(buildTaskDiagnosticBase(snapshot, task), 'objective_missing_device');
  }

  if (!Number.isFinite(objective.deadlineAtMs) || objective.deadlineAtMs <= 0) {
    return withUnavailableTrajectory(buildTaskDiagnosticBase(snapshot, task), 'objective_invalid_deadline');
  }
  const horizonInputs: DeferredObjectivePolicyHorizonInputs = {
    nowMs,
    deadlineAtMs: objective.deadlineAtMs,
    priceOptimizationEnabled: snapshot.priceOptimizationEnabled,
    // Allocation-horizon price source, resolved by the wiring-injected producer.
    priceHorizon: readers.buildPriceHorizon(nowMs, objective.deadlineAtMs),
    dailyBudgetSnapshot: snapshot.dailyBudgetSnapshot,
    powerLimits: snapshot.powerLimits,
    hasSolarProduction: snapshot.hasSolarProduction,
    exemptFromBudget: false,
    higherPriorityReservations,
  };
  const progress = resolveObjectiveProgress(objective, task.device, readers.getDeliveredEnergyKWh);
  if (isObjectiveProgressSatisfied(progress)) {
    return withRawActuationSatisfaction(buildDiagnosticWithPolicyHorizon(
      snapshot, task, progress, EMPTY_POLICY_HORIZON, horizonInputs, null, true,
    ));
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
  const frozenFallback = resolveDeadlineBoundFrozenReadInputs({
    activePlans,
    deviceId,
    objective,
    progressDirection: progress.progressDirection,
    nowMs,
  });
  const rawPolicyHorizon = buildDeadlineAwarePolicyHorizon(horizonInputs);
  // Price optimization turned OFF is a deliberate config state, not a transient data
  // gap: the deferred objective is price-dependent, so it goes inactive (the device
  // returns to normal control) — exactly as before C. We must NOT keep serving the
  // stale price-optimized commitment frozen here. Only a transient
  // `objective_missing_price_horizon` (SDK read gap) is served frozen below.
  if (rawPolicyHorizon.reasonCode === 'objective_price_feature_disabled') {
    return buildHorizonUnavailableDiagnostic(
      buildTaskDiagnosticBase(snapshot, task), progress, rawPolicyHorizon, task, powerTracker,
    );
  }
  const horizonAvailable = rawPolicyHorizon.reasonCode === null;
  const replanRequested = [
    forceFreshAllocation, !frozenFallback, isPastHourSettleMark(nowMs),
  ].includes(true);
  const replan = replanRequested && horizonAvailable;
  if (!frozenFallback && rawPolicyHorizon.reasonCode !== null) {
    // Bootstrap (or empty/all-elapsed commitment) with no usable horizon (transient
    // `objective_missing_price_horizon`): nothing to serve frozen, can't allocate → unknown.
    return buildHorizonUnavailableDiagnostic(
      buildTaskDiagnosticBase(snapshot, task), progress, rawPolicyHorizon, task, powerTracker,
    );
  }
  const policyHorizon = rawPolicyHorizon.reasonCode === null ? rawPolicyHorizon : EMPTY_POLICY_HORIZON;

  // Serve frozen unless we are re-planning; `replan` already required the horizon
  // to be available, so the fresh path always has a usable `policyHorizon`.
  // `frozenFallback` also covers a live step-ladder gap: when the fresh path cannot
  // allocate (no executable steps), a committed task is served frozen even on a
  // replan-due cycle — the replan is deferred, not the commitment dropped. Null
  // exactly when there is no commitment to serve.
  return withRawActuationSatisfaction(buildDiagnosticWithPolicyHorizon(
    snapshot, task, progress, policyHorizon, horizonInputs, frozenFallback, replan,
  ));
};

// Raw requested-target completion alone controls task release.
const withRawActuationSatisfaction = (
  diagnostic: DeferredObjectiveDiagnostic,
): DeferredObjectiveDiagnostic => ({
  ...diagnostic,
  actuationSatisfied: diagnostic.evaluation.completion.kind === 'target_reached',
});

// Which frozen read (if any) this cycle serves. Normal path: the caller's replan
// decision serves the commitment unless it re-plans. Step-gap degradation: a
// committed task whose live step ladder is missing serves its commitment even on a
// replan-due cycle, because re-planning without steps is impossible. Null ⇒ fresh
// path (or, when steps are missing with no commitment to serve, the caller
// resolves `unknown`).
const resolveServedFrozenRead = (
  liveStepsUnavailable: boolean,
  frozenFallback: FrozenReadInputs | null,
  replan: boolean,
): FrozenReadInputs | null => (!replan || liveStepsUnavailable ? frozenFallback : null);

const buildDiagnosticWithPolicyHorizon = (
  snapshot: TaskEvaluationSnapshot,
  task: PresentDeferredObjective,
  progress: DeferredObjectiveProgressResolution,
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>,
  horizonInputs: DeferredObjectivePolicyHorizonInputs,
  frozenFallback: FrozenReadInputs | null,
  replan: boolean,
): DeferredObjectiveDiagnostic => {
  const { nowMs, powerTracker } = snapshot;
  const { deviceId, objective, device } = task;
  const base = buildTaskDiagnosticBase(snapshot, task);
  const unknownWithProgress = (
    reasonCode: DeferredObjectiveDiagnosticReasonCode,
    extra?: ReturnType<typeof buildKnownEnergyFields>,
  ) => {
    const evaluation = buildUnallocatedTaskEvaluation(deviceId, objective, progress);
    return withUnavailableTrajectory({
      ...mergeProgressFields(base, progress.currentValue),
      evaluation,
      completion: evaluation.completion,
      ...(extra ?? {}),
      horizonBucketCount: policyHorizon.horizonBucketCount,
    }, reasonCode);
  };
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
  const effectiveFrozenRead = resolveServedFrozenRead(liveStepsUnavailable, frozenFallback, replan);
  if (liveStepsUnavailable && !effectiveFrozenRead) {
    return unknownWithProgress('objective_missing_charge_rate', buildKnownEnergyFields({ objective, profileEnergy }));
  }

  const activeCommittedPlan = resolveActiveCommittedPlan({
    activePlans: snapshot.activePlans,
    deviceId,
    objective,
    progressDirection: progress.progressDirection,
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
    measuredValue: progress.currentValue,
    progressDirection: progress.progressDirection,
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
      profileEnergy,
      aheadOfHourMilestone,
      steps,
      frozenRead: effectiveFrozenRead,
      liveStepsUnavailable,
    });
  }
  const horizonPlan = resolveHorizonPlanWithRescue(
    task, profileEnergy, steps, commitment, aheadOfHourMilestone, policyHorizon, horizonInputs,
  );
  return buildFreshDiagnostic(
    task, base, progress, profileEnergy, policyHorizon, horizonPlan, horizonInputs.priceHorizon,
  );
};
