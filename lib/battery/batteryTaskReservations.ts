import type {
  DeferredObjectivePlanInterval,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV2,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';

const HOUR_MS = 3_600_000;
export type BatteryTaskReservation = { startMs: number; endMs: number; energyKW: number; admissionKW: number };
type CommittedTask = DeferredObjectiveActivePlanV1 & { latest: DeferredObjectiveActivePlanRevisionV1 };

/** Paused tasks retain historical bookings, but contribute no current energy or power. */
export function tasksForDevices(
  active: DeferredObjectiveActivePlansV2,
  devices: readonly DeviceSurfaces[],
): DeferredObjectiveActivePlansV2 {
  const managedIds = new Set(devices.filter(device => device.managed).map(device => device.id));
  return {
    ...active,
    plansByDeviceId: Object.fromEntries(Object.entries(active.plansByDeviceId)
      .filter(([deviceId]) => managedIds.has(deviceId))),
  };
}

const isCommitted = (task: DeferredObjectiveActivePlanV1): task is CommittedTask => (
  !task.pending && task.latest !== null
);

function bookingReservation(
  hour: DeferredObjectivePlanInterval,
  deadlineAtMs: number,
  nowMs: number,
): BatteryTaskReservation[] {
  if (hour.plannedKWh <= 0) return [];
  const startMs = hour.coversFromMs ?? hour.startsAtMs;
  const endMs = Math.min(deadlineAtMs, hour.endsAtMs);
  if (endMs <= nowMs || endMs <= startMs) return [];
  const energyKW = hour.plannedKWh * HOUR_MS / (endMs - startMs);
  return [{ startMs, endMs, energyKW, admissionKW: hour.plannedAdmissionPowerKw ?? energyKW }];
}

function committedReservations(task: CommittedTask, nowMs: number): BatteryTaskReservation[] {
  const segments = task.latest.reservationSegments;
  if (segments === undefined) {
    return task.latest.hours.flatMap(hour => bookingReservation(hour, task.deadlineAtMs, nowMs));
  }
  return segments.flatMap((segment): BatteryTaskReservation[] => {
    if (segment.plannedKWh <= 0 || segment.endMs <= nowMs) return [];
    return [{
      startMs: segment.startMs,
      endMs: segment.endMs,
      energyKW: segment.plannedKWh * HOUR_MS / (segment.endMs - segment.startMs),
      admissionKW: segment.plannedAdmissionPowerKw,
    }];
  });
}

export function taskReservations(
  active: DeferredObjectiveActivePlansV2,
  nowMs: number,
): BatteryTaskReservation[] | 'waiting' {
  const tasks = Object.values(active.plansByDeviceId)
    .filter(task => task.deadlineAtMs > nowMs && task.liveCompletion.kind !== 'satisfied');
  const committed = tasks.filter(isCommitted);
  if (committed.length !== tasks.length) return 'waiting';
  return committed.flatMap(task => committedReservations(task, nowMs));
}

export function reservationEnergy(
  reservations: readonly BatteryTaskReservation[],
  startMs: number,
  endMs: number,
): number {
  return reservations.reduce((energy, segment) => {
    const overlapMs = Math.max(0, Math.min(segment.endMs, endMs) - Math.max(segment.startMs, startMs));
    return energy + overlapMs * segment.energyKW / HOUR_MS;
  }, 0);
}

export function reservationPowerKW(
  reservations: readonly BatteryTaskReservation[],
  startMs: number,
  endMs: number,
): number {
  return reservations.reduce((total, reservation) => (
    reservation.startMs < endMs && reservation.endMs > startMs ? total + reservation.admissionKW : total
  ), 0);
}
