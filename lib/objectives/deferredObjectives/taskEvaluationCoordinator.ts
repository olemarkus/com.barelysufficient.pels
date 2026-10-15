import type { PowerLimitSettings } from '../../../packages/contracts/src/capacitySettings';
import { buildUnallocatedTaskEvaluation } from './taskEvaluationProducer';
import { completionFromEvaluation } from './completionDiagnostic';
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
import {
  resolveObjectiveDeviceInputs,
  type ObjectiveDeviceInput,
  type ObjectiveDeviceSource,
} from '../../objectives/types';
import type { ThermalDirection } from '../../../packages/contracts/src/types';
import type { DeliveredEnergyReader } from './energyDelivery';
import { resolveHighestObjectiveAdmissionPowerKw, resolveObjectiveSteps } from './objectiveSteps';
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
  withUnavailableTrajectory,
  ZERO_ENERGY_RESOLUTION,
} from './diagnosticFields';
import {
  buildDeadlineAwarePolicyHorizon,
  buildFrozenDiagnostic,
  EMPTY_POLICY_HORIZON,
  resolveDeadlineBoundFrozenReadInputs,
} from './frozenDiagnostic';
import { buildFrozenHorizonPlan, type FrozenReadInputs } from './frozenHorizonPlan';
import {
  buildFreshDiagnostic,
  buildHorizonUnavailableDiagnostic,
} from './freshDiagnostic';

export type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
export type TaskEvaluationReport = { evaluation: TaskEvaluation; diagnostic: DeferredObjectiveDiagnostic };

const shouldReplaceCommitment = (fresh: boolean, contextChanged: boolean, higherPriorityLoad: boolean): boolean => (
  fresh && (contextChanged || higherPriorityLoad)
);

// Any higher-priority load, booked or held at a device's maximum step, can move
// under a frozen commitment, so a fresh allocation then replaces it.
const holdsHigherPriorityLoad = (
  task: CoordinatedDeferredObjective,
  reservations: readonly DeferredObjectivePriorityReservation[],
): boolean => reservations.length > 0 || task.higherPriorityUnbookedPowerKw > 0;

// What one evaluation cycle observed, shared by every task evaluated in it.
export type TaskEvaluationSnapshot = {
  nowMs: number;
  timeZone: string;
  devices: ObjectiveDeviceInput[];
  settings: DeferredObjectiveSettingsV1;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  priceOptimizationEnabled: boolean;
  activePlans: DeferredObjectiveActivePlansV1;
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
  // Idle-classifier reader. A task whose device is parked at its target holds
  // no timed task booking; the device returns to ordinary control, where its
  // maximum known step is reserved for lower-priority tasks. Every allocation
  // path passes the reader so lifecycle, decoration and preview agree on that
  // transition. Reporting projects the resolved completion separately.
  getStallClassification: DeferredObjectiveStallClassificationReader;
  // History has observed this exact obligation, whether or not prices permitted allocation.
  hasObservedTask: (deviceId: string, objective: DeferredObjectiveSettingsEntry) => boolean;
  // Durable device-exclusion resolver (this leafward subsystem reads neither
  // home membership nor the managed-device map itself). A non-null answer
  // short-circuits the diagnostic to `unknown` with that exclusion's dedicated
  // code (see `deviceExclusion.ts`); answering `null` everywhere changes nothing.
  resolveDeviceExclusion: ResolveObjectiveDeviceExclusion;
  getDeliveredEnergyKWh: DeliveredEnergyReader;
  isReservationSuppressed: TaskReservationReader;
};

// Everything one home's task evaluations read, bound once by the wiring layer:
// the readers each evaluation consults, and the live household facts a cycle's
// snapshot captures. The decoration lane, the lifecycle clock and the
// create-task preview all evaluate through it, so they differ only in the
// per-cycle inputs they hand `buildTaskEvaluationSnapshot`.
export type TaskEvaluationSource = TaskEvaluationReaders & {
  getTimeZone: () => string;
  getThermalDirection: (deviceId: string) => ThermalDirection;
  getPowerTracker: () => PowerTrackerState;
  getPriceOptimizationEnabled: () => boolean;
  getDeferredObjectiveActivePlans: () => DeferredObjectiveActivePlansV1;
  // The persisted power-limit settings. The planning ceiling is derived in the
  // domain from them: `lib/power` owns the ceiling, and `setup/` answers no
  // power question.
  getCapacitySettings: () => PowerLimitSettings;
  // Whether the home has solar production (a role-detected PV device): export can
  // lift live grid headroom past the grid import target, so the plan is not cut
  // at that target in a PV home.
  hasSolarProduction: () => boolean;
};

