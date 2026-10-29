import { hoursWithPlannedEnergy } from '../../../packages/shared-domain/src/deferredPlanBookedHours';

// Union duration avoids counting adjoining/split reservations twice. Only energy
// bookings contribute to the public planned_hours token; zero-energy claims do not.
export const plannedDurationHours = (
  intervals: readonly { startsAtMs: number; endsAtMs: number; coversFromMs?: number; plannedKWh: number }[],
): number => {
  const booked = hoursWithPlannedEnergy(intervals)
    .map((interval) => ({ start: interval.coversFromMs ?? interval.startsAtMs, end: interval.endsAtMs }))
    .sort((left, right) => left.start - right.start);
  let end = Number.NEGATIVE_INFINITY;
  let durationMs = 0;
  for (const interval of booked) {
    durationMs += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return durationMs / 3_600_000;
};
