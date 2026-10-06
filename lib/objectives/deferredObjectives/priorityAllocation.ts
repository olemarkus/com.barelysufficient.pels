import type { ModePriorityOrder } from '../../../packages/shared-domain/src/settings/modePriorities';
import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanReservationSegmentV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  resolveObjectiveProgressDirectionRead,
  type ObjectiveDeviceInput,
} from '../../objectives/types';
import { buildObjectiveSignatureForEntry } from './activePlanSignature';
import { buildLiveReservationSegments } from './activePlanSchedule';
import type { TaskEvaluation } from './taskEvaluation';
import { resolveObjectiveSteps } from './objectiveSteps';
import type {
  DeferredObjectivePriorityReservation,
} from './policyHorizon';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import {
  selectMinimumStepForEnergy,
} from './stepSelection';
import type { DeferredObjectiveStep } from './types';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';

const HOUR_MS = 60 * 60 * 1000;
const EPSILON_KWH = 0.001;
const POWER_EPSILON_KW = 0.001;

// Survive one full cooldown window of transient SDK misses before a device
// stops holding a reservation. Without this window, a single Homey SDK
// snapshot eviction (`feedback_homey_sdk_unreliable`) drops the device from
// `params.devices` for one plan cycle, its reserved energy is released to
// lower-priority tasks, and diagnostic verdicts oscillate `on_track` ↔
// `at_risk: feasible_above_floor` across adjacent cycles. Capacity guard still
// holds regardless, so this is verdict-flicker hardening only.
//
// It governs two maps with different lifetimes: `lastSeenAtMsByDeviceId` (the
// roster, pruned here in `observe`) and `missingReservationSinceByDeviceId`
// (the reservation decision, read by `shouldReserveMissingDevice`, which also
// seeds one window from a persisted commitment after a restart).
//
// Picked to align with the abandon-grace pattern in `planHistory.ts`
// (`ABANDON_GRACE_MS = 60 min`): both want "tolerate a long-ish gap before
// reclassifying state derived from a possibly-flaky SDK read." A shorter
// window leaves the flicker visible on slow-recovering devices; a longer
// window keeps reserving for a genuinely-removed device past the point it can
// return — harmless, because over-reserving only under-books lower-priority
// tasks, the strictly conservative direction.
export const ELIGIBILITY_ABANDON_GRACE_MS = 60 * 60 * 1000;

// Keeps the allocation roster stable across a transient SDK device-snapshot
// miss. It deliberately stores presence timestamps only: the mode catalog is
// the durable priority source, and `orderDeferredObjectives` derives a fresh
// unique order from that source every time the roster is read.
export class PriorityAllocationTracker {
  private readonly lastSeenAtMsByDeviceId = new Map<string, number>();

  private readonly missingReservationSinceByDeviceId = new Map<string, number>();

  public observe(params: {
    devices: readonly ObjectiveDeviceInput[];
    nowMs: number;
    /**
     * Durably out of the main planning lane (separately-metered home, or not
     * managed by PELS). Such a device is purged from the roster outright rather
     * than aged through the missing-device grace: the grace exists for a device
     * that should be here and briefly is not, and neither exclusion is that.
     */
    isDeviceExcluded: (deviceId: string) => boolean;
  }): void {
    const observedDeviceIds = new Set<string>();
    for (const device of params.devices) {
      if (params.isDeviceExcluded(device.id)) {
        this.lastSeenAtMsByDeviceId.delete(device.id);
        this.missingReservationSinceByDeviceId.delete(device.id);
        continue;
      }
      observedDeviceIds.add(device.id);
      this.lastSeenAtMsByDeviceId.set(device.id, params.nowMs);
      this.missingReservationSinceByDeviceId.delete(device.id);
    }
    for (const [deviceId, lastSeenAtMs] of this.lastSeenAtMsByDeviceId) {
      if (params.isDeviceExcluded(deviceId)) {
        this.lastSeenAtMsByDeviceId.delete(deviceId);
        this.missingReservationSinceByDeviceId.delete(deviceId);
        continue;
      }
      if (observedDeviceIds.has(deviceId)) continue;
      if (!this.missingReservationSinceByDeviceId.has(deviceId)) {
        this.missingReservationSinceByDeviceId.set(deviceId, lastSeenAtMs);
      }
      if (params.nowMs - lastSeenAtMs >= ELIGIBILITY_ABANDON_GRACE_MS) {
        this.lastSeenAtMsByDeviceId.delete(deviceId);
      }
    }
  }

  public retainObjectiveDeviceIds(deviceIds: ReadonlySet<string>): void {
    for (const deviceId of this.missingReservationSinceByDeviceId.keys()) {
      if (!deviceIds.has(deviceId)) this.missingReservationSinceByDeviceId.delete(deviceId);
    }
  }

