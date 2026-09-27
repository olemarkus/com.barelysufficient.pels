import type { Hour } from '../../packages/shared-domain/src/utils/dateUtils';

// A day's 24 hourly values, indexed by a checked `Hour`. Only the daily budget's
// learning and confidence use it, so it lives with them rather than in the
// shared date helpers.

/** Every hour of a day, in order. Iterate this to walk an {@link HourProfile}. */
export const HOURS_OF_DAY: readonly Hour[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
];

/**
 * A value per hour of the day. Exactly 24 slots, by construction.
 *
 * This is an hour-of-day HISTOGRAM, not a day's buckets: a local day has 23-25
 * of those across a DST change, so size a bucket walk from the bucket array
 * itself and never from `HOURS_OF_DAY.length`.
 */
export type HourProfile = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Build an {@link HourProfile} from a loose array. The length check is the
 * boundary: past it, every `profile[hour]` read is compiler-checked and needs
 * no per-site default.
 */
export function toHourProfile(values: readonly number[]): HourProfile {
  if (values.length !== HOURS_OF_DAY.length) {
    throw new RangeError(`hour profile needs ${HOURS_OF_DAY.length} slots, got ${values.length}`);
  }
  return [...values] as unknown as HourProfile;
}

/** A profile of 24 zeros. */
export const zeroHourProfile = (): HourProfile => toHourProfile(Array.from(HOURS_OF_DAY, () => 0));
