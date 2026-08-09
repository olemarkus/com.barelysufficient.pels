import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanReservationSegmentV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { buildObjectiveSignature } from './activePlanSignature';
import { buildLiveReservationSegments } from './activePlanSchedule';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import { resolveObjectiveSteps } from './objectiveSteps';
import type {
  DeferredObjectivePriorityReservation,
} from './policyHorizon';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from './settings';
import { rankActiveDevicePriorities } from '../../../packages/shared-domain/src/modePriorities';
import {
  selectMinimumStepForEnergy,
} from './stepSelection';
import { ELIGIBILITY_ABANDON_GRACE_MS } from './concurrentEligibleTasks';
import { roundKWh } from './activePlanMath';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';

const HOUR_MS = 60 * 60 * 1000;
const EPSILON_KWH = 0.001;
const DEFAULT_PRIORITY = 100;

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
    isDeviceInSubHome?: (deviceId: string) => boolean;
  }): void {
    const observedDeviceIds = new Set<string>();
    for (const device of params.devices) {
      if (params.isDeviceInSubHome?.(device.id) === true) {
        this.lastSeenAtMsByDeviceId.delete(device.id);
        this.missingReservationSinceByDeviceId.delete(device.id);
        continue;
      }
      observedDeviceIds.add(device.id);
      this.lastSeenAtMsByDeviceId.set(device.id, params.nowMs);
      this.missingReservationSinceByDeviceId.delete(device.id);
    }
    for (const [deviceId, lastSeenAtMs] of this.lastSeenAtMsByDeviceId) {
      if (params.isDeviceInSubHome?.(deviceId) === true) {
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

const resolvedPriority = (
  device: ObjectiveDeviceInput | undefined,
  fallback = DEFAULT_PRIORITY,
): number => (
  typeof device?.priority === 'number' && Number.isFinite(device.priority)
    ? device.priority
    : fallback
);

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
  isDeviceInSubHome?: (deviceId: string) => boolean;
  tracker?: PriorityAllocationTracker;
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  nowMs: number;
  // Live mode-catalog read. Production callers provide this so the full
  // visible-plus-grace roster is ordered from the user's current saved mode,
  // never from a runtime-persisted rank. Optional for isolated legacy callers.
  getBasePriorityForDevice?: (deviceId: string) => unknown;
}): OrderedDeferredObjective[] => {
  params.tracker?.retainObjectiveDeviceIds(new Set(Object.keys(params.settings.objectivesByDeviceId)));
  const entries = Object.entries(params.settings.objectivesByDeviceId).flatMap(([deviceId, objective]) => {
    if (!objective.enabled || params.isDeviceInSubHome?.(deviceId) === true) return [];
    const device = params.deviceById.get(deviceId);
    const activePlan = resolveActiveCommittedPlan({
      activePlans: params.activePlans,
      deviceId,
      objective,
    });
    const reservationEligible = device !== undefined || (
      params.tracker
        ? params.tracker.shouldReserveMissingDevice({
          deviceId,
          nowMs: params.nowMs,
          hasPersistedCommitment: activePlan !== undefined,
        })
        : activePlan !== undefined
    );
    return [{ deviceId, objective, device, reservationEligible }];
  });
  const activeDeviceIds = [
    ...[...params.deviceById.values()].flatMap((device) => (
      params.isDeviceInSubHome?.(device.id) === true ? [] : [device.id]
    )),
    ...entries.flatMap((entry) => entry.reservationEligible ? [entry.deviceId] : []),
  ];
  const activePriorityByDeviceId = rankActiveDevicePriorities(
    activeDeviceIds,
    (deviceId) => {
      if (params.getBasePriorityForDevice) return params.getBasePriorityForDevice(deviceId);
      return resolvedPriority(params.deviceById.get(deviceId));
    },
  );
  const inactivePriorityByDeviceId = rankActiveDevicePriorities(
    entries.flatMap((entry) => entry.reservationEligible ? [] : [entry.deviceId]),
    (deviceId) => params.getBasePriorityForDevice
      ? params.getBasePriorityForDevice(deviceId)
      : DEFAULT_PRIORITY,
  );
  const activeDeviceCount = Object.keys(activePriorityByDeviceId).length;
  return entries
    .map((entry) => {
      const priority = activePriorityByDeviceId[entry.deviceId]
        ?? activeDeviceCount + (inactivePriorityByDeviceId[entry.deviceId] ?? DEFAULT_PRIORITY);
      return {
        ...entry,
        priority,
        ...(entry.device ? { device: { ...entry.device, priority } } : {}),
      };
    })
    .sort((left, right) => left.priority - right.priority || compareDeviceIdAsc(left.deviceId, right.deviceId));
};

const objectiveSignature = (entry: OrderedDeferredObjective): string => buildObjectiveSignature({
  objectiveKind: entry.objective.kind,
  targetTemperatureC: entry.objective.kind === 'temperature' ? entry.objective.targetTemperatureC : null,
  targetPercent: entry.objective.kind === 'ev_soc' ? entry.objective.targetPercent : null,
  deadlineAtMs: entry.objective.deadlineAtMs,
  enforcement: entry.objective.enforcement,
  rescue: entry.objective.rescue,
});

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
  hardCapKw: number | null | undefined;
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
  return typeof params.hardCapKw === 'number' && Number.isFinite(params.hardCapKw) && params.hardCapKw > 0
    ? params.hardCapKw
    : Math.max(0, params.hour.plannedKWh);
};

