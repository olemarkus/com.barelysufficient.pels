import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes';
import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import { clamp } from '../utils/math';

export type DayContext = {
  nowMs: number;
  timeZone: string;
  dateKey: string;
  dayStartUtcMs: number;
  bucketStartUtcMs: number[];
  bucketStartLocalLabels: string[];
  bucketKeys: string[];
  currentBucketIndex: number;
  currentBucketProgress: number;
  bucketUsage: number[];
  bucketUsageControlled?: Array<number | null>;
  bucketUsageUncontrolled?: Array<number | null>;
  usedNowKWh: number;
  currentBucketUsage: number;
};

const resolveCurrentBucketIndex = (dayStartUtcMs: number, bucketCount: number, nowMs: number): number => {
  if (bucketCount <= 0) return 0;
  const diff = nowMs - dayStartUtcMs;
  const index = Math.floor(diff / (60 * 60 * 1000));
  return clamp(index, 0, bucketCount - 1);
};

const sumArray = (values: number[]): number => values.reduce((sum, value) => sum + value, 0);

const buildBucketUsage = (params: {
  bucketStartUtcMs: number[];
  powerTracker: PowerTrackerState;
}): {
  bucketKeys: string[];
  bucketUsage: number[];
  bucketUsageControlled?: Array<number | null>;
  bucketUsageUncontrolled?: Array<number | null>;
} => {
  const { bucketStartUtcMs, powerTracker } = params;
  const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
  const bucketUsage = bucketKeys.map((key) => powerTracker.buckets?.[key] ?? 0);
  const controlledRaw = powerTracker.controlledBuckets ?? {};
  const uncontrolledRaw = powerTracker.uncontrolledBuckets ?? {};
  const splitUsage = bucketKeys.map((key, index) => {
    const total = Math.max(0, bucketUsage[index] ?? 0);
    const rawControlled = controlledRaw[key];
    const rawUncontrolled = uncontrolledRaw[key];
    const hasControlled = typeof rawControlled === 'number' && Number.isFinite(rawControlled);
    const hasUncontrolled = typeof rawUncontrolled === 'number' && Number.isFinite(rawUncontrolled);

    if (!hasControlled && !hasUncontrolled) {
      return { controlled: null, uncontrolled: null };
    }

    if (hasControlled) {
      const controlled = clamp(rawControlled as number, 0, total);
      return {
        controlled,
        uncontrolled: Math.max(0, total - controlled),
      };
    }

    const uncontrolled = clamp(rawUncontrolled as number, 0, total);
    return {
      controlled: Math.max(0, total - uncontrolled),
      uncontrolled,
    };
  });

  const bucketUsageControlled = splitUsage.map((entry) => entry.controlled);
  const bucketUsageUncontrolled = splitUsage.map((entry) => entry.uncontrolled);
  const hasSplit = bucketUsageControlled.some((value) => typeof value === 'number')
    || bucketUsageUncontrolled.some((value) => typeof value === 'number');

  return {
    bucketKeys,
    bucketUsage,
    bucketUsageControlled: hasSplit ? bucketUsageControlled : undefined,
    bucketUsageUncontrolled: hasSplit ? bucketUsageUncontrolled : undefined,
  };
};

const resolveBucketProgress = (params: {
  nowMs: number;
  bucketStartUtcMs: number[];
  currentBucketIndex: number;
  nextDayStartUtcMs: number;
}): number => {
  const { nowMs, bucketStartUtcMs, currentBucketIndex, nextDayStartUtcMs } = params;
  const bucketStart = bucketStartUtcMs[currentBucketIndex];
  const bucketEnd = bucketStartUtcMs[currentBucketIndex + 1] ?? nextDayStartUtcMs;
  const duration = Math.max(1, bucketEnd - bucketStart);
  return clamp((nowMs - bucketStart) / duration, 0, 1);
};

export const buildDayContext = (params: {
  nowMs: number;
  timeZone: string;
  powerTracker: PowerTrackerState;
}): DayContext => {
  const { nowMs, timeZone, powerTracker } = params;
  const dateKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const dayStartUtcMs = getDateKeyStartMs(dateKey, timeZone);
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs, bucketStartLocalLabels } = buildLocalDayBuckets({
    dayStartUtcMs,
    nextDayStartUtcMs,
    timeZone,
  });
  const {
    bucketKeys,
    bucketUsage,
    bucketUsageControlled,
    bucketUsageUncontrolled,
  } = buildBucketUsage({ bucketStartUtcMs, powerTracker });
  const currentBucketIndex = resolveCurrentBucketIndex(dayStartUtcMs, bucketStartUtcMs.length, nowMs);
  const currentBucketProgress = resolveBucketProgress({
    nowMs,
    bucketStartUtcMs,
    currentBucketIndex,
    nextDayStartUtcMs,
  });
  const usedNowKWh = sumArray(bucketUsage);
  const currentBucketUsage = bucketUsage[currentBucketIndex] ?? 0;

  return {
    nowMs,
    timeZone,
    dateKey,
    dayStartUtcMs,
    bucketStartUtcMs,
    bucketStartLocalLabels,
    bucketKeys,
    currentBucketIndex,
    currentBucketProgress,
    bucketUsage,
    bucketUsageControlled,
    bucketUsageUncontrolled,
    usedNowKWh,
    currentBucketUsage,
  };
};
