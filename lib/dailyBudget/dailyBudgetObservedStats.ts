import type { PowerTrackerState } from '../power/tracker';
import {
  OBSERVED_HOURLY_MAX_QUANTILE,
  OBSERVED_HOURLY_MIN_QUANTILE,
  OBSERVED_HOURLY_PEAK_WINDOW_DAYS,
  OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES,
  UNCONTROLLED_RESERVE_BASE_QUANTILE,
  UNCONTROLLED_RESERVE_MAX_QUANTILE,
} from './dailyBudgetConstants';
import type { DailyBudgetState } from './dailyBudgetTypes';
import { resolveWindowBucketUsage } from './dailyBudgetObservedBucketUsage';

export const getObservedStatsConfigKey = (): string => (
  [
    OBSERVED_HOURLY_PEAK_WINDOW_DAYS,
    OBSERVED_HOURLY_MAX_QUANTILE,
    OBSERVED_HOURLY_MIN_QUANTILE,
    UNCONTROLLED_RESERVE_BASE_QUANTILE,
    UNCONTROLLED_RESERVE_MAX_QUANTILE,
    OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES,
  ].join(':')
);

const createHourlyBuckets = (): number[][] => (
  Array.from({ length: 24 }, () => [])
);

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const percentileLinear = (values: number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return percentileLinearSorted(sorted, quantile);
};

const percentileLinearSorted = (sorted: number[], quantile: number): number => {
  if (sorted.length === 0) return 0;
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
    let maxValue = 0;
    for (const value of values) {
      maxValue = Math.max(maxValue, value);
    }
    return maxValue;
  }
  return percentileLinear(values, OBSERVED_HOURLY_MAX_QUANTILE);
};

const resolveObservedMin = (values: number[]): number => {
  const positiveValues = values.filter((value) => value > 0);
  if (positiveValues.length === 0) return 0;
  if (positiveValues.length < OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES) {
    let minValue = positiveValues[0] ?? 0;
    for (const value of positiveValues) {
      minValue = Math.min(minValue, value);
    }
    return minValue;
  }
  return percentileLinear(positiveValues, OBSERVED_HOURLY_MIN_QUANTILE);
};

const resolveUncontrolledReserveStats = (
  values: number[],
): { p50: number; p75: number; p90: number; sampleCount: number } => {
  const positiveValues = values
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  if (positiveValues.length === 0) {
    return {
      p50: 0,
      p75: 0,
      p90: 0,
      sampleCount: 0,
    };
  }
  return {
    p50: percentileLinearSorted(positiveValues, UNCONTROLLED_RESERVE_BASE_QUANTILE),
    p75: percentileLinearSorted(positiveValues, UNCONTROLLED_RESERVE_MAX_QUANTILE),
    p90: percentileLinearSorted(positiveValues, OBSERVED_HOURLY_MAX_QUANTILE),
    sampleCount: positiveValues.length,
  };
};

const clampMinByMax = (mins: number[], maxes: number[]): number[] => (
  mins.map((minValue, hour) => {
    if (minValue <= 0) return 0;
    const maxValue = maxes[hour] ?? 0;
    if (maxValue > 0 && minValue > maxValue) return maxValue;
    return minValue;
  })
);