// One cycle's snapshot: the lane supplies the clock, its device roster, the
// objective roster it read and the daily-budget overlay; the source supplies the
// rest of the household as it stands now.
export const buildTaskEvaluationSnapshot = (
  source: TaskEvaluationSource,
  nowMs: number,
  devices: readonly ObjectiveDeviceSource[],
  settings: DeferredObjectiveSettingsV1,
  dailyBudgetSnapshot: DailyBudgetUiPayload | null,
): TaskEvaluationSnapshot => ({
  nowMs,
  timeZone: source.getTimeZone(),
  devices: resolveObjectiveDeviceInputs(devices, source.getThermalDirection),
  settings,
  powerTracker: source.getPowerTracker(),
  dailyBudgetSnapshot,
  priceOptimizationEnabled: source.getPriceOptimizationEnabled(),
  activePlans: source.getDeferredObjectiveActivePlans(),
  powerLimits: source.getCapacitySettings(),
  hasSolarProduction: source.hasSolarProduction(),
});

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
// suppressed.
const holdsItsBookings = (
  task: OrderedDeferredObjective,
  completion: TaskEvaluation['completion'],
  reservationSuppressed: boolean,
): boolean => task.reservationEligible && completion.kind !== 'accepted_near_target'
  && !reservationSuppressed;

// The higher-ranked load a task's forecast must hold. A higher device whose load
// is already known needs no reserve: a governing task's device reaches the task
// as its bookings, a device that delivery evidence confirms is not taking power
// reaches it as nothing until it draws again, and a device PELS has no standing
// command authority over (Power limit off, a battery or panel) draws as
// background, which the forecast already holds. Every other higher device
// reaches it as its maximum known step. A higher device with no known step cannot
// be bounded, so the load is not accounted for and the task keeps its
// minimum-step floor.
const resolveHigherRankedLoad = (
  higherRankedDeviceIds: readonly string[],
  knownLoadHigherDeviceIds: ReadonlySet<string>,
  deviceById: ReadonlyMap<string, ObjectiveDeviceInput>,
): Pick<CoordinatedDeferredObjective, 'higherPriorityUnbookedPowerKw' | 'higherRankedLoadAccountedFor'> => {
  let higherPriorityUnbookedPowerKw = 0;
  let higherRankedLoadAccountedFor = true;
  for (const higherId of higherRankedDeviceIds) {
    if (knownLoadHigherDeviceIds.has(higherId)) continue;
    const higherDevice = deviceById.get(higherId);
    if (higherDevice?.control.commandAuthority === false) continue;
    const maxStepPowerKw = higherDevice ? resolveHighestObjectiveAdmissionPowerKw(higherDevice) : null;
    if (maxStepPowerKw === null) {
      higherRankedLoadAccountedFor = false;
    } else {
      higherPriorityUnbookedPowerKw += maxStepPowerKw;
    }
  }
  return { higherPriorityUnbookedPowerKw, higherRankedLoadAccountedFor };
};

// A task that no longer governs its device reaches the tasks below as the
// device's maximum step, not also as the bookings it settled. Only a device with
// no known maximum (one missing through grace) keeps its settled bookings.
const reservesItsBookings = (
  holdsBookings: boolean,
  governs: boolean,
  device: ObjectiveDeviceInput | undefined,
): boolean => governs || (holdsBookings && (device === undefined
  || resolveHighestObjectiveAdmissionPowerKw(device) === null));

