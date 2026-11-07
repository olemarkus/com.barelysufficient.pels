import type { TaskAdmissionReservation, TaskEnergyReservation } from '../ports/taskReservations';

export function reservationEnergy(
  reservations: readonly TaskEnergyReservation[],
  startMs: number,
  endMs: number,
): number {
  return reservations.reduce((energy, segment) => {
    const overlapMs = Math.max(0, Math.min(segment.endMs, endMs) - Math.max(segment.startMs, startMs));
    return energy + overlapMs * segment.plannedKWh / (segment.endMs - segment.startMs);
  }, 0);
}

export function reservationPowerKW(
  reservations: readonly TaskAdmissionReservation[],
  startMs: number,
  endMs: number,
): number {
  return reservations.reduce((total, reservation) => (
    reservation.startMs < endMs && reservation.endMs > startMs ? total + reservation.admissionPowerKw : total
  ), 0);
}