  public shouldReserveMissingDevice(params: {
    deviceId: string;
    nowMs: number;
    hasPersistedCommitment: boolean;
  }): boolean {
    const missingSinceMs = this.missingReservationSinceByDeviceId.get(params.deviceId);
    if (missingSinceMs !== undefined) {
      return params.nowMs - missingSinceMs < ELIGIBILITY_ABANDON_GRACE_MS;
    }
    if (!params.hasPersistedCommitment) return false;
    // A fresh runtime has no device-observation history. Seed one conservative
    // grace window from the persisted commitment so the first post-restart
    // cycle cannot overbook a temporarily missing higher-priority task.
    this.missingReservationSinceByDeviceId.set(params.deviceId, params.nowMs);
    return true;
  }

}

export type OrderedDeferredObjective = {
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  device?: ObjectiveDeviceInput;
  priority: number;
  reservationEligible: boolean;
};

// An ordered task as the coordinator evaluates it, in the context of the tasks
// already evaluated ahead of it this cycle.
export type CoordinatedDeferredObjective = OrderedDeferredObjective & {
  // Every device ranked above this one is governed by a smart task, so all the
  // load this task cannot displace reaches it as bookings. Gates floor promotion
  // (`rescueReplan.ts`).
  higherRankedLoadBooked: boolean;
};

