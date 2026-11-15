import type { PowerTrackerState } from './trackerTypes';
import { currentCapacityMonthKey, projectCapacityMonthlyPeak } from './capacityQuarterTracking';
import type { MeterMonthlyPeak } from './meterMonthlyPeak';
import type { CapacityMonthPeak } from '../../packages/contracts/src/settingsUi/power';

export type { CapacityMonthPeak } from '../../packages/contracts/src/settingsUi/power';

const NO_COMPLETED_QUARTER: CapacityMonthPeak = { state: 'no_completed_quarter' };

/**
 * This month's capacity peak: the higher of the highest fully tracked
 * 15-minute net-import average in the current local month and the month peak
 * the home's meter reports itself, with which of the two set it, or none while
 * the month has neither. The one place the month's peak is resolved: the
 * settings readouts and the held hard cap (`heldCapacityLimit.ts`) all read it.
 *
 * Completed quarters are compacted at ingest; a sparse held sample is projected
 * across at most its partial quarter and one representative full quarter. A
 * peak retained from an earlier month is not this month's, and neither is a
 * meter value last changed in an earlier month: after the 1st, the meter's peak
 * counts again once the meter reports one in the new month. The meter's peak
 * wins a tie, since it is the one the grid operator bills.
 */
export function resolveCurrentMonthCapacityPeak(
  tracker: PowerTrackerState,
  meterPeak: MeterMonthlyPeak | null,
  timeZone: string,
  nowMs: number,
): CapacityMonthPeak {
  const monthKey = currentCapacityMonthKey(nowMs, timeZone);
  const projected = projectCapacityMonthlyPeak(tracker, nowMs, timeZone);
  const trackedKw = projected?.monthKey === monthKey ? projected.peakKw : null;
  const meterKw = meterPeak !== null && currentCapacityMonthKey(meterPeak.observedAtMs, timeZone) === monthKey
    ? meterPeak.peakKw
    : null;
  if (meterKw !== null && (trackedKw === null || meterKw >= trackedKw)) {
    return { state: 'recorded', peakKw: meterKw, source: 'meter' };
  }
  return trackedKw === null ? NO_COMPLETED_QUARTER : { state: 'recorded', peakKw: trackedKw, source: 'tracked' };
}

