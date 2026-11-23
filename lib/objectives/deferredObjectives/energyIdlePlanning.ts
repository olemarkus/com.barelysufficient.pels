import type {
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { EnergyTaskIdleState } from '../../../packages/contracts/src/taskDelivery';
import { resolveObjectiveProgressDirectionRead } from '../types';
import { resolveHigherPriorityContentionEvaluation } from './contentionOverlay';
import { reportHigherPriorityContention } from './contentionReporting';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import type { DeferredObjectivePriorityReservation } from './policyHorizon';
import {
  committedPriorityReservations, narrowPriorityReservations, type CoordinatedDeferredObjective,
  type OrderedDeferredObjective,
} from './priorityAllocation';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';
import { isTaskSatisfied } from './taskCompletion';
import { NO_TASK_PERMISSIONS } from './taskEvaluation';
import type { TaskEvaluationSnapshot } from './taskEvaluationCoordinator';
import type { TaskReservationReader } from './taskDeliveryState';
import type { TaskAllocationMode } from './taskPlanningTurns';

const supportsEnergyIdle = (task: OrderedDeferredObjective): boolean => {
  const { objective, device } = task;
  return objective.kind === 'energy' && device?.energyIdleCapable === true;
};

const hasBookingAfterDrawResumed = (
  state: EnergyTaskIdleState | undefined,
  latest: DeferredObjectiveActivePlanRevisionV1 | null | undefined,
  nowMs: number,
): boolean => state?.kind === 'reopened' && latest !== undefined && latest !== null
  && latest.revisedAtMs >= state.sinceMs
  && latest.hours.some((hour) => hour.endsAtMs > nowMs && hour.plannedKWh > 0);

export type EnergyIdlePlanning = 'ineligible' | 'eligible' | 'available_power' | 'reopening' | 'rebooked';
export type EnergyTaskIdleReader = (deviceId: string, deadlineAtMs: number) => EnergyTaskIdleState | undefined;

export const resolveEnergyIdlePlanning = (
  task: OrderedDeferredObjective, snapshot: TaskEvaluationSnapshot, read: EnergyTaskIdleReader | undefined,
  selected: boolean,
): EnergyIdlePlanning => {
  if (read === undefined || !supportsEnergyIdle(task)) return 'ineligible';
  const { deviceId, objective } = task;
  const state = read(deviceId, objective.deadlineAtMs);
  if (state === undefined) return 'eligible';
  const latest = snapshot.activePlans.plansByDeviceId[deviceId]?.latest;
  if (hasBookingAfterDrawResumed(state, latest, snapshot.nowMs)) return 'rebooked';
  return state.kind === 'reopened' && selected ? 'reopening' : 'available_power';
};

const hasFreshPositiveEnergy = (diagnostic: DeferredObjectiveDiagnostic): boolean => {
  const { planning } = diagnostic.evaluation;
  return planning.kind === 'allocated'
    && !planning.plan.frozenRead && planning.plan.plannedUsefulEnergyKWh > 0;
};

/** Use the existing eligible windows without their energy or admission promises. */
const withoutIdleBookings = (
  diagnostic: DeferredObjectiveDiagnostic, write: boolean,
): DeferredObjectiveDiagnostic => {
  const evaluation = diagnostic.evaluation;
  if (isTaskSatisfied(evaluation.completion) || evaluation.planning.kind === 'inactive') return diagnostic;
  if (evaluation.planning.kind !== 'allocated') {
    return { ...diagnostic, evaluation: { ...evaluation, permissions: NO_TASK_PERMISSIONS, usesAvailablePower: true } };
  }
  const { frozenRead: _frozenRead, ...source } = evaluation.planning.plan;
  const { currentBucket } = source;
  const plan = {
    ...source,
    plannedUsefulEnergyKWh: 0,
    expectedStepId: null,
    currentBucket: currentBucket === null ? null : {
      ...currentBucket, plannedUsefulEnergyKWh: 0, expectedStepId: null,
    },
    plannedBuckets: source.plannedBuckets.map((bucket) => ({
      ...bucket, plannedUsefulEnergyKWh: 0, plannedAdmissionPowerKw: 0,
    })),
    ...(write ? {} : { frozenRead: true as const }),
  };
  return {
    ...diagnostic,
    evaluation: {
      ...evaluation, planning: { kind: 'allocated', plan }, permissions: NO_TASK_PERMISSIONS, usesAvailablePower: true,
    },
    horizonPlan: plan,
    ...(write ? { releasesIdleBookings: true } : {}),
  };
};

const resolveEnergyIdleDiagnostic = (
  evaluate: (allocation: TaskAllocationMode) => DeferredObjectiveDiagnostic,
  allocation: TaskAllocationMode,
  energyIdle: EnergyIdlePlanning,
  selected: boolean,
): DeferredObjectiveDiagnostic => {
  const diagnostic = evaluate(allocation);
  if (energyIdle === 'available_power') return withoutIdleBookings(diagnostic, selected);
  if (energyIdle !== 'reopening') return diagnostic;
  if (hasFreshPositiveEnergy(diagnostic)) return { ...diagnostic, restoresIdleBookings: true };
  // Serving the prior idle posture keeps this unsuccessful allocation in the
  // planning queue. There is no new booking to commit.
  return withoutIdleBookings(evaluate('serve_idle'), false);
};

type EvaluateTaskAllocation = (
  task: CoordinatedDeferredObjective,
  reservations: readonly DeferredObjectivePriorityReservation[],
  allocation: TaskAllocationMode,
) => DeferredObjectiveDiagnostic;

export const resolveTaskAllocationDiagnostic = (
  task: CoordinatedDeferredObjective,
  evaluate: EvaluateTaskAllocation,
  allocation: TaskAllocationMode,
  energyIdle: EnergyIdlePlanning,
  selected: boolean,
  reservations: readonly DeferredObjectivePriorityReservation[],
  readOtherBookings: () => DeferredObjectivePriorityReservation[],
): DeferredObjectiveDiagnostic => {
  const protectedBookings = energyIdle === 'reopening' ? readOtherBookings() : undefined;
  const allocationReservations = protectedBookings ? [...reservations, ...protectedBookings] : reservations;
  const diagnostic = resolveEnergyIdleDiagnostic(
    (mode) => evaluate(task, allocationReservations, mode),
    energyIdle === 'available_power' ? 'serve_idle' : allocation,
    energyIdle, selected,
  );
  const contention = diagnostic.evaluation.usesAvailablePower ? diagnostic.evaluation
    : resolveHigherPriorityContentionEvaluation(
      diagnostic.evaluation, reservations, task.higherPriorityUnbookedPowerKw,
      () => evaluate({ ...task, higherPriorityUnbookedPowerKw: 0 }, protectedBookings ?? [], 'fresh').evaluation,
    );
  const resolved = reportHigherPriorityContention(diagnostic, contention);
  if (energyIdle === 'ineligible') return resolved;
  return {
    ...resolved,
    energyIdleEligible: true,
    ...(energyIdle === 'rebooked' ? { energyIdleBookingRestored: true } : {}),
  };
};

/** A reopening task seeks only room left by already settled promises. */
const reserveExistingTaskBookings = (
  snapshot: TaskEvaluationSnapshot,
  task: OrderedDeferredObjective,
): DeferredObjectivePriorityReservation[] => {
  const { deviceId, objective, device } = task;
  const direction = resolveObjectiveProgressDirectionRead({
    objectiveKind: objective.kind, thermalDirection: device?.thermalDirection ?? 'unknown',
  });
  const current = resolveActiveCommittedPlan(deviceId, objective, direction, snapshot.activePlans);
  if (current === undefined) return [];
  return narrowPriorityReservations(committedPriorityReservations(
    deviceId, current.latest, device, snapshot.powerLimits, objective.deadlineAtMs,
    objective.rescue?.exemptFromBudget === 'always',
  ), device, snapshot.nowMs);
};

export const preserveOtherTaskBookings = (
  snapshot: TaskEvaluationSnapshot, tasks: readonly OrderedDeferredObjective[],
  isSuppressed: TaskReservationReader, read: EnergyTaskIdleReader | undefined,
): DeferredObjectivePriorityReservation[] => tasks
  .filter((task) => task.reservationEligible && !isSuppressed(task.deviceId, task.objective.deadlineAtMs)
    && resolveEnergyIdlePlanning(task, snapshot, read, false) !== 'available_power')
  .flatMap((task) => reserveExistingTaskBookings(snapshot, task));
