import type { PowerTrackerState } from './trackerTypes';
import { currentCapacityMonthKey, projectCapacityMonthlyPeak } from './capacityQuarterTracking';

/**
 * This month's capacity peak as PELS knows it: the highest fully tracked
 * 15-minute net-import average in the current local month, or none while the
 * month has no completed quarter. The one place the month's peak is resolved:
 * the settings readouts and the held hard cap (`heldCapacityLimit.ts`) all read it.
 */
export type CapacityMonthPeak =
  | { state: 'recorded'; peakKw: number }
  | { state: 'no_completed_quarter' };

const NO_COMPLETED_QUARTER: CapacityMonthPeak = { state: 'no_completed_quarter' };

/**
 * Completed quarters are compacted at ingest; a sparse held sample is projected
 * across at most its partial quarter and one representative full quarter. A
 * peak retained from an earlier month is not this month's.
 */
export function resolveCurrentMonthCapacityPeak(
  tracker: PowerTrackerState,
  timeZone: string,
  nowMs: number,
): CapacityMonthPeak {
  const peak = projectCapacityMonthlyPeak(tracker, nowMs, timeZone);
  return peak?.monthKey === currentCapacityMonthKey(nowMs, timeZone)
    ? { state: 'recorded', peakKw: peak.peakKw }
    : NO_COMPLETED_QUARTER;
}

/** The peak in kW for a readout, `null` while the month has no completed quarter. */
export const capacityMonthPeakKw = (peak: CapacityMonthPeak): number | null => (
  peak.state === 'recorded' ? peak.peakKw : null
);
