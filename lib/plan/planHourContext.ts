import type { PowerTrackerState } from '../power/tracker';
import { MAX_POWER_SAMPLE_GAP_MS } from '../power/trackerTypes';
import { getHourBucketKey } from '../utils/dateUtils';
import { CAPACITY_QUARTER_MS } from '../../packages/shared-domain/src/settings/capacityPeriod';
import type { CapacityPeriodMinutes } from '../../packages/contracts/src/capacitySettings';

const HOUR_MS = 60 * 60 * 1000;

export type CapacityPeriodUsageContext = {
  usedKWh: number;
  remainingHours: number;
  minutesRemaining: number;
  /** Whether usedKWh covers the whole elapsed part of this capacity period. */
  coverageComplete: boolean;
};

export type HourUsageContext = CapacityPeriodUsageContext & { bucketKey: string };

type HeldPowerSample = { atMs: number; powerW: number };

const resolveRemaining = (
  periodEndMs: number,
  nowMs: number,
): Pick<CapacityPeriodUsageContext, 'remainingHours' | 'minutesRemaining'> => {
  const remainingMs = Math.max(0, periodEndMs - nowMs);
  return { remainingHours: remainingMs / HOUR_MS, minutesRemaining: remainingMs / 60_000 };
};

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

/**
 * The clock hour, read from the hourly energy buckets. Hourly accounting is
 * continuous by construction, so its coverage is always complete.
 */
export function getCurrentHourContext(
  powerTracker: PowerTrackerState,
  nowMs: number,
): HourUsageContext {
  const bucketKey = getHourBucketKey(nowMs);
  const hourStartMs = new Date(bucketKey).getTime();
  return {
    bucketKey,
    // Floor at 0: a persisted solar-export hour can hold a negative kWh, which would
    // otherwise inflate remaining-budget / burst-rate pacing. Billed usage can't be negative.
    usedKWh: Math.max(0, powerTracker.buckets?.[bucketKey] || 0),
    ...resolveRemaining(hourStartMs + HOUR_MS, nowMs),
    coverageComplete: true,
  };
}

/**
 * The aligned tariff quarter, read from the tracker's active quarter plus the
 * held sample since it was last accrued.
 */
function getCurrentQuarterContext(
  powerTracker: PowerTrackerState,
  nowMs: number,
): CapacityPeriodUsageContext {
  const quarterStartMs = Math.floor(nowMs / CAPACITY_QUARTER_MS) * CAPACITY_QUARTER_MS;
  const stored = powerTracker.capacityQuarter;
  const quarter = stored?.startMs === quarterStartMs ? stored : undefined;
  const heldSample = resolveHeldPowerSample(powerTracker, nowMs);
  // A missing Flow event is a no-op: the last admitted reading remains the
  // held sample until the next event (or the meter-silence gate closes plan
  // building). Include that interval in both usage and coverage so a
  // settings-triggered rebuild cannot make the gap look like free capacity.
  // At a quarter rollover the stored quarter still names the previous quarter
  // until another sample arrives. The held sample nevertheless covers the new
  // quarter from its boundary, so it counts without a matching stored quarter.
  const heldMs = heldSample === undefined
    ? 0
    : Math.max(0, nowMs - Math.max(quarterStartMs, heldSample.atMs));
  const heldKWh = heldSample === undefined
    ? 0
    : (Math.max(0, heldSample.powerW) / 1000) * (heldMs / HOUR_MS);
  const hasEvidence = quarter !== undefined || heldSample !== undefined;
  return {
    usedKWh: (quarter?.energyKWh ?? 0) + heldKWh,
    ...resolveRemaining(quarterStartMs + CAPACITY_QUARTER_MS, nowMs),
    coverageComplete: hasEvidence && (quarter?.trackedMs ?? 0) + heldMs >= nowMs - quarterStartMs,
  };
}

export function getCurrentCapacityPeriodContext(
  powerTracker: PowerTrackerState,
  periodMinutes: CapacityPeriodMinutes,
  nowMs: number,
): CapacityPeriodUsageContext {
  return periodMinutes === 15
    ? getCurrentQuarterContext(powerTracker, nowMs)
    : getCurrentHourContext(powerTracker, nowMs);
}
