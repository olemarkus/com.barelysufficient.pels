import type { PowerTrackerState } from '../core/powerTracker';
import { getZonedParts } from '../utils/dateUtils';
import {
  OBSERVED_HOURLY_MAX_QUANTILE,
  OBSERVED_HOURLY_MIN_QUANTILE,
  OBSERVED_HOURLY_PEAK_WINDOW_DAYS,
  OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES,
} from './dailyBudgetConstants';
import type { DailyBudgetState } from './dailyBudgetTypes';

const createHourlyBuckets = (): number[][] => (
  Array.from({ length: 24 }, () => [])
);

const appendHourlyValue = (
  hourlyValues: number[][],
  hour: number,
  value: number,
): number[][] => (
  hourlyValues.map((entries, index) => (index === hour ? [...entries, value] : entries))
);

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const percentileLinear = (values: number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const q = clamp01(quantile);
  const index = (sorted.length - 1) * q;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  if (lowerIndex === upperIndex) return lower;
  const ratio = index - lowerIndex;
  return lower + (upper - lower) * ratio;
};

const resolveObservedMax = (values: number[]): number => {
  if (values.length === 0) return 0;
  if (values.length < OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES) {
    return values.reduce((max, value) => Math.max(max, value), 0);
  }
  return percentileLinear(values, OBSERVED_HOURLY_MAX_QUANTILE);
};

const resolveObservedMin = (values: number[]): number => {
  const positiveValues = values.filter((value) => value > 0);
  if (positiveValues.length === 0) return 0;
  if (positiveValues.length < OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES) {
    return positiveValues.reduce((min, value) => Math.min(min, value), positiveValues[0] ?? 0);
  }
  return percentileLinear(positiveValues, OBSERVED_HOURLY_MIN_QUANTILE);
};

const clampMinByMax = (mins: number[], maxes: number[]): number[] => (
  mins.map((minValue, hour) => {
    if (minValue <= 0) return 0;
    const maxValue = maxes[hour] ?? 0;
    if (maxValue > 0 && minValue > maxValue) return maxValue;
    return minValue;
  })
);

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
      hourlyUncontrolled: appendHourlyValue(acc.hourlyUncontrolled, hour, uncontrolled),
      hourlyControlled: appendHourlyValue(acc.hourlyControlled, hour, controlled),
      windowBucketCount: acc.windowBucketCount + 1,
    };
  }, {
    hourlyUncontrolled: createHourlyBuckets(),
    hourlyControlled: createHourlyBuckets(),
    windowBucketCount: 0,
  });

  const observedMaxUncontrolled = stats.hourlyUncontrolled.map((values) => resolveObservedMax(values));
  const observedMaxControlled = stats.hourlyControlled.map((values) => resolveObservedMax(values));
  const observedMinUncontrolled = clampMinByMax(
    stats.hourlyUncontrolled.map((values) => resolveObservedMin(values)),
    observedMaxUncontrolled,
  );
  const observedMinControlled = clampMinByMax(
    stats.hourlyControlled.map((values) => resolveObservedMin(values)),
    observedMaxControlled,
  );

  return {
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
    windowBucketCount: stats.windowBucketCount,
  };
};

const hasAnyPositive = (values?: number[]): boolean => (
  Array.isArray(values) && values.some((value) => typeof value === 'number' && value > 0)
);

const areEqualNumberArrays = (left?: number[], right?: number[]): boolean => {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};

const applyObservedUpdate = (params: {
  state: DailyBudgetState;
  needsMax: boolean;
  needsMin: boolean;
  observedMaxUncontrolled: number[];
  observedMaxControlled: number[];
  observedMinUncontrolled: number[];
  observedMinControlled: number[];
}): { nextState: DailyBudgetState; changed: boolean } => {
  const {
    state,
    needsMax,
    needsMin,
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
  } = params;
  const nextState: DailyBudgetState = {
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
  };
  const maxChanged = needsMax && (
    !areEqualNumberArrays(state.profileObservedMaxUncontrolledKWh, nextState.profileObservedMaxUncontrolledKWh)
    || !areEqualNumberArrays(state.profileObservedMaxControlledKWh, nextState.profileObservedMaxControlledKWh)
  );
  const minChanged = needsMin && (
    !areEqualNumberArrays(state.profileObservedMinUncontrolledKWh, nextState.profileObservedMinUncontrolledKWh)
    || !areEqualNumberArrays(state.profileObservedMinControlledKWh, nextState.profileObservedMinControlledKWh)
  );
  return { nextState, changed: maxChanged || minChanged };
};

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

  const hourMs = 60 * 60 * 1000;
  const windowEndUtcMs = Math.floor(nowMs / hourMs) * hourMs;
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

  const update = applyObservedUpdate({
    state,
    needsMax,
    needsMin,
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
  });
  if (!update.changed) return { nextState: state, changed: false };

  return {
    nextState: update.nextState,
    changed: update.changed,
    logMessage: update.changed
      ? `Daily budget: backfilled observed stats (window buckets ${windowBucketCount})`
      : undefined,
  };
}
