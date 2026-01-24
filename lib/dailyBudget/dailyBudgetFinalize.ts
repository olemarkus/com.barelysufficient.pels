import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildLocalDayBuckets,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';
import {
  buildDefaultProfile,
  normalizeWeights,
  sumArray,
} from './dailyBudgetMath';
import { buildBucketUsage } from './dailyBudgetState';
import type { DailyBudgetState } from './dailyBudgetTypes';

const DEFAULT_PROFILE = buildDefaultProfile();

const updateProfile = (state: DailyBudgetState, dayWeights: number[]): DailyBudgetState => {
  const profile = state.profile ?? { weights: [...DEFAULT_PROFILE], sampleCount: 0 };
  if (dayWeights.length !== 24) return state;
  const sampleCount = Math.max(0, profile.sampleCount ?? 0);
  const nextCount = sampleCount + 1;
  const nextWeights = profile.weights.map((value, index) => (
    (value * sampleCount + dayWeights[index]) / nextCount
  ));
  return {
    ...state,
    profile: {
      weights: normalizeWeights(nextWeights),
      sampleCount: nextCount,
    },
  };
};

export const finalizePreviousDay = (params: {
  state: DailyBudgetState;
  timeZone: string;
  powerTracker: PowerTrackerState;
  previousDateKey: string;
  previousDayStartUtcMs: number | null;
  logDebug: (...args: unknown[]) => void;
  markDirty: (force?: boolean) => void;
}): DailyBudgetState => {
  const {
    state,
    timeZone,
    powerTracker,
    previousDateKey,
    previousDayStartUtcMs,
    logDebug,
    markDirty,
  } = params;
  if (previousDayStartUtcMs === null) return state;
  const previousNextDayStartUtcMs = getNextLocalDayStartUtcMs(previousDayStartUtcMs, timeZone);
  const { bucketStartUtcMs } = buildLocalDayBuckets({
    dayStartUtcMs: previousDayStartUtcMs,
    nextDayStartUtcMs: previousNextDayStartUtcMs,
    timeZone,
  });
  const { bucketUsage } = buildBucketUsage({ bucketStartUtcMs, powerTracker });
  const totalKWh = sumArray(bucketUsage);
  if (totalKWh <= 0) {
    markDirty(true);
    logDebug(`Daily budget: skip learning for ${previousDateKey} (0 kWh)`);
    return {
      ...state,
      frozen: false,
      lastPlanBucketStartUtcMs: null,
      plannedKWh: [],
    };
  }
  const hourlyTotals = bucketStartUtcMs.reduce((totals, ts, index) => {
    const bucketHour = getZonedParts(new Date(ts), timeZone).hour;
    const current = totals.get(bucketHour) ?? 0;
    totals.set(bucketHour, current + (bucketUsage[index] ?? 0));
    return totals;
  }, new Map<number, number>());
  const hourlyTotalsArray = Array.from({ length: 24 }, (_, hour) => hourlyTotals.get(hour) ?? 0);
  const nextWeights = hourlyTotalsArray.map((value) => value / totalKWh);
  const nextState = updateProfile(state, nextWeights);
  markDirty(true);
  logDebug(`Daily budget: finalized ${previousDateKey} (${totalKWh.toFixed(2)} kWh)`);
  return {
    ...nextState,
    frozen: false,
    lastPlanBucketStartUtcMs: null,
    plannedKWh: [],
  };
};
