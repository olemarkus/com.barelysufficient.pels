import type { PowerTrackerState } from '../power/tracker';
import { MAX_POWER_SAMPLE_GAP_MS } from '../power/trackerTypes';
import { getHourBucketKey } from '../utils/dateUtils';
import type { CapacityPeriodMinutes } from '../../packages/shared-domain/src/settings/capacityPeriod';

export type HourUsageContext = {
  bucketKey: string;
  hourStartMs: number;
  hourEndMs: number;
  usedKWh: number;
  remainingMs: number;
  remainingHours: number;
  minutesRemaining: number;
};

export type CapacityPeriodUsageContext = {
  bucketKey: string;
  periodStartMs: number;
  periodEndMs: number;
  usedKWh: number;
  remainingMs: number;
  remainingHours: number;
  minutesRemaining: number;
  coverageComplete: boolean;
};

type HeldPowerSample = { atMs: number; powerW: number };

const resolveHeldPowerSample = (
  powerTracker: PowerTrackerState,
  nowMs: number,
): HeldPowerSample | undefined => {
  const atMs = powerTracker.lastTimestamp;
  const powerW = powerTracker.lastPowerW;
  return typeof atMs === 'number'
    && atMs <= nowMs
    && nowMs - atMs <= MAX_POWER_SAMPLE_GAP_MS
    && typeof powerW === 'number'
    ? { atMs, powerW }
    : undefined;
};

export function getCurrentCapacityPeriodContext(
  powerTracker: PowerTrackerState,
  periodMinutes: CapacityPeriodMinutes,
  nowMs: number = Date.now(),
): CapacityPeriodUsageContext {
  const periodMs = periodMinutes * 60 * 1000;
  const periodStartMs = Math.floor(nowMs / periodMs) * periodMs;
  const bucketKey = new Date(periodStartMs).toISOString();
  const periodEndMs = periodStartMs + periodMs;
  const quarter = powerTracker.capacityQuarter;
  const quarterMatches = quarter?.startMs === periodStartMs;
  const heldSample = resolveHeldPowerSample(powerTracker, nowMs);
  // A missing Flow event is a no-op: the last admitted reading remains the
  // held sample until the next event (or the meter-silence gate closes plan
  // building). Include that interval in both usage and coverage so a
  // settings-triggered rebuild cannot make the gap look like free capacity.
  // At a period rollover the stored quarter still names the previous period
  // until another sample arrives. The held sample nevertheless covers the new
  // period from its boundary, so do not require `quarterMatches` here.
  const heldMs = heldSample
    ? Math.max(0, nowMs - Math.max(periodStartMs, heldSample.atMs))
    : 0;
  const usedKWh = periodMinutes === 15
    ? Math.max(0, (quarterMatches ? quarter.energyKWh : 0)
      + (Math.max(0, heldSample?.powerW ?? 0) / 1000) * (heldMs / 3_600_000))
    : Math.max(0, powerTracker.buckets?.[bucketKey] || 0);
  const coverageComplete = periodMinutes === 60 || (
    (quarterMatches || heldSample !== undefined)
    && (quarterMatches ? quarter.trackedMs : 0) + heldMs >= nowMs - periodStartMs
  );
  const remainingMs = Math.max(0, periodEndMs - nowMs);
  return {
    bucketKey,
    periodStartMs,
    periodEndMs,
    usedKWh,
    remainingMs,
    remainingHours: remainingMs / 3600000,
    minutesRemaining: remainingMs / 60000,
    coverageComplete,
  };
}

export function getCurrentHourContext(
  powerTracker: PowerTrackerState,
  nowMs: number = Date.now(),
): HourUsageContext {
  const period = getCurrentCapacityPeriodContext(powerTracker, 60, nowMs);
  const bucketKey = getHourBucketKey(nowMs);
  return {
    bucketKey,
    hourStartMs: period.periodStartMs,
    hourEndMs: period.periodEndMs,
    usedKWh: period.usedKWh,
    remainingMs: period.remainingMs,
    remainingHours: period.remainingHours,
    minutesRemaining: period.minutesRemaining,
  };
}
