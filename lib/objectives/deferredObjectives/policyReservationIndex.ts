import type { DeferredObjectivePriorityReservation } from './policyHorizon';

type ReservationSegment = DeferredObjectivePriorityReservation['energySegments'][number];
type ReservationWindow = Pick<ReservationSegment, 'startMs' | 'endMs'>;

type IndexedReservationSegment = {
  reservation: DeferredObjectivePriorityReservation;
  segment: ReservationSegment;
  sourceOrder: number;
};

type ReservationNode = {
  entry: IndexedReservationSegment;
  maxEndMs: number;
  left: ReservationNode | undefined;
  right: ReservationNode | undefined;
};

const buildTree = (
  entries: readonly IndexedReservationSegment[],
  start: number,
  end: number,
): ReservationNode | undefined => {
  if (start >= end) return undefined;
  const middle = Math.floor((start + end) / 2);
  const entry = entries[middle];
  if (entry === undefined) return undefined;
  const left = buildTree(entries, start, middle);
  const right = buildTree(entries, middle + 1, end);
  return {
    entry,
    maxEndMs: Math.max(
      entry.segment.endMs,
      left?.maxEndMs ?? entry.segment.endMs,
      right?.maxEndMs ?? entry.segment.endMs,
    ),
    left,
    right,
  };
};

/* eslint-disable functional/immutable-data -- Append overlaps to the query's local result. */
const collectOverlaps = (
  node: ReservationNode | undefined,
  window: ReservationWindow,
  matches: IndexedReservationSegment[],
): void => {
  if (node === undefined || node.maxEndMs <= window.startMs) return;
  collectOverlaps(node.left, window, matches);
  const { segment } = node.entry;
  if (segment.startMs >= window.endMs) return;
  if (segment.endMs > window.startMs) matches.push(node.entry);
  collectOverlaps(node.right, window, matches);
};
/* eslint-enable functional/immutable-data */

/** One horizon's physical claims, indexed by time without changing their source order. */
export class PriorityReservationIndex {
  private readonly root: ReservationNode | undefined;

  constructor(reservations: readonly DeferredObjectivePriorityReservation[]) {
    const entries = reservations.flatMap((reservation) => (
      reservation.energySegments.map((segment) => ({ reservation, segment }))
    )).map((entry, sourceOrder) => ({ ...entry, sourceOrder }));
    entries.sort((left, right) => (
      left.segment.startMs - right.segment.startMs || left.sourceOrder - right.sourceOrder
    ));
    this.root = buildTree(entries, 0, entries.length);
  }

  overlapping(window: ReservationWindow): readonly IndexedReservationSegment[] {
    const matches: IndexedReservationSegment[] = [];
    collectOverlaps(this.root, window, matches);
    // Device insertion order controls the admission sum's floating-point order;
    // energy arrays also retain reservation order rather than chronological order.
    return matches.sort((left, right) => left.sourceOrder - right.sourceOrder);
  }
}
