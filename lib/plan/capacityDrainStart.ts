import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';
import { resolveUsableCapacityKw } from '../power/capacityModel';
import { resolveLastTotalPowerKw } from '../power/lastTotalPower';
import type { PowerTrackerState } from '../power/tracker';
import { getCurrentHourContext } from './planHourContext';
import { isInEndOfHourDrain } from './planBudget';

/** Where this hour's end-of-hour drain falls from: what the house drew, and when. */
export type DrainStart = {
  drawKw: number;
  /** Minutes left in the hour at that moment: 10 when it opened at :50, less after a restart. */
  minutesRemaining: number;
};

/**
 * What the house drew when this hour's end-of-hour drain window opened
 * (`planBudget.ts` § end-of-hour drain): the level the drain falls from to the
 * sustainable rate at :00. Starting from the draw at that moment, rather than
 * a fixed level, is what keeps the window from limiting every device above
 * that level at once.
 *
 * Recorded by the first measured plan build inside the window, from its
 * reading (`PlanBuilder`, the one writer), and kept for that hour only. A read
 * before then starts from the draw now, as that build will; after a restart
 * inside the window the drain starts again from the draw and minute the first
 * build sees.
 */
export class CapacityDrainStart {
  private recorded: { hourBucketKey: string; start: DrainStart } | null = null;

  /** Keep a measured build's draw as this hour's start, inside the window and unless the hour has one. */
  record(capacitySettings: CapacitySettings, powerTracker: PowerTrackerState, nowMs: number, drawKw: number): void {
    const hour = getCurrentHourContext(powerTracker, nowMs);
    if (!isInEndOfHourDrain(capacitySettings.periodMinutes, hour.minutesRemaining)) return;
    if (this.recorded?.hourBucketKey === hour.bucketKey) return;
    this.recorded = { hourBucketKey: hour.bucketKey, start: { drawKw, minutesRemaining: hour.minutesRemaining } };
  }

  /**
   * This hour's start, or the draw and minute now before one is recorded. With
   * no whole-home reading the draw is the sustainable rate, so the drain holds
   * the next hour's target.
   */
  startFor(capacitySettings: CapacitySettings, powerTracker: PowerTrackerState, nowMs: number): DrainStart {
    const hour = getCurrentHourContext(powerTracker, nowMs);
    if (this.recorded?.hourBucketKey === hour.bucketKey) return this.recorded.start;
    return {
      drawKw: resolveLastTotalPowerKw(powerTracker) ?? resolveUsableCapacityKw(capacitySettings),
      minutesRemaining: hour.minutesRemaining,
    };
  }
}
