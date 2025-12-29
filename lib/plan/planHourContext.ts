import type { PowerTrackerState } from '../core/powerTracker';
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
  const usedKWh = powerTracker.buckets?.[bucketKey] || 0;
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
