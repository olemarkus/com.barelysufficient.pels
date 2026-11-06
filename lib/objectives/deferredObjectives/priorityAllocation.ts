import type { TaskAllocationRosterSnapshot } from './taskAllocationRoster';
import type { ModePriorityOrder } from '../../../packages/shared-domain/src/settings/modePriorities';
import type {
  DeferredObjectivePlanInterval,
  DeferredObjectiveActivePlanReservationSegmentV1,
  DeferredObjectiveActivePlansV2,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  resolveObjectiveProgressDirectionRead,
  type ObjectiveDeviceInput,
} from '../../objectives/types';
import { buildObjectiveSignatureForEntry } from './activePlanSignature';
import { buildLiveReservationSegments } from './activePlanSchedule';
import type { TaskEvaluation } from './taskEvaluation';
import { resolveHighestObjectiveAdmissionPowerKw, resolveObjectiveSteps } from './objectiveSteps';
import type {
  DeferredObjectivePriorityReservation,
} from './policyHorizon';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveRoster,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import {
  selectMinimumStepForEnergy,
} from './stepSelection';
import type { DeferredObjectiveStep } from './types';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';
import type { PowerLimitSettings } from '../../../packages/contracts/src/capacitySettings';
import { resolvePlanningCeilingKw } from '../../power/capacityModel';
import { isTaskSatisfied } from './taskCompletion';

const HOUR_MS = 60 * 60 * 1000;
const EPSILON_KWH = 0.001;
const POWER_EPSILON_KW = 0.001;

export type OrderedDeferredObjective = {
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  device?: ObjectiveDeviceInput;
  priority: number;
  reservationEligible: boolean;
  /** Complete main-lane roster above this task, including devices without tasks. */
  higherRankedDeviceIds: readonly string[];
};

// An ordered task as the coordinator evaluates it, in the context of the tasks
// already evaluated ahead of it this cycle.
export type CoordinatedDeferredObjective = OrderedDeferredObjective & {
  /** Power reserved for higher-ranked devices outside task control. */
  higherPriorityUnbookedPowerKw: number;
  /** Every higher-ranked device is task-governed, confirmed not taking power, or has a known maximum step. */
  higherRankedLoadAccountedFor: boolean;
  /** The rescue permissions the allocator may plan with; none once the task is accepted as satisfied. */
  rescuePermissions: TaskEvaluation['permissions'];
};

// Keep the same locale-independent tie-break as `lib/plan/planSort.ts` without
// importing across the objectives→plan boundary.
const compareDeviceIdAsc = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const orderDeferredObjectives = (
  settings: DeferredObjectiveRoster,
  deviceById: ReadonlyMap<string, ObjectiveDeviceInput>,
  /** See `TaskAllocationRoster.observe`: durably out of the main lane. */
  isDeviceExcluded: (deviceId: string) => boolean,
  allocationRoster: TaskAllocationRosterSnapshot,
  activePlans: DeferredObjectiveActivePlansV2,
  // The catalog owner orders the complete visible-plus-grace roster; callers
  // receive only resolved ranks, including temporarily missing devices.
  getPrioritiesForDevices: (deviceIds: readonly string[]) => ModePriorityOrder,
): OrderedDeferredObjective[] => {
  const entries = Object.entries(settings.objectivesByDeviceId).flatMap(([deviceId, objective]) => {
    if (!objective.enabled || isDeviceExcluded(deviceId)) return [];
    const device = deviceById.get(deviceId);
    const activePlan = resolveActiveCommittedPlan(
      deviceId,
      objective,
      resolveObjectiveProgressDirectionRead({
        objectiveKind: objective.kind,
        thermalDirection: device?.thermalDirection ?? 'unknown',
      }),
      activePlans,
    );
    const reservationEligible = device !== undefined || allocationRoster.shouldReserveMissingDevice(
      deviceId,
      activePlan !== undefined,
    );
    return [{ deviceId, objective, device, reservationEligible }];
  });
  const activeDeviceIds = [
    ...[...deviceById.values()].flatMap((device) => (
      isDeviceExcluded(device.id) ? [] : [device.id]
    )),
    ...entries.flatMap((entry) => entry.reservationEligible ? [entry.deviceId] : []),
  ];
  // Two independent rankings, each through the mode catalog owner: the devices
  // competing for allocation, and separately the ones held out of it. Ranks are
  // unique within each set by construction — no two devices can tie, which is
  // what makes the allocation order total.
  const activePriorities = getPrioritiesForDevices(activeDeviceIds);
  const inactivePriorities = getPrioritiesForDevices(
    entries.flatMap((entry) => entry.reservationEligible ? [] : [entry.deviceId]),
  );
  const activeDeviceCount = new Set(activeDeviceIds).size;
  const rankedActiveDeviceIds = [...new Set(activeDeviceIds)]
    .sort((left, right) => activePriorities.getPriority(left) - activePriorities.getPriority(right));
  return entries
    .map((entry) => {
      const priority = entry.reservationEligible
        ? activePriorities.getPriority(entry.deviceId)
        : activeDeviceCount + inactivePriorities.getPriority(entry.deviceId);
      return {
        ...entry,
        priority,
        higherRankedDeviceIds: rankedActiveDeviceIds.filter((id) => activePriorities.getPriority(id) < priority),
      };
    })
    .sort((left, right) => left.priority - right.priority || compareDeviceIdAsc(left.deviceId, right.deviceId));
};