const reservationsFromHours = (params: {
  deviceId: string;
  hours: readonly ReservationHour[];
  device: ObjectiveDeviceInput | undefined;
  hardCapKw: number | null | undefined;
  exemptFromBudget: boolean;
  deadlineAtMs: number;
}): DeferredObjectivePriorityReservation[] => params.hours.flatMap((hour) => {
  if (hour.plannedKWh <= EPSILON_KWH) return [];
  return [{
    deviceId: params.deviceId,
    topologyKey: `legacy:${hour.startsAtMs}:${hour.energySegments.map((segment) => (
      `${segment.startMs}-${segment.endMs}`
    )).join(',')}`,
    startsAtMs: hour.startsAtMs,
    plannedKWh: roundKWh(hour.plannedKWh),
    admissionPowerKw: resolveLegacyAdmissionPowerKw({
      hour,
      device: params.device,
      hardCapKw: params.hardCapKw,
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

export const buildPriorityReservations = (params: {
  diagnostic: DeferredObjectiveDiagnostic;
  objective: DeferredObjectiveSettingsEntry;
  device: ObjectiveDeviceInput | undefined;
  activePlans: DeferredObjectiveActivePlansV1 | null | undefined;
  hardCapKw: number | null | undefined;
}): DeferredObjectivePriorityReservation[] => {
  const activePlan = resolveActiveCommittedPlan({
    activePlans: params.activePlans,
    deviceId: params.diagnostic.deviceId,
    objective: params.objective,
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
  const exemptFromBudget = params.objective.rescue?.exemptFromBudget === 'always';
  const useFreshDiagnostic = params.diagnostic.horizonPlan !== undefined
    && params.diagnostic.horizonPlan.frozenRead !== true;
  if (useFreshDiagnostic) {
    return reservationsFromSegments({
      deviceId: params.diagnostic.deviceId,
      segments: buildLiveReservationSegments(params.diagnostic),
      exemptFromBudget,
    });
  }
  if (activePlan?.latest.reservationSegments !== undefined) {
    return reservationsFromSegments({
      deviceId: params.diagnostic.deviceId,
      segments: activePlan.latest.reservationSegments,
      exemptFromBudget,
    });
  }
  return reservationsFromHours({
    // A fresh allocator result is authoritative even when it books nothing.
    // Frozen diagnostics fabricate epoch-hour buckets for control only, and a
    // missing-device diagnostic has no horizon at all; both reserve from the
    // settled latest revision (exact segments when available, clipped legacy
    // hours otherwise).
    hours: persistedHours,
    deviceId: params.diagnostic.deviceId,
    device: params.device,
    hardCapKw: params.hardCapKw,
    exemptFromBudget,
    deadlineAtMs: params.objective.deadlineAtMs,
  });
};
