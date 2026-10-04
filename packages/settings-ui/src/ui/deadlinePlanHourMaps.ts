import type { DeferredObjectiveActivePlanRevisionV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';

// Single planned-hour predicate: an hour is planned iff it appears in this
// map. Zero/non-positive allocations are dropped at construction so `has`
// (hero `firstChargingHour`) and `(get(...) ?? 0) > 0` (timeline bars,
// trajectory bands/staircase) can never disagree about whether an hour runs.
export const buildChargeByStartMs = (
  revision: DeferredObjectiveActivePlanRevisionV1 | null,
): Map<number, number> => {
  const out = new Map<number, number>();
  if (!revision) return out;
  for (const hour of revision.hours) {
    if (hour.plannedKWh > 0) out.set(hour.startsAtMs, hour.plannedKWh);
  }
  return out;
};

// Coverage starts (`coversFromMs`) for the booked hours, keyed like
// `buildChargeByStartMs`. Present only for buckets the planner already
// trimmed at a mid-hour revision (absence ⇒ the energy covers the full
// hour). The trajectory staircase needs this to prorate the in-progress
// hour without double-trimming an already-trimmed bucket.
export const buildCoverStartByStartMs = (
  revision: DeferredObjectiveActivePlanRevisionV1 | null,
): Map<number, number> => {
  const out = new Map<number, number>();
  if (!revision) return out;
  for (const hour of revision.hours) {
    if (hour.plannedKWh > 0 && typeof hour.coversFromMs === 'number') {
      out.set(hour.startsAtMs, hour.coversFromMs);
    }
  }
  return out;
};
