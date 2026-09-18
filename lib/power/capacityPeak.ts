import type { PowerTrackerState } from './trackerTypes';
import { currentCapacityMonthKey, projectCapacityMonthlyPeak } from './capacityQuarterTracking';

/**
 * Highest fully tracked 15-minute net-import average in the current local month.
 * Completed quarters are compacted at ingest; a sparse held sample is projected
 * across at most its partial quarter and one representative full quarter.
 */
export function resolveCurrentMonthQuarterPeakKw(
  tracker: PowerTrackerState,
  timeZone: string,
  nowMs: number,
): number | null {
  const peak = projectCapacityMonthlyPeak(
    tracker.capacityQuarter,
    tracker.capacityMonthlyPeak,
    tracker.lastTimestamp,
    nowMs,
    tracker.lastPowerW,
    timeZone,
  );
  return peak?.monthKey === currentCapacityMonthKey(nowMs, timeZone) ? peak.peakKw : null;
}

export type CapacityPeakReadoutDeps = {
  getTracker: () => PowerTrackerState;
  getTimeZone: () => string;
  nowMs: () => number;
};

/** Power-owned O(1) readout; wiring supplies collaborators without projecting values. */
export class CapacityPeakReadout {
  constructor(private readonly deps: CapacityPeakReadoutDeps) {}

  read(): number | null {
    return resolveCurrentMonthQuarterPeakKw(
      this.deps.getTracker(),
      this.deps.getTimeZone(),
      this.deps.nowMs(),
    );
  }
}
