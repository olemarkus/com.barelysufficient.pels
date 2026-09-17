import type { PowerTrackerState } from './trackerTypes';
import { currentCapacityMonthKey } from './capacityQuarterTracking';

/**
 * Highest fully tracked 15-minute net-import average in the current local month.
 * The tracker compacts completed quarters at ingest, so this read is O(1).
 */
export function resolveCurrentMonthQuarterPeakKw(
  tracker: PowerTrackerState,
  timeZone: string,
  nowMs: number,
): number | null {
  const peak = tracker.capacityMonthlyPeak;
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
