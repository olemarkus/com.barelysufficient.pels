import type { PowerTrackerState } from '../power/tracker';
import { getHourBucketKey } from '../utils/dateUtils';

export type HourUsageContext = {
  bucketKey: string;
  hourStartMs: number;
  hourEndMs: number;
  usedKWh: number;
  remainingMs: number;
  remainingHours: number;
  minutesRemaining: number;
};

export function getCurrentHourContext(
  powerTracker: PowerTrackerState,
  nowMs: number = Date.now(),
): HourUsageContext {
  const bucketKey = getHourBucketKey(nowMs);
  const hourStartMs = new Date(bucketKey).getTime();
  const hourEndMs = hourStartMs + 60 * 60 * 1000;
  // Floor at 0: a persisted solar-export hour can hold a negative kWh, which would
  // otherwise inflate remaining-budget / burst-rate pacing. Billed usage can't be negative.
  const usedKWh = Math.max(0, powerTracker.buckets?.[bucketKey] || 0);
  const remainingMs = Math.max(0, hourEndMs - nowMs);
  const remainingHours = remainingMs / 3600000;
  const minutesRemaining = remainingMs / 60000;
  return {
    bucketKey,
    hourStartMs,
    hourEndMs,
    usedKWh,
    remainingMs,
    remainingHours,
    minutesRemaining,
  };
}