const resolveHourlyReserveStats = (
  hourlyBuckets: number[][],
): {
  observedP50: number[];
  observedP75: number[];
  observedP90: number[];
  observedSampleCounts: number[];
} => {
  const stats = hourlyBuckets.map((values) => resolveUncontrolledReserveStats(values));
  return {
    observedP50: stats.map((entry) => entry.p50),
    observedP75: stats.map((entry) => entry.p75),
    observedP90: stats.map((entry) => entry.p90),
    observedSampleCounts: stats.map((entry) => entry.sampleCount),
  };
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
  observedP50Uncontrolled: number[];
  observedP75Uncontrolled: number[];
  observedP90Uncontrolled: number[];
  observedUncontrolledSampleCounts: number[];
  observedP50GrossUncontrolled: number[];
  observedP75GrossUncontrolled: number[];
  observedP90GrossUncontrolled: number[];
  observedGrossUncontrolledSampleCounts: number[];
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
  const exemptBuckets = powerTracker.exemptBuckets || {};
  const hourlyUncontrolled = createHourlyBuckets();
  const hourlyControlled = createHourlyBuckets();
  const hourlyGrossUncontrolled = createHourlyBuckets();
  let windowBucketCount = 0;
  for (const [key, totalRaw] of Object.entries(totalBuckets)) {
    const usage = resolveWindowBucketUsage({
      key,
      totalRaw,
      controlledBuckets,
      uncontrolledBuckets,
      exemptBuckets,
      timeZone,
      windowStartUtcMs,
      windowEndUtcMs,
    });
    if (!usage) continue;
    hourlyUncontrolled[usage.hour].push(usage.uncontrolled);
    hourlyControlled[usage.hour].push(usage.controlled);
    hourlyGrossUncontrolled[usage.hour].push(usage.grossUncontrolled);
    windowBucketCount += 1;
  }

  const observedMaxUncontrolled = hourlyUncontrolled.map((values) => resolveObservedMax(values));
  const observedMaxControlled = hourlyControlled.map((values) => resolveObservedMax(values));
  const observedMinUncontrolled = clampMinByMax(
    hourlyUncontrolled.map((values) => resolveObservedMin(values)),
    observedMaxUncontrolled,
  );
  const observedMinControlled = clampMinByMax(
    hourlyControlled.map((values) => resolveObservedMin(values)),
    observedMaxControlled,
  );
  const netReserveStats = resolveHourlyReserveStats(hourlyUncontrolled);
  const grossReserveStats = resolveHourlyReserveStats(hourlyGrossUncontrolled);

  return {
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
    observedP50Uncontrolled: netReserveStats.observedP50,
    observedP75Uncontrolled: netReserveStats.observedP75,
    observedP90Uncontrolled: netReserveStats.observedP90,
    observedUncontrolledSampleCounts: netReserveStats.observedSampleCounts,
    observedP50GrossUncontrolled: grossReserveStats.observedP50,
    observedP75GrossUncontrolled: grossReserveStats.observedP75,
    observedP90GrossUncontrolled: grossReserveStats.observedP90,
    observedGrossUncontrolledSampleCounts: grossReserveStats.observedSampleCounts,
    windowBucketCount,
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

const selectObservedSeries = (
  shouldUseNext: boolean,
  next: number[],
  current: number[] | undefined,
): number[] | undefined => (shouldUseNext ? next : current);

const applyObservedUpdate = (params: {
  state: DailyBudgetState;
  needsMax: boolean;
  needsMin: boolean;
  needsNetReserve: boolean;
  needsGrossReserve: boolean;
  needsConfig: boolean;
  observedMaxUncontrolled: number[];
  observedMaxControlled: number[];
  observedMinUncontrolled: number[];
  observedMinControlled: number[];
  observedP50Uncontrolled: number[];
  observedP75Uncontrolled: number[];
  observedP90Uncontrolled: number[];
  observedUncontrolledSampleCounts: number[];
  observedP50GrossUncontrolled: number[];
  observedP75GrossUncontrolled: number[];
  observedP90GrossUncontrolled: number[];
  observedGrossUncontrolledSampleCounts: number[];
  observedConfigKey: string;
}): { nextState: DailyBudgetState; changed: boolean } => {
  const {
    state,
    needsMax,
    needsMin,
    needsNetReserve,
    needsGrossReserve,
    needsConfig,
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
    observedP50Uncontrolled,
    observedP75Uncontrolled,
    observedP90Uncontrolled,
    observedUncontrolledSampleCounts,
    observedP50GrossUncontrolled,
    observedP75GrossUncontrolled,
    observedP90GrossUncontrolled,
    observedGrossUncontrolledSampleCounts,
    observedConfigKey,
  } = params;
  const nextState: DailyBudgetState = {
    ...state,
    profileObservedMaxUncontrolledKWh: selectObservedSeries(
      needsMax,
      observedMaxUncontrolled,
      state.profileObservedMaxUncontrolledKWh,
    ),
    profileObservedMaxControlledKWh: selectObservedSeries(
      needsMax,
      observedMaxControlled,
      state.profileObservedMaxControlledKWh,
    ),
    profileObservedMinUncontrolledKWh: selectObservedSeries(
      needsMin,
      observedMinUncontrolled,
      state.profileObservedMinUncontrolledKWh,
    ),
    profileObservedMinControlledKWh: selectObservedSeries(
      needsMin,
      observedMinControlled,
      state.profileObservedMinControlledKWh,
    ),
    profileObservedP50UncontrolledKWh: selectObservedSeries(
      needsNetReserve,
      observedP50Uncontrolled,
      state.profileObservedP50UncontrolledKWh,
    ),
    profileObservedP75UncontrolledKWh: selectObservedSeries(
      needsNetReserve,
      observedP75Uncontrolled,
      state.profileObservedP75UncontrolledKWh,
    ),
    profileObservedP90UncontrolledKWh: selectObservedSeries(
      needsNetReserve,
      observedP90Uncontrolled,
      state.profileObservedP90UncontrolledKWh,
    ),
    profileObservedUncontrolledSampleCounts: selectObservedSeries(
      needsNetReserve,
      observedUncontrolledSampleCounts,
      state.profileObservedUncontrolledSampleCounts,
    ),
    profileObservedP50GrossUncontrolledKWh: selectObservedSeries(
      needsGrossReserve,
      observedP50GrossUncontrolled,
      state.profileObservedP50GrossUncontrolledKWh,
    ),
    profileObservedP75GrossUncontrolledKWh: selectObservedSeries(
      needsGrossReserve,
      observedP75GrossUncontrolled,
      state.profileObservedP75GrossUncontrolledKWh,
    ),
    profileObservedP90GrossUncontrolledKWh: selectObservedSeries(
      needsGrossReserve,
      observedP90GrossUncontrolled,
      state.profileObservedP90GrossUncontrolledKWh,
    ),
    profileObservedGrossUncontrolledSampleCounts: selectObservedSeries(
      needsGrossReserve,
      observedGrossUncontrolledSampleCounts,
      state.profileObservedGrossUncontrolledSampleCounts,
    ),
    profileObservedStatsConfigKey: needsConfig
      ? observedConfigKey
      : state.profileObservedStatsConfigKey,
  };
  const maxChanged = needsMax && hasObservedMaxChanged(state, nextState);
  const minChanged = needsMin && hasObservedMinChanged(state, nextState);
  const reserveChanged = (needsNetReserve || needsGrossReserve)
    && hasObservedReserveChanged(state, nextState);
  const configChanged = needsConfig
    && state.profileObservedStatsConfigKey !== nextState.profileObservedStatsConfigKey;
  return { nextState, changed: maxChanged || minChanged || reserveChanged || configChanged };
};

const resolveObservedUpdateNeeds = (params: {
  hasMax: boolean;
  hasMin: boolean;
  hasNetReserve: boolean;
  hasGrossReserve: boolean;
  needsRefreshRequested: boolean;
  windowBucketCount: number;
}): {
  needsMax: boolean;
  needsMin: boolean;
  needsNetReserve: boolean;
  needsGrossReserve: boolean;
  needsConfig: boolean;
  needsRefresh: boolean;
} => {
  const {
    hasMax,
    hasMin,
    hasNetReserve,
    hasGrossReserve,
    needsRefreshRequested,
    windowBucketCount,
  } = params;
  const hasWindowData = windowBucketCount > 0;
  const needsRefresh = needsRefreshRequested && hasWindowData;
  return {
    needsMax: (!hasMax && hasWindowData) || needsRefresh,
    needsMin: (!hasMin && hasWindowData) || needsRefresh,
    needsNetReserve: (!hasNetReserve && hasWindowData) || needsRefresh,
    needsGrossReserve: (!hasGrossReserve && hasWindowData) || needsRefresh,
    needsConfig: needsRefreshRequested && hasWindowData,
    needsRefresh,
  };
};

function hasObservedMaxChanged(previous: DailyBudgetState, next: DailyBudgetState): boolean {
  return [
    [previous.profileObservedMaxUncontrolledKWh, next.profileObservedMaxUncontrolledKWh],
    [previous.profileObservedMaxControlledKWh, next.profileObservedMaxControlledKWh],
  ].some(([left, right]) => !areEqualNumberArrays(left, right));
}

function hasObservedReserveChanged(previous: DailyBudgetState, next: DailyBudgetState): boolean {
  return [
    [previous.profileObservedP50UncontrolledKWh, next.profileObservedP50UncontrolledKWh],
    [previous.profileObservedP75UncontrolledKWh, next.profileObservedP75UncontrolledKWh],
    [previous.profileObservedP90UncontrolledKWh, next.profileObservedP90UncontrolledKWh],
    [previous.profileObservedUncontrolledSampleCounts, next.profileObservedUncontrolledSampleCounts],
    [previous.profileObservedP50GrossUncontrolledKWh, next.profileObservedP50GrossUncontrolledKWh],
    [previous.profileObservedP75GrossUncontrolledKWh, next.profileObservedP75GrossUncontrolledKWh],
    [previous.profileObservedP90GrossUncontrolledKWh, next.profileObservedP90GrossUncontrolledKWh],
    [previous.profileObservedGrossUncontrolledSampleCounts, next.profileObservedGrossUncontrolledSampleCounts],
  ].some(([left, right]) => !areEqualNumberArrays(left, right));
}

function hasObservedMinChanged(previous: DailyBudgetState, next: DailyBudgetState): boolean {
  return [
    [previous.profileObservedMinUncontrolledKWh, next.profileObservedMinUncontrolledKWh],
    [previous.profileObservedMinControlledKWh, next.profileObservedMinControlledKWh],
  ].some(([left, right]) => !areEqualNumberArrays(left, right));
}

export function ensureObservedHourlyStats(params: {
  state: DailyBudgetState;
  powerTracker: PowerTrackerState;
  timeZone: string;
  nowMs: number;
}): { nextState: DailyBudgetState; changed: boolean; logEvent?: Record<string, unknown> } {
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
  const hasNetReserve = hasAnyPositive(state.profileObservedP50UncontrolledKWh)
    || hasAnyPositive(state.profileObservedP75UncontrolledKWh);
  const hasGrossReserve = hasAnyPositive(state.profileObservedP50GrossUncontrolledKWh)
    || hasAnyPositive(state.profileObservedP75GrossUncontrolledKWh);
  const observedConfigKey = getObservedStatsConfigKey();
  const hasMatchingConfig = state.profileObservedStatsConfigKey === observedConfigKey;
  const needsBackfill = !hasMax || !hasMin || !hasNetReserve || !hasGrossReserve;

  if (!needsBackfill && hasMatchingConfig) {
    return { nextState: state, changed: false };
  }

  const needsRefreshRequested = !hasMatchingConfig;

  const hourMs = 60 * 60 * 1000;
  const windowEndUtcMs = Math.floor(nowMs / hourMs) * hourMs;
  const windowStartUtcMs = windowEndUtcMs - OBSERVED_HOURLY_PEAK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const {
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
    observedP50Uncontrolled,
    observedP75Uncontrolled,
    observedP90Uncontrolled,
    observedUncontrolledSampleCounts,
    observedP50GrossUncontrolled,
    observedP75GrossUncontrolled,
    observedP90GrossUncontrolled,
    observedGrossUncontrolledSampleCounts,
    windowBucketCount,
  } = buildObservedHourlyStatsFromWindow({
    powerTracker,
    timeZone,
    windowStartUtcMs,
    windowEndUtcMs,
  });

  const {
    needsMax,
    needsMin,
    needsNetReserve,
    needsGrossReserve,
    needsConfig,
    needsRefresh,
  } = resolveObservedUpdateNeeds({
    hasMax,
    hasMin,
    hasNetReserve,
    hasGrossReserve,
    needsRefreshRequested,
    windowBucketCount,
  });

  const update = applyObservedUpdate({
    state,
    needsMax,
    needsMin,
    needsNetReserve,
    needsGrossReserve,
    needsConfig,
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
    observedP50Uncontrolled,
    observedP75Uncontrolled,
    observedP90Uncontrolled,
    observedUncontrolledSampleCounts,
    observedP50GrossUncontrolled,
    observedP75GrossUncontrolled,
    observedP90GrossUncontrolled,
    observedGrossUncontrolledSampleCounts,
    observedConfigKey,
  });
  if (!update.changed) return { nextState: state, changed: false };

  const actionLabel = needsRefresh ? 'refreshed' : 'backfilled';
  return {
    nextState: update.nextState,
    changed: update.changed,
    logEvent: update.changed
      ? { event: 'daily_budget_observed_stats_updated', action: actionLabel, windowBucketCount }
      : undefined,
  };
}
