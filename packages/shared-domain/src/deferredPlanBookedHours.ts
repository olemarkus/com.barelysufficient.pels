// The saved intervals of a smart-task plan are its bookings, with `plannedKWh`
// the energy each booking promises. An interval booked on price, or
// because the task cannot finish without it, that the forecast left no room for
// carries 0 kWh: the task runs there if capacity turns out to be free, but nothing
// is promised. Planned run duration, first start and run bands read only bookings
// with energy. The `hours` property name is retained in the saved contract.
// Intervals arrive validated at their persisted boundary (`activePlanSettings`, the
// settings UI's `deferredObjectiveActivePlans`), so `plannedKWh` is finite here.
export const hasPlannedEnergy = (hour: { plannedKWh: number }): boolean => hour.plannedKWh > 0;

export const hoursWithPlannedEnergy = <T extends { plannedKWh: number }>(hours: readonly T[]): T[] => (
  hours.filter(hasPlannedEnergy)
);

// When the device is first planned to run: the first interval of `revision` that
// promises energy, or null with no revision or no such interval.
export const resolveFirstPlannedHourMs = (
  revision: { hours: readonly { startsAtMs: number; plannedKWh: number }[] } | null,
): number | null => (
  revision === null ? null : hoursWithPlannedEnergy(revision.hours)[0]?.startsAtMs ?? null
);

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
