import type { PowerTrackerState } from '../core/powerTracker';
import { getZonedParts } from '../utils/dateUtils';
import { OBSERVED_HOURLY_PEAK_WINDOW_DAYS } from './dailyBudgetConstants';
import type { DailyBudgetState } from './dailyBudgetTypes';

const updateHourMax = (values: number[], hour: number, candidate: number): number[] => (
  values.map((value, index) => (index === hour ? Math.max(value, candidate) : value))
);

const updateHourMin = (values: number[], hour: number, candidate: number): number[] => {
  if (candidate <= 0) return values;
  return values.map((value, index) => {
    if (index !== hour) return value;
    if (value <= 0) return candidate;
    return Math.min(value, candidate);
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
    observedMinUncontrolled: Array.from({ length: 24 }, () => 0),
    observedMinControlled: Array.from({ length: 24 }, () => 0),
    windowBucketCount: 0,
  });

  return { ...stats };
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
