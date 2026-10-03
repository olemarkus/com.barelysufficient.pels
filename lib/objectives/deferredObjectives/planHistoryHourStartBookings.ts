import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryHourStartBooking,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import type { InProgressRecord } from './planHistoryInProgressState';
import { hourBucketMs } from './planHistoryV4Helpers';

/**
 * Hour-start bookings: what a smart task's plan had booked for each clock hour
 * when that hour began. History reads these rather than the final revision,
 * whose elapsed hours the hourly re-plan has already dropped. The recorder
 * (`planHistory.ts`) calls `captureHourStartBooking` on every tick of a run, and
 * merges the bookings a restart saved back in with `mergeHourStartBookings`.
 */

// The useful energy a revision booked for one clock hour. Revision hours are
// hour-aligned by `buildHoursFromHorizonPlan`: the current bucket, whose
// `startMs` the planner trims to "now", is floored to its hour and keeps the
// trim point as `coversFromMs`. So the hour starting at `hourMs` is the entry
// whose `startsAtMs` floors to it, and its `plannedKWh` is the booking — a
// full hour when the revision was written before the hour, the remainder from
// `coversFromMs` when the run's first plan arrived inside it. The floor and
// the sum are defensive: persisted revisions are input.
export const bookedKWhForHour = (revision: DeferredObjectiveActivePlanRevisionV1, hourMs: number): number => {
  let total = 0;
  for (const hour of revision.hours) {
    if (hourBucketMs(hour.startsAtMs) !== hourMs) continue;
    if (Number.isFinite(hour.plannedKWh) && hour.plannedKWh > 0) total += hour.plannedKWh;
  }
  return total;
};

// The revision in force when an hour began: the newest of the plan's revisions
// (`latest`, the `history` log, `original`) written at or before the hour's
// start. Reading the log rather than `latest` alone keeps a coordination or
// objective write that lands just after the hour starts, before the run's first
// tick in it, from hiding what the hour began under.
//
// Every revision of the plan belongs to this run, including ones written before
// its history record started (a restart with no saved metered row, or the
// window before a failed boot read recovers): an objective change starts the
// plan over through `markPending`, which leaves it with no revisions and no
// history (`createPlanFromSeed`).
export const revisionInForceAt = (
  plan: DeferredObjectiveActivePlanV1 | undefined,
  hourMs: number,
): DeferredObjectiveActivePlanRevisionV1 | null => {
  if (plan === undefined) return null;
  const candidates = [plan.latest, plan.original].concat(plan.history ?? []);
  let inForce: DeferredObjectiveActivePlanRevisionV1 | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate.revisedAtMs > hourMs) continue;
    if (inForce === null || candidate.revisedAtMs > inForce.revisedAtMs) inForce = candidate;
  }
  return inForce;
};

/**
 * Record the current hour's booking the first time the run sees the hour, from
 * the revision in force when the hour began (`revisionInForceAt`). Called once
 * per tick after the record is merged (and, for a restored run, after its saved
 * bookings are merged back in).
 *
 * An hour with no revision in force at its start has no entry: a plan rebuilt
 * after the hour began (a restart that lost the persisted plan) is not what it
 * started under. The one exception is the run's first plan: when nothing has
 * been recorded yet there is no earlier plan the hour could have started under,
 * so the hour the first plan arrives in records that plan's booking. Only the
 * current hour is recorded, so an hour with no tick inside it (an outage
 * spanning the whole hour) has no entry either; its delivery was not metered.
 * An hour whose start fell in an outage is recorded from the revision still in
 * force when PELS came back, which is what it began under.
 */
export const captureHourStartBooking = (
  record: InProgressRecord,
  plan: DeferredObjectiveActivePlanV1 | undefined,
  nowMs: number,
): InProgressRecord => {
  // The deadline tick still merges the record before it finalizes; the hour
  // the deadline falls in is not part of the run.
  if (nowMs >= record.deadlineAtMs) return record;
  const hourMs = hourBucketMs(nowMs);
  const recorded = record.hourStartBookings;
  if (recorded.some((booking) => booking.atMs === hourMs)) return record;
  const revision = revisionInForceAt(plan, hourMs)
    ?? (recorded.length === 0 ? plan?.latest ?? plan?.original ?? null : null);
  if (revision === null) return record;
  return {
    ...record,
    hourStartBookings: [...recorded, { atMs: hourMs, bookedKWh: bookedKWhForHour(revision, hourMs) }],
  };
};

// Saved bookings first: they were captured at their hours' starts, before the
// restart. A live booking only fills an hour the saved list does not have.
export const mergeHourStartBookings = (
  saved: readonly DeferredObjectivePlanHistoryHourStartBooking[],
  live: readonly DeferredObjectivePlanHistoryHourStartBooking[],
): DeferredObjectivePlanHistoryHourStartBooking[] => {
  const savedHours = new Set(saved.map((booking) => booking.atMs));
  return [...saved, ...live.filter((booking) => !savedHours.has(booking.atMs))]
    .sort((a, b) => a.atMs - b.atMs);
};
