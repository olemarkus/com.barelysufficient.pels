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
