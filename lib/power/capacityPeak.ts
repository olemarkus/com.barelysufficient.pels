import type { PowerTrackerState } from './trackerTypes';
import { currentCapacityMonthKey, projectCapacityMonthlyPeak } from './capacityQuarterTracking';

/**
 * Highest fully tracked 15-minute net-import average in the current local month,
 * or `null` while the month has no completed quarter.
 * Completed quarters are compacted at ingest; a sparse held sample is projected
 * across at most its partial quarter and one representative full quarter.
 */
export function resolveCurrentMonthQuarterPeakKw(
  tracker: PowerTrackerState,
  timeZone: string,
  nowMs: number,
): number | null {
  const peak = projectCapacityMonthlyPeak(tracker, nowMs, timeZone);
  return peak?.monthKey === currentCapacityMonthKey(nowMs, timeZone) ? peak.peakKw : null;
}
