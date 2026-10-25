import type { MeteredPricePeriod } from '../../../packages/planner-types/src/priceHorizon';
import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryHourStartBooking,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import type { InProgressRecord } from './planHistoryInProgressState';

/** What the schedule booked when an actual interval became current. Saved
 * captures win after restart and are never rewritten by a later settle. */

// Sum only the booking's actual overlap with this period. A commitment from
// an earlier source grid keeps its energy density when prices change cadence.
export const bookedKWhForInterval = (
  revision: DeferredObjectiveActivePlanRevisionV1,
  startMs: number,
  endMs: number,
): number => {
  let total = 0;
  for (const interval of revision.hours) {
    const coverageStartMs = interval.coversFromMs ?? interval.startsAtMs;
    const overlapMs = Math.max(0, Math.min(endMs, interval.endsAtMs) - Math.max(startMs, coverageStartMs));
    total += interval.plannedKWh * overlapMs / (interval.endsAtMs - coverageStartMs);
  }
  return total;
};

// The revision in force when an hour began: the newest of the plan's revisions
// (`latest`, the `history` log, `original`) written at or before the hour's
// start. Reading the log rather than `latest` alone keeps a coordination or
// objective write that lands just after the hour starts, before the run's first
// tick in it, from hiding what the hour began under.
//
// Revisions written before the run's history record started still count (a
// restart after a failed store write left no saved metered row, or the window
// before a failed boot read recovers), because they normally belong to this run:
// a Flow objective change starts the plan over through `markPending`, which
// leaves it with no revisions and no history (`createPlanFromSeed`). The rarer
// in-place `objective_changed` revision (`activePlanRecorder.ts`) clears
// `history` but keeps `original`, so the hour that change lands in can be
// booked from that pre-change revision; later hours read the new `latest`.
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

/** Capture only the interval observed on this tick. A whole period crossed
 * during an outage remains unobserved; the first plan may arrive mid-period. */
export const captureHourStartBooking = (
  record: InProgressRecord,
  plan: DeferredObjectiveActivePlanV1 | undefined,
  nowMs: number,
  periods: readonly MeteredPricePeriod[],
): InProgressRecord => {
  if (nowMs >= record.deadlineAtMs) return record;
  const recorded = record.hourStartBookings;
  if (recorded.some((booking) => booking.atMs <= nowMs && booking.endsAtMs > nowMs)) return record;
  const period = periods.find((candidate) => candidate.startMs <= nowMs && candidate.endMs > nowMs);
  if (period === undefined) return record;
  const revision = revisionInForceAt(plan, period.startMs)
    ?? (recorded.length === 0 ? plan?.latest ?? plan?.original ?? null : null);
  if (revision === null) return record;
  // Keep booking geometry, including a first period trimmed to task creation,
  // and never overlay a previously captured span after a source-grid change.
  const boundaries = [period.startMs, Math.min(period.endMs, record.deadlineAtMs),
    ...revision.hours.flatMap((interval) => [interval.coversFromMs ?? interval.startsAtMs, interval.endsAtMs]),
    ...recorded.flatMap((booking) => [booking.atMs, booking.endsAtMs]),
  ];
  const startMs = Math.max(period.startMs, ...boundaries.filter((atMs) => atMs <= nowMs));
  const endMs = Math.min(period.endMs, record.deadlineAtMs, ...boundaries.filter((atMs) => atMs > nowMs));
  return {
    ...record,
    hourStartBookings: [...recorded, {
      atMs: startMs,
      endsAtMs: endMs,
      bookedKWh: bookedKWhForInterval(revision, startMs, endMs),
    }],
  };
};

// Saved coverage wins after restart, including a change of source resolution.
// A live segment may fill only time the saved list never captured.
export const mergeHourStartBookings = (
  saved: readonly DeferredObjectivePlanHistoryHourStartBooking[],
  live: readonly DeferredObjectivePlanHistoryHourStartBooking[],
): DeferredObjectivePlanHistoryHourStartBooking[] => {
  let remaining = [...live];
  for (const previous of saved) {
    remaining = remaining.flatMap((segment) => {
      if (previous.endsAtMs <= segment.atMs || previous.atMs >= segment.endsAtMs) return [segment];
      const pieces = [
        { atMs: segment.atMs, endsAtMs: Math.min(previous.atMs, segment.endsAtMs) },
        { atMs: Math.max(previous.endsAtMs, segment.atMs), endsAtMs: segment.endsAtMs },
      ];
      return pieces.filter((piece) => piece.endsAtMs > piece.atMs).map((piece) => ({
        atMs: piece.atMs,
        endsAtMs: piece.endsAtMs,
        bookedKWh: segment.bookedKWh * (piece.endsAtMs - piece.atMs) / (segment.endsAtMs - segment.atMs),
      }));
    });
  }
  return [...saved, ...remaining].sort((a, b) => a.atMs - b.atMs);
};
