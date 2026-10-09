import type { PowerTrackerState } from '../power/tracker';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import {
  OBSERVED_HOURLY_MAX_QUANTILE,
  OBSERVED_HOURLY_MIN_QUANTILE,
  OBSERVED_HOURLY_PEAK_WINDOW_DAYS,
  OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES,
  UNCONTROLLED_RESERVE_BASE_QUANTILE,
  UNCONTROLLED_RESERVE_MAX_QUANTILE,
} from './dailyBudgetConstants';
import type { DailyBudgetState } from './dailyBudgetTypes';
import {
  OBSERVED_HOURLY_STATS_GROUPS,
  type ObservedHourlyStats,
  type ObservedSeriesField,
} from './observedHourlyStats';
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

/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
export const buildObservedHourlyStatsFromWindow = (params: {
  powerTracker: PowerTrackerState;
  timeZone: string;
  windowStartUtcMs: number;
  windowEndUtcMs: number;
}): { stats: ObservedHourlyStats; windowBucketCount: number } => {
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
    // `usage.hour` is 0-23 by construction, so all three slots exist; naming
    // them is what lets the compiler see it without a per-push default.
    const uncontrolledSamples = hourlyUncontrolled[usage.hour];
    const controlledSamples = hourlyControlled[usage.hour];
    const grossUncontrolledSamples = hourlyGrossUncontrolled[usage.hour];
    if (!uncontrolledSamples || !controlledSamples || !grossUncontrolledSamples) continue;
    uncontrolledSamples.push(usage.uncontrolled);
    controlledSamples.push(usage.controlled);
    grossUncontrolledSamples.push(usage.grossUncontrolled);
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
    stats: {
      profileObservedMaxUncontrolledKWh: observedMaxUncontrolled,
      profileObservedMaxControlledKWh: observedMaxControlled,
      profileObservedMinUncontrolledKWh: observedMinUncontrolled,
      profileObservedMinControlledKWh: observedMinControlled,
      profileObservedP50UncontrolledKWh: netReserveStats.observedP50,
      profileObservedP75UncontrolledKWh: netReserveStats.observedP75,
      profileObservedP90UncontrolledKWh: netReserveStats.observedP90,
      profileObservedUncontrolledSampleCounts: netReserveStats.observedSampleCounts,
      profileObservedP50GrossUncontrolledKWh: grossReserveStats.observedP50,
      profileObservedP75GrossUncontrolledKWh: grossReserveStats.observedP75,
      profileObservedP90GrossUncontrolledKWh: grossReserveStats.observedP90,
      profileObservedGrossUncontrolledSampleCounts: grossReserveStats.observedSampleCounts,
    },
    windowBucketCount,
  };
};
/* eslint-enable functional/immutable-data */

const hasAnyPositive = (values?: number[]): boolean => (
  Array.isArray(values) && values.some((value) => typeof value === 'number' && value > 0)
);

const areEqualNumberArrays = (left?: number[], right?: number[]): boolean => {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};

type ObservedUpdateNeeds = {
  needsMax: boolean;
  needsMin: boolean;
  needsNetReserve: boolean;
  needsGrossReserve: boolean;
  needsConfig: boolean;
  needsRefresh: boolean;
};

/** `fields` of `next` where the group is needed, else of `state`. */
const selectObservedSeries = (
  needed: boolean,
  fields: readonly ObservedSeriesField[],
  next: ObservedHourlyStats,
  state: DailyBudgetState,
): Partial<ObservedHourlyStats> => Object.fromEntries(
  fields.map((field) => [field, needed ? next[field] : state[field]]),
);

const hasObservedSeriesChanged = (
  previous: DailyBudgetState,
  next: DailyBudgetState,
  fields: readonly ObservedSeriesField[],
): boolean => fields.some((field) => !areEqualNumberArrays(previous[field], next[field]));

const applyObservedUpdate = (
  state: DailyBudgetState,
  needs: ObservedUpdateNeeds,
  stats: ObservedHourlyStats,
  observedConfigKey: string,
): { nextState: DailyBudgetState; changed: boolean } => {
  const { max, min, netReserve, grossReserve } = OBSERVED_HOURLY_STATS_GROUPS;
  const nextState: DailyBudgetState = {
    ...state,
    ...selectObservedSeries(needs.needsMax, max, stats, state),
    ...selectObservedSeries(needs.needsMin, min, stats, state),
    ...selectObservedSeries(needs.needsNetReserve, netReserve, stats, state),
    ...selectObservedSeries(needs.needsGrossReserve, grossReserve, stats, state),
    profileObservedStatsConfigKey: needs.needsConfig
      ? observedConfigKey
      : state.profileObservedStatsConfigKey,
  };
  const maxChanged = needs.needsMax && hasObservedSeriesChanged(state, nextState, max);
  const minChanged = needs.needsMin && hasObservedSeriesChanged(state, nextState, min);
  const reserveChanged = (needs.needsNetReserve || needs.needsGrossReserve)
    && hasObservedSeriesChanged(state, nextState, [...netReserve, ...grossReserve]);
  const configChanged = needs.needsConfig
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
}): ObservedUpdateNeeds => {
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

/**
 * Learned p50 GROSS uncontrolled (always-on background) reserve for a local
 * hour-of-day (kWh), or `undefined` until that hour has real samples. The p50
 * array is zero-seeded as a fallback at startup, so an unlearned hour must NOT
 * surface a fabricated 0 — gate on a positive sample count first.
 */
export function resolveObservedGrossBackgroundKwh(state: DailyBudgetState, hourOfDay: number): number | undefined {
  const samples = state.profileObservedGrossUncontrolledSampleCounts?.[hourOfDay];
  if (!isFiniteNumber(samples) || samples <= 0) return undefined;
  const p50 = state.profileObservedP50GrossUncontrolledKWh?.[hourOfDay];
  return typeof p50 === 'number' && Number.isFinite(p50) ? p50 : undefined;
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
  const { stats, windowBucketCount } = buildObservedHourlyStatsFromWindow({
    powerTracker,
    timeZone,
    windowStartUtcMs,
    windowEndUtcMs,
  });
  const needs = resolveObservedUpdateNeeds({
    hasMax,
    hasMin,
    hasNetReserve,
    hasGrossReserve,
    needsRefreshRequested,
    windowBucketCount,
  });

  const update = applyObservedUpdate(state, needs, stats, observedConfigKey);
  if (!update.changed) return { nextState: state, changed: false };

  const actionLabel = needs.needsRefresh ? 'refreshed' : 'backfilled';
  return {
    nextState: update.nextState,
    changed: update.changed,
    logEvent: update.changed
      ? { event: 'daily_budget_observed_stats_updated', action: actionLabel, windowBucketCount }
      : undefined,
  };
}