const objectiveSignature = (entry: OrderedDeferredObjective): string => buildObjectiveSignatureForEntry(
  entry.objective,
  resolveObjectiveProgressDirectionRead({
    objectiveKind: entry.objective.kind,
    thermalDirection: entry.device?.thermalDirection ?? 'unknown',
  }),
);

export const buildAllocationContextSignature = (
  entries: readonly OrderedDeferredObjective[],
): string => JSON.stringify(entries.map((entry) => [
  entry.deviceId,
  entry.priority,
  objectiveSignature(entry),
]));

export const buildTaskAllocationContextSignature = (params: {
  rosterSignature: string;
  higherPriorityReservations?: readonly DeferredObjectivePriorityReservation[];
}): string => {
  const claimsByKey = new Map<string, readonly [string, string]>();
  for (const reservation of params.higherPriorityReservations ?? []) {
    const claim = [reservation.deviceId, reservation.topologyKey] as const;
    claimsByKey.set(JSON.stringify(claim), claim);
  }
  return JSON.stringify([
    params.rosterSignature,
    [...claimsByKey.values()]
      .sort((left, right) => compareDeviceIdAsc(left[0], right[0]) || compareDeviceIdAsc(left[1], right[1])),
  ]);
};

type ReservationHour = DeferredObjectivePlanInterval & {
  energySegments: Array<{ startMs: number; endMs: number; plannedKWh: number }>;
};

const resolveLegacyAdmissionPowerKw = (
  hour: DeferredObjectivePlanInterval,
  device: ObjectiveDeviceInput | undefined,
  planningCeilingKw: number | null,
  deadlineAtMs: number,
): number => {
  const persisted = hour.plannedAdmissionPowerKw;
  if (typeof persisted === 'number' && Number.isFinite(persisted) && persisted > 0) return persisted;
  const durationHours = Math.min(
    1,
    Math.max(
      Number.EPSILON,
      (
        Math.min(hour.endsAtMs, deadlineAtMs)
        - (hour.coversFromMs ?? hour.startsAtMs)
      ) / HOUR_MS,
    ),
  );
  if (device) {
    const step = selectMinimumStepForEnergy(
      resolveObjectiveSteps(device),
      hour.plannedKWh,
      durationHours,
      EPSILON_KWH,
    );
    if (step) return step.admissionPowerKw;
  }
  // No rung to read (a missing device, or none active): the booking may take the
  // whole planning ceiling, the conservative reading. With no power limit enabled
  // there is no ceiling to take, and nothing reserves room under one
  // (`resolveReservedHeadroomKw`), so the booking's own average rate, its energy
  // over the span it covers, is the only figure the facts support.
  return planningCeilingKw ?? hour.plannedKWh / durationHours;
};

const reservationsFromHours = (
  deviceId: string,
  hours: readonly ReservationHour[],
  device: ObjectiveDeviceInput | undefined,
  planningCeilingKw: number | null,
  exemptFromBudget: boolean,
  deadlineAtMs: number,
): DeferredObjectivePriorityReservation[] => hours.flatMap((hour) => {
  if (hour.plannedKWh <= 0) return [];
  return [{
    deviceId,
    topologyKey: `legacy:${hour.startsAtMs}:${hour.energySegments.map((segment) => (
      `${segment.startMs}-${segment.endMs}`
    )).join(',')}`,
    startsAtMs: hour.startsAtMs,
    plannedKWh: hour.plannedKWh,
    admissionPowerKw: resolveLegacyAdmissionPowerKw(
      hour,
      device,
      planningCeilingKw,
      deadlineAtMs,
    ),
    exemptFromBudget,
    energySegments: hour.energySegments,
  }];
});

const reservationsFromSegments = (
  deviceId: string,
  segments: readonly DeferredObjectiveActivePlanReservationSegmentV1[],
  exemptFromBudget: boolean,
): DeferredObjectivePriorityReservation[] => segments.map((segment) => ({
  deviceId,
  topologyKey: segment.sourceBucketId ?? `segment:${segment.startMs}:${segment.endMs}`,
  startsAtMs: segment.startMs,
  plannedKWh: segment.plannedKWh,
  admissionPowerKw: segment.plannedAdmissionPowerKw,
  exemptFromBudget,
  energySegments: [{
    startMs: segment.startMs,
    endMs: segment.endMs,
    plannedKWh: segment.plannedKWh,
  }],
}));