// Keep the same locale-independent tie-break as `lib/plan/planSort.ts` without
// importing across the objectives→plan boundary.
const compareDeviceIdAsc = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const orderDeferredObjectives = (params: {
  settings: DeferredObjectiveSettingsV1;
  deviceById: ReadonlyMap<string, ObjectiveDeviceInput>;
  /** See `PriorityAllocationTracker.observe`: durably out of the main lane. */
  isDeviceExcluded: (deviceId: string) => boolean;
  tracker: PriorityAllocationTracker;
  activePlans: DeferredObjectiveActivePlansV1 | null;
  nowMs: number;
  // The catalog owner orders the complete visible-plus-grace roster; callers
  // receive only resolved ranks, including temporarily missing devices.
  getPrioritiesForDevices: (deviceIds: readonly string[]) => ModePriorityOrder;
}): OrderedDeferredObjective[] => {
  params.tracker.retainObjectiveDeviceIds(new Set(Object.keys(params.settings.objectivesByDeviceId)));
  const entries = Object.entries(params.settings.objectivesByDeviceId).flatMap(([deviceId, objective]) => {
    if (!objective.enabled || params.isDeviceExcluded(deviceId)) return [];
    const device = params.deviceById.get(deviceId);
    const activePlan = resolveActiveCommittedPlan({
      activePlans: params.activePlans,
      deviceId,
      objective,
      progressDirection: resolveObjectiveProgressDirectionRead({
        objectiveKind: objective.kind,
        thermalDirection: device?.thermalDirection ?? 'unknown',
      }),
    });
    const reservationEligible = device !== undefined || params.tracker.shouldReserveMissingDevice({
      deviceId,
      nowMs: params.nowMs,
      hasPersistedCommitment: activePlan !== undefined,
    });
    return [{ deviceId, objective, device, reservationEligible }];
  });
  const activeDeviceIds = [
    ...[...params.deviceById.values()].flatMap((device) => (
      params.isDeviceExcluded(device.id) ? [] : [device.id]
    )),
    ...entries.flatMap((entry) => entry.reservationEligible ? [entry.deviceId] : []),
  ];
  // Two independent rankings, each through the mode catalog owner: the devices
  // competing for allocation, and separately the ones held out of it. Ranks are
  // unique within each set by construction — no two devices can tie, which is
  // what makes the allocation order total.
  const activePriorities = params.getPrioritiesForDevices(activeDeviceIds);
  const inactivePriorities = params.getPrioritiesForDevices(
    entries.flatMap((entry) => entry.reservationEligible ? [] : [entry.deviceId]),
  );
  const activeDeviceCount = new Set(activeDeviceIds).size;
  return entries
    .map((entry) => {
      const priority = entry.reservationEligible
        ? activePriorities.getPriority(entry.deviceId)
        : activeDeviceCount + inactivePriorities.getPriority(entry.deviceId);
      return { ...entry, priority };
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

type ReservationHour = DeferredObjectiveActivePlanHourV1 & {
  energySegments: Array<{ startMs: number; endMs: number; plannedKWh: number }>;
};

const resolveLegacyAdmissionPowerKw = (params: {
  hour: DeferredObjectiveActivePlanHourV1;
  device: ObjectiveDeviceInput | undefined;
  sustainableRateKw: number;
  deadlineAtMs: number;
}): number => {
  const persisted = params.hour.plannedAdmissionPowerKw;
  if (typeof persisted === 'number' && Number.isFinite(persisted) && persisted > 0) return persisted;
  if (params.device) {
    const durationHours = Math.min(
      1,
      Math.max(
        Number.EPSILON,
        (
          Math.min(params.hour.startsAtMs + HOUR_MS, params.deadlineAtMs)
          - (params.hour.coversFromMs ?? params.hour.startsAtMs)
        ) / HOUR_MS,
      ),
    );
    const step = selectMinimumStepForEnergy({
      steps: resolveObjectiveSteps(params.device),
      energyKWh: params.hour.plannedKWh,
      durationHours,
      epsilonKWh: EPSILON_KWH,
    });
    if (step) return step.admissionPowerKw;
  }
  return params.sustainableRateKw;
};

const reservationsFromHours = (params: {
  deviceId: string;
  hours: readonly ReservationHour[];
  device: ObjectiveDeviceInput | undefined;
  sustainableRateKw: number;
  exemptFromBudget: boolean;
  deadlineAtMs: number;
}): DeferredObjectivePriorityReservation[] => params.hours.flatMap((hour) => {
  if (hour.plannedKWh <= 0) return [];
  return [{
    deviceId: params.deviceId,
    topologyKey: `legacy:${hour.startsAtMs}:${hour.energySegments.map((segment) => (
      `${segment.startMs}-${segment.endMs}`
    )).join(',')}`,
    startsAtMs: hour.startsAtMs,
    plannedKWh: hour.plannedKWh,
    admissionPowerKw: resolveLegacyAdmissionPowerKw({
      hour,
      device: params.device,
      sustainableRateKw: params.sustainableRateKw,
      deadlineAtMs: params.deadlineAtMs,
    }),
    exemptFromBudget: params.exemptFromBudget,
    energySegments: hour.energySegments,
  }];
});

const reservationsFromSegments = (params: {
  deviceId: string;
  segments: readonly DeferredObjectiveActivePlanReservationSegmentV1[];
  exemptFromBudget: boolean;
}): DeferredObjectivePriorityReservation[] => params.segments.map((segment) => ({
  deviceId: params.deviceId,
  topologyKey: segment.sourceBucketId ?? `segment:${segment.startMs}:${segment.endMs}`,
  startsAtMs: Math.floor(segment.startMs / HOUR_MS) * HOUR_MS,
  plannedKWh: segment.plannedKWh,
  admissionPowerKw: segment.plannedAdmissionPowerKw,
  exemptFromBudget: params.exemptFromBudget,
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

export const buildPriorityReservations = (params: {
  evaluation: TaskEvaluation;
  objective: DeferredObjectiveSettingsEntry;
  device: ObjectiveDeviceInput | undefined;
  activePlans: DeferredObjectiveActivePlansV1 | null;
  sustainableRateKw: number;
  nowMs: number;
}): DeferredObjectivePriorityReservation[] => {
  const { evaluation } = params;
  if (evaluation.completion.kind === 'target_reached'
    || evaluation.completion.kind === 'accepted_near_target') return [];
  const steps = params.device ? resolveObjectiveSteps(params.device) : [];
  const narrow = (reservations: DeferredObjectivePriorityReservation[]): DeferredObjectivePriorityReservation[] => (
    reservations.map((reservation) => narrowToDrawWindow(reservation, steps, params.nowMs))
  );
  const activePlan = resolveActiveCommittedPlan({
    activePlans: params.activePlans,
    deviceId: evaluation.deviceId,
    objective: params.objective,
    progressDirection: evaluation.progress.kind === 'known'
      ? evaluation.progress.direction
      : resolveObjectiveProgressDirectionRead({
        objectiveKind: params.objective.kind,
        thermalDirection: params.device?.thermalDirection ?? 'unknown',
      }),
  });
  const persistedHours = (activePlan?.latest.hours ?? []).flatMap((hour): ReservationHour[] => {
    const startMs = hour.coversFromMs ?? hour.startsAtMs;
    const endMs = Math.min(hour.startsAtMs + HOUR_MS, params.objective.deadlineAtMs);
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
    return narrow(reservationsFromSegments({
      deviceId: evaluation.deviceId,
      segments: buildLiveReservationSegments(evaluation.planning.plan),
      exemptFromBudget,
    }));
  }
  if (activePlan?.latest.reservationSegments !== undefined) {
    return narrow(reservationsFromSegments({
      deviceId: evaluation.deviceId,
      segments: activePlan.latest.reservationSegments,
      exemptFromBudget,
    }));
  }
  return narrow(reservationsFromHours({
    // A fresh allocator result is authoritative even when it books nothing.
    // Frozen plans fabricate epoch-hour buckets for control only. An inactive
    // evaluation may retain a missing device through grace; both reserve from the
    // settled latest revision (exact segments when available, clipped legacy
    // hours otherwise).
    hours: persistedHours,
    deviceId: evaluation.deviceId,
    device: params.device,
    sustainableRateKw: params.sustainableRateKw,
    exemptFromBudget,
    deadlineAtMs: params.objective.deadlineAtMs,
  }));
};