// A task governs its device while allocated, unfinished and before its deadline.
// Otherwise lower tasks reserve the device's maximum known step as ordinary load.
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
  tracker.observe(snapshot.devices, nowMs, isDeviceExcluded);
  const ordered = orderDeferredObjectives(
    snapshot.settings,
    deviceById,
    isDeviceExcluded,
    tracker,
    activePlans,
    nowMs,
    readers.getPrioritiesForDevices,
  );
  const reservations: DeferredObjectivePriorityReservation[] = [];
  let higherTaskBootstrapped = false;
  const knownLoadHigherDeviceIds = new Set<string>();
  const results = ordered.map((orderedTask, index) => {
    const task: CoordinatedDeferredObjective = {
      ...orderedTask,
      ...resolveHigherRankedLoad(orderedTask.higherRankedDeviceIds, knownLoadHigherDeviceIds, deviceById),
    };
    const { deviceId, objective, device } = task;
    // Lower-priority edits cannot churn an already-committed higher task.
    const rosterSignature = buildAllocationContextSignature(ordered.slice(0, index + 1));
    const allocationContextSignature = buildTaskAllocationContextSignature({
      rosterSignature,
      higherPriorityReservations: reservations,
    });
    const latestSignature = activePlans.plansByDeviceId[deviceId]?.latest?.allocationContextSignature;
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
    const contentionEvaluation = resolveHigherPriorityContentionEvaluation(
      diagnostic.evaluation,
      reservations,
      task.higherPriorityUnbookedPowerKw,
      () => buildDeferredObjectiveDiagnostic(
        snapshot, readers, { ...task, higherPriorityUnbookedPowerKw: 0 }, [], true,
      ).evaluation,
    );
    const contentionResolved = reportHigherPriorityContention(diagnostic, contentionEvaluation);
    const freshAllocation = contentionEvaluation.planning.kind === 'allocated'
      && contentionEvaluation.planning.plan.frozenRead !== true;
    const coordinated: DeferredObjectiveDiagnostic = {
      ...contentionResolved,
      allocationContextSignature,
      ...(shouldReplaceCommitment(
        freshAllocation, allocationContextChanged, holdsHigherPriorityLoad(task, reservations),
      )
        ? { replaceCommitment: true as const }
        : {}),
    };
    const evaluation = coordinated.evaluation;
    const acceptedCompletion = completionFromEvaluation(
      evaluation, readers.getStallClassification, readers.hasObservedTask(deviceId, objective),
    );
    const evaluationResult = { ...evaluation, completion: acceptedCompletion };
    const reservationSuppressed = readers.isReservationSuppressed(deviceId, objective.deadlineAtMs);
    const holdsBookings = holdsItsBookings(task, acceptedCompletion, reservationSuppressed);
    const governs = holdsBookings && governsItsDevice(task, evaluationResult, nowMs);
    if (reservesItsBookings(holdsBookings, governs, device)) {
      const previousReservationCount = reservations.length;
      reservations.push(...buildPriorityReservations(
        coordinated.evaluation,
        objective,
        device,
        activePlans,
        snapshot.powerLimits,
        nowMs,
      ));
      if (freshAllocation && reservations.length > previousReservationCount) {
        higherTaskBootstrapped = true;
      }
    }
    if (reservationSuppressed || governs) knownLoadHigherDeviceIds.add(deviceId);
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
    return exclusion === null ? [] : [withUnavailableTrajectory(
      buildDiagnosticBase(deviceId, deviceById.get(deviceId), objective, timeZone, powerTracker),
      OBJECTIVE_EXCLUSION_REASON_CODES[exclusion],
    )];
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
): DeferredObjectiveDiagnostic => buildDiagnosticBase(
  task.deviceId, task.device, task.objective, snapshot.timeZone, snapshot.powerTracker,
);

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
    higherPriorityUnbookedPowerKw: task.higherPriorityUnbookedPowerKw,
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
  const frozenFallback = resolveDeadlineBoundFrozenReadInputs(
    deviceId,
    objective,
    progress.progressDirection,
    nowMs,
    activePlans,
  );
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
    ? resolveProgressEnergy(powerTracker, deviceId, objective, progress.remainingUnits, progress)
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

  const activeCommittedPlan = resolveActiveCommittedPlan(
    deviceId,
    objective,
    progress.progressDirection,
    snapshot.activePlans,
  );
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
  const aheadOfHourMilestone = isAheadOfHourMilestone(
    profileEnergy.energyNeededKWh,
    progress.progressDirection,
    milestoneHours,
    nowMs,
    // Live measured progress in the objective's own unit — drives the preferred
    // unit-milestone comparison (rate-free); `energyNeededKWh` is the legacy
    // fallback for commitments without persisted `plannedUnitMilestone`.
    progress.currentValue,
  );
  // Mid-hour frozen read: assemble from the persisted commitment + the live measured
  // value (folded into `aheadOfHourMilestone`), skipping the allocator. The caller
  // sets `frozenRead` exactly when it has decided to serve frozen rather than
  // re-plan (plus the step-gap degradation above), so this is a pure gate — no
  // cold-start determination here (the device delivers up to the committed hour's
  // milestone; whether the current hour was booked at all is the allocator's `:58`
  // decision, read off the commitment).
  if (effectiveFrozenRead) {
    const frozenPlan = buildFrozenHorizonPlan(
      nowMs, deviceId, objective, effectiveFrozenRead, profileEnergy.energyNeededKWh, aheadOfHourMilestone, steps,
    );
    return buildFrozenDiagnostic(
      task, base, progress, profileEnergy, effectiveFrozenRead, frozenPlan, liveStepsUnavailable,
    );
  }
  const horizonPlan = resolveHorizonPlanWithRescue(
    task, profileEnergy, steps, commitment, aheadOfHourMilestone, policyHorizon, horizonInputs,
  );
  return buildFreshDiagnostic(
    task, base, progress, profileEnergy, policyHorizon, horizonPlan, horizonInputs.priceHorizon,
  );
};
