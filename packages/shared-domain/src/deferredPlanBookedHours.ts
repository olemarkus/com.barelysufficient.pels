import type {
  DeferredObjectiveActivePlanRevisionV1, DeferredObjectivePartialPriceSchedule, DeferredObjectivePlanInterval,
} from '../../contracts/src/deferredObjectiveActivePlans';

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

/** The displayed schedule includes projected available-power work. */
export const scheduledTaskIntervals = (
  revision: {
    hours: readonly DeferredObjectivePlanInterval[];
    partialPriceSchedule?: DeferredObjectivePartialPriceSchedule;
  } | null,
): readonly DeferredObjectivePlanInterval[] => {
  if (revision === null) return [];
  const fallback = revision.partialPriceSchedule?.fallbackWindows;
  if (!fallback?.length) return revision.hours;
  return [...revision.hours, ...fallback].sort((a, b) => a.startsAtMs - b.startsAtMs);
};

/** Energy still ahead of a live reading, prorated over the span the booking covers. */
export const resolveRemainingPlannedKWh = (
  interval: DeferredObjectivePlanInterval, nowMs: number, deadlineAtMs: number,
): number => {
  const startsAtMs = interval.coversFromMs ?? interval.startsAtMs;
  const endsAtMs = Math.min(interval.endsAtMs, deadlineAtMs);
  if (endsAtMs <= Math.max(nowMs, startsAtMs)) return 0;
  return interval.plannedKWh * (endsAtMs - Math.max(nowMs, startsAtMs)) / (endsAtMs - startsAtMs);
};

// When the device is first planned to run, including a projected fallback.
export const resolveFirstPlannedHourMs = (
  revision: Pick<DeferredObjectiveActivePlanRevisionV1, 'hours' | 'partialPriceSchedule'> | null,
): number | null => scheduledTaskIntervals(revision).find(hasPlannedEnergy)?.startsAtMs ?? null;
