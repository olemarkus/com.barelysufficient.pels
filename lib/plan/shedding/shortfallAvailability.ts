import type CapacityGuard from '../../power/capacityGuard';
import type { PowerTrackerState } from '../../power/trackerTypes';
import type { CapacityPeriodMinutes } from '../../../packages/contracts/src/capacitySettings';
import { getCurrentCapacityPeriodContext } from '../planHourContext';

/**
 * THE rule for what an incomplete capacity period means for shortfall
 * reporting: no incident or recovery evidence may be drawn from a period whose
 * elapsed energy is only partly observed. Both askers route through here — the
 * admitted sample (before rebuild throttling, so a skipped build cannot retain
 * authority from the previous period) and the plan build's verdict — so the
 * treatment cannot drift between them.
 *
 * Returns whether the caller may go on to report against this period.
 */
export function applyShortfallPeriodCoverage(
  capacityGuard: CapacityGuard,
  coverageComplete: boolean,
): boolean {
  if (coverageComplete) return true;
  capacityGuard.recordShortfallUnavailable();
  return false;
}

/** The admitted sample's asker: it holds the tracker, not a plan context. */
export function recordShortfallPeriodAvailability(
  capacityGuard: CapacityGuard,
  powerTracker: PowerTrackerState,
  periodMinutes: CapacityPeriodMinutes,
  nowMs: number,
): void {
  applyShortfallPeriodCoverage(
    capacityGuard,
    getCurrentCapacityPeriodContext(powerTracker, periodMinutes, nowMs).coverageComplete,
  );
}
