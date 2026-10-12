// The saved hours of a smart-task plan are its BOOKINGS: every hour the task holds,
// with `plannedKWh` the energy that booking promises. An hour booked on price, or
// because the task cannot finish without it, that the forecast left no room for
// carries 0 kWh: the task runs there if capacity turns out to be free, but nothing
// is promised. Readers that mean "the hours the device is planned to run" (counts,
// first start, run bands) read only the hours with energy.
// Hours arrive validated at their persisted boundary (`activePlanSettings`, the
// settings UI's `deferredObjectiveActivePlans`), so `plannedKWh` is finite here.
export const hasPlannedEnergy = (hour: { plannedKWh: number }): boolean => hour.plannedKWh > 0;

export const hoursWithPlannedEnergy = <T extends { plannedKWh: number }>(hours: readonly T[]): T[] => (
  hours.filter(hasPlannedEnergy)
);

// When the device is first planned to run: the first hour of `revision` that
// promises energy, or null with no revision or no such hour.
export const resolveFirstPlannedHourMs = (
  revision: { hours: readonly { startsAtMs: number; plannedKWh: number }[] } | null,
): number | null => (
  revision === null ? null : hoursWithPlannedEnergy(revision.hours)[0]?.startsAtMs ?? null
);
