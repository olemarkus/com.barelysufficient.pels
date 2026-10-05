/**
 * The wait before the next attempt after `failures` failures in a row: the
 * schedule's entry for that failure (the first entry after the first), and its
 * last entry for every failure past the end of the schedule.
 *
 * Folded rather than indexed, so a non-empty schedule always yields a delay:
 * each entry whose position is below `failures` replaces the one before it.
 */
export const backoffDelayMs = (schedule: readonly [number, ...number[]], failures: number): number => (
  schedule.reduce((delayMs, entryMs, index) => (index < failures ? entryMs : delayMs))
);
