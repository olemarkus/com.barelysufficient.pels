import type { PowerTrackerState } from '../core/powerTracker';
import { getZonedParts } from '../utils/dateUtils';
import { OBSERVED_HOURLY_PEAK_WINDOW_DAYS } from './dailyBudgetConstants';
import type { DailyBudgetState } from './dailyBudgetTypes';

const updateHourMax = (values: number[], hour: number, candidate: number): number[] => (
  values.map((value, index) => (index === hour ? Math.max(value, candidate) : value))
);

const updateHourMin = (values: number[], hour: number, candidate: number): number[] => {
  const nextCandidate = candidate > 0 ? candidate : Number.POSITIVE_INFINITY;
  return values.map((value, index) => {
    if (index !== hour) return value;
    return Math.min(value, nextCandidate);
  });
};

export const buildObservedHourlyStatsFromWindow = (params: {
  powerTracker: PowerTrackerState;
  timeZone: string;
  windowStartUtcMs: number;
  windowEndUtcMs: number;
}): {
  observedMaxUncontrolled: number[];
  observedMaxControlled: number[];
  observedMinUncontrolled: number[];
  observedMinControlled: number[];
  windowBucketCount: number;
} => {
  const {
    powerTracker,
    timeZone,
    windowStartUtcMs,
    windowEndUtcMs,
  } = params;
  const totalBuckets = powerTracker.buckets || {};
  const controlledBuckets = powerTracker.controlledBuckets || {};
  const uncontrolledBuckets = powerTracker.uncontrolledBuckets || {};

  const stats = Object.entries(totalBuckets).reduce((acc, [key, totalRaw]) => {
    const ts = new Date(key).getTime();
    if (!Number.isFinite(ts) || ts < windowStartUtcMs || ts >= windowEndUtcMs) return acc;
    if (typeof totalRaw !== 'number' || !Number.isFinite(totalRaw)) return acc;
    const total = Math.max(0, totalRaw);
    if (total <= 0) return acc;

    const controlledRaw = controlledBuckets[key];
    const uncontrolledRaw = uncontrolledBuckets[key];
    let controlled = 0;
    let uncontrolled = total;

    if (typeof controlledRaw === 'number' && Number.isFinite(controlledRaw)) {
      controlled = Math.max(0, Math.min(controlledRaw, total));
      uncontrolled = Math.max(0, total - controlled);
    } else if (typeof uncontrolledRaw === 'number' && Number.isFinite(uncontrolledRaw)) {
      uncontrolled = Math.max(0, Math.min(uncontrolledRaw, total));
      controlled = Math.max(0, total - uncontrolled);
    }

    const hour = getZonedParts(new Date(ts), timeZone).hour;
    return {
      observedMaxUncontrolled: updateHourMax(acc.observedMaxUncontrolled, hour, uncontrolled),
      observedMaxControlled: updateHourMax(acc.observedMaxControlled, hour, controlled),
      observedMinUncontrolled: updateHourMin(acc.observedMinUncontrolled, hour, uncontrolled),
      observedMinControlled: updateHourMin(acc.observedMinControlled, hour, controlled),
      windowBucketCount: acc.windowBucketCount + 1,
    };
  }, {
    observedMaxUncontrolled: Array.from({ length: 24 }, () => 0),
    observedMaxControlled: Array.from({ length: 24 }, () => 0),
    observedMinUncontrolled: Array.from({ length: 24 }, () => Number.POSITIVE_INFINITY),
    observedMinControlled: Array.from({ length: 24 }, () => Number.POSITIVE_INFINITY),
    windowBucketCount: 0,
  });

  return {
    ...stats,
    observedMinUncontrolled: stats.observedMinUncontrolled.map((value) => (Number.isFinite(value) ? value : 0)),
    observedMinControlled: stats.observedMinControlled.map((value) => (Number.isFinite(value) ? value : 0)),
  };
};

const hasAnyPositive = (values?: number[]): boolean => (
  Array.isArray(values) && values.some((value) => typeof value === 'number' && value > 0)
);

export function ensureObservedHourlyStats(params: {
  state: DailyBudgetState;
  powerTracker: PowerTrackerState;
  timeZone: string;
  nowMs: number;
}): { nextState: DailyBudgetState; changed: boolean; logMessage?: string } {
  const {
    state,
    powerTracker,
    timeZone,
    nowMs,
  } = params;
  const hasMax = hasAnyPositive(state.profileObservedMaxUncontrolledKWh)
    || hasAnyPositive(state.profileObservedMaxControlledKWh);
  const hasMin = hasAnyPositive(state.profileObservedMinUncontrolledKWh)
    || hasAnyPositive(state.profileObservedMinControlledKWh);
  if (hasMax && hasMin) {
    return { nextState: state, changed: false };
  }

  const needsMax = !hasMax;
  const needsMin = !hasMin;

  const windowEndUtcMs = nowMs;
  const windowStartUtcMs = windowEndUtcMs - OBSERVED_HOURLY_PEAK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const {
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
    windowBucketCount,
  } = buildObservedHourlyStatsFromWindow({
    powerTracker,
    timeZone,
    windowStartUtcMs,
    windowEndUtcMs,
  });

  return {
    nextState: {
      ...state,
      profileObservedMaxUncontrolledKWh: needsMax
        ? observedMaxUncontrolled
        : state.profileObservedMaxUncontrolledKWh,
      profileObservedMaxControlledKWh: needsMax
        ? observedMaxControlled
        : state.profileObservedMaxControlledKWh,
      profileObservedMinUncontrolledKWh: needsMin
        ? observedMinUncontrolled
        : state.profileObservedMinUncontrolledKWh,
      profileObservedMinControlledKWh: needsMin
        ? observedMinControlled
        : state.profileObservedMinControlledKWh,
    },
    changed: true,
    logMessage: `Daily budget: backfilled observed stats (window buckets ${windowBucketCount})`,
  };
}
