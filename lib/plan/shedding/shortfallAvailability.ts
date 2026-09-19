import type CapacityGuard from '../../power/capacityGuard';
import type { PowerTrackerState } from '../../power/trackerTypes';
import type { CapacityPeriodMinutes } from '../../../packages/contracts/src/capacitySettings';
import { getCurrentCapacityPeriodContext } from '../planHourContext';

/**
 * Invalidate incident/recovery evidence as soon as an admitted sample reveals
 * that the selected period is incomplete. This runs before rebuild throttling,
 * so a skipped build cannot retain authority from the previous period.
 */
export function recordShortfallPeriodAvailability(
  capacityGuard: CapacityGuard,
  powerTracker: PowerTrackerState,
  periodMinutes: CapacityPeriodMinutes,
  nowMs: number,
): void {
  if (!getCurrentCapacityPeriodContext(powerTracker, periodMinutes, nowMs).coverageComplete) {
    capacityGuard.recordShortfallUnavailable();
  }
}