// A booking holds its admission power only for as long as its energy takes at the
// booked rung, not across its whole bucket: 0.56 kWh booked on a 3 kW water heater
// draws for about 11 minutes, and the rest of that hour is free for the tasks
// below. `buildDeferredObjectivePolicyHorizon` already splits a lower task's
// buckets at reservation boundaries, so the narrowed window is all it needs.
//
// The booked rung is the highest one whose nameplate fits the booking's admission
// power: exact for a rung the allocator booked, while a legacy admission figure
// that matches no rung lands on a lower one, whose slower rate only lengthens the
// window. The window starts at the booking's start, or at `nowMs` once the booking
// has begun: the energy may still be undelivered, so the elapsed part of the
// bucket cannot stand in for it. With no rung to read (missing device, nothing
// fits) the booking keeps its whole bucket, the conservative reading.
const narrowToDrawWindow = (
  reservation: DeferredObjectivePriorityReservation,
  steps: readonly DeferredObjectiveStep[],
  nowMs: number,
): DeferredObjectivePriorityReservation => {
  const booked = steps.filter((step) => (
    step.usefulPowerKw > 0 && step.admissionPowerKw <= reservation.admissionPowerKw + POWER_EPSILON_KW
  )).sort((left, right) => left.admissionPowerKw - right.admissionPowerKw).at(-1);
  if (!booked) return reservation;
  const { usefulPowerKw } = booked;
  return {
    ...reservation,
    energySegments: reservation.energySegments.map((segment) => {
      const startMs = Math.max(segment.startMs, nowMs);
      if (startMs >= segment.endMs) return segment;
      const drawMs = (segment.plannedKWh / usefulPowerKw) * HOUR_MS;
      return { ...segment, startMs, endMs: Math.min(segment.endMs, startMs + drawMs) };
    }),
  };
};

export const buildPriorityReservations = (
  evaluation: TaskEvaluation,
  objective: DeferredObjectiveSettingsEntry,
  device: ObjectiveDeviceInput | undefined,
  activePlans: DeferredObjectiveActivePlansV2,
  powerLimits: PowerLimitSettings,
  nowMs: number,
): DeferredObjectivePriorityReservation[] => {
  if (isTaskSatisfied(evaluation.completion)) return [];
  const steps = device ? resolveObjectiveSteps(device) : [];
  const maxStepPowerKw = device ? resolveHighestObjectiveAdmissionPowerKw(device) : null;
  const narrow = (reservations: DeferredObjectivePriorityReservation[]): DeferredObjectivePriorityReservation[] => (
    reservations.map((reservation) => narrowToDrawWindow(
      maxStepPowerKw === null ? reservation : {
        ...reservation,
        admissionPowerKw: Math.min(reservation.admissionPowerKw, maxStepPowerKw),
      },
      steps,
      nowMs,
    ))
  );
  const activePlan = resolveActiveCommittedPlan(
    evaluation.deviceId,
    objective,
    evaluation.progress.kind === 'known'
      ? evaluation.progress.direction
      : resolveObjectiveProgressDirectionRead({
        objectiveKind: objective.kind,
        thermalDirection: device?.thermalDirection ?? 'unknown',
      }),
    activePlans,
  );
  const persistedHours = (activePlan?.latest.hours ?? []).flatMap((hour): ReservationHour[] => {
    const startMs = hour.coversFromMs ?? hour.startsAtMs;
    const endMs = Math.min(hour.endsAtMs, objective.deadlineAtMs);
    if (endMs <= startMs) return [];
    return [{
    ...hour,
    energySegments: [{
      startMs,
      endMs,
      plannedKWh: hour.plannedKWh,
    }],
    }];
  });
  const exemptFromBudget = evaluation.permissions.budgetExempt;
  if (evaluation.planning.kind === 'allocated' && evaluation.planning.plan.frozenRead !== true) {
    return narrow(reservationsFromSegments(
      evaluation.deviceId,
      buildLiveReservationSegments(evaluation.planning.plan),
      exemptFromBudget,
    ));
  }
  if (activePlan?.latest.reservationSegments !== undefined) {
    return narrow(reservationsFromSegments(
      evaluation.deviceId,
      activePlan.latest.reservationSegments,
      exemptFromBudget,
    ));
  }
  return narrow(reservationsFromHours(
    evaluation.deviceId,
    // A fresh allocator result is authoritative even when it books nothing.
    // Frozen plans fabricate epoch-hour buckets for control only. An inactive
    // evaluation may retain a missing device through grace; both reserve from the
    // settled latest revision (exact segments when available, clipped legacy
    // hours otherwise).
    persistedHours,
    device,
    resolvePlanningCeilingKw(powerLimits),
    exemptFromBudget,
    objective.deadlineAtMs,
  ));
};
