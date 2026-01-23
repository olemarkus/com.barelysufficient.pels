import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildLocalDayBuckets,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';
import { CONTROLLED_USAGE_WEIGHT } from './dailyBudgetConstants';
import { normalizeWeights, sumArray } from './dailyBudgetMath';
import type { DailyBudgetState } from './dailyBudgetTypes';

export function buildWeightedBucketUsage(params: {
  bucketStartUtcMs: number[];
  powerTracker: PowerTrackerState;
}): { bucketUsage: number[]; usedControlledData: boolean } {
  const { bucketStartUtcMs, powerTracker } = params;
  const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
  const totalBuckets = powerTracker.buckets || {};
  const controlledBuckets = powerTracker.controlledBuckets || {};
  let usedControlledData = false;
  const bucketUsage = bucketKeys.map((key) => {
    const total = totalBuckets[key];
    const controlled = controlledBuckets[key];
    if (typeof total === 'number' && Number.isFinite(total)
      && typeof controlled === 'number' && Number.isFinite(controlled)) {
      usedControlledData = true;
      const safeTotal = Math.max(0, total);
      const boundedControlled = Math.max(0, Math.min(controlled, safeTotal));
      const uncontrolled = Math.max(0, safeTotal - boundedControlled);
      return uncontrolled + boundedControlled * CONTROLLED_USAGE_WEIGHT;
    }
    return typeof total === 'number' && Number.isFinite(total) ? Math.max(0, total) : 0;
  });
  return { bucketUsage, usedControlledData };
}

export function hasUnreliableOverlap(params: {
  startUtcMs: number;
  endUtcMs: number;
  unreliablePeriods?: Array<{ start: number; end: number }>;
}): boolean {
  const { startUtcMs, endUtcMs, unreliablePeriods } = params;
  if (!Array.isArray(unreliablePeriods) || unreliablePeriods.length === 0) return false;
  return unreliablePeriods.some((period) => {
    const start = Math.max(startUtcMs, period.start);
    const end = Math.min(endUtcMs, period.end);
    return end > start;
  });
}

export function finalizePreviousDayLearning(params: {
  state: DailyBudgetState;
  timeZone: string;
  powerTracker: PowerTrackerState;
  previousDateKey: string;
  previousDayStartUtcMs: number | null;
  defaultProfile: number[];
}): { nextState: DailyBudgetState; shouldMarkDirty: boolean; logMessage?: string } {
  const {
    state,
    timeZone,
    powerTracker,
    previousDateKey,
    previousDayStartUtcMs,
    defaultProfile,
  } = params;
  if (previousDayStartUtcMs === null) {
    return { nextState: state, shouldMarkDirty: false };
  }
  const previousNextDayStartUtcMs = getNextLocalDayStartUtcMs(previousDayStartUtcMs, timeZone);
  if (hasUnreliableOverlap({
    startUtcMs: previousDayStartUtcMs,
    endUtcMs: previousNextDayStartUtcMs,
    unreliablePeriods: powerTracker.unreliablePeriods,
  })) {
    return {
      nextState: resetLearningPlanState(state),
      shouldMarkDirty: true,
      logMessage: `Daily budget: skip learning for ${previousDateKey} (incomplete data)`,
    };
  }
  const { bucketStartUtcMs } = buildLocalDayBuckets({
    dayStartUtcMs: previousDayStartUtcMs,
    nextDayStartUtcMs: previousNextDayStartUtcMs,
    timeZone,
  });
  const weightedUsage = buildWeightedBucketUsage({ bucketStartUtcMs, powerTracker });
  const totalKWh = sumArray(weightedUsage.bucketUsage);
  if (totalKWh <= 0) {
    return {
      nextState: resetLearningPlanState(state),
      shouldMarkDirty: true,
      logMessage: `Daily budget: skip learning for ${previousDateKey} (0 kWh)`,
    };
  }
  const hourlyTotals = bucketStartUtcMs.reduce((totals, ts, index) => {
    const bucketHour = getZonedParts(new Date(ts), timeZone).hour;
    const increment = weightedUsage.bucketUsage[index] ?? 0;
    return totals.map((value, hourIndex) => (
      hourIndex === bucketHour ? value + increment : value
    ));
  }, Array.from({ length: 24 }, () => 0));
  const nextWeights = hourlyTotals.map((value) => value / totalKWh);
  const sourceLabel = weightedUsage.usedControlledData ? 'weighted' : 'total';
  const nextProfile = buildNextProfile(state, nextWeights, defaultProfile);
  return {
    nextState: resetLearningPlanState({
      ...state,
      profile: nextProfile ?? state.profile,
    }),
    shouldMarkDirty: true,
    logMessage: `Daily budget: finalized ${previousDateKey} (${totalKWh.toFixed(2)} kWh ${sourceLabel})`,
  };
}

function buildNextProfile(
  state: DailyBudgetState,
  dayWeights: number[],
  defaultProfile: number[],
): DailyBudgetState['profile'] {
  const profile = state.profile ?? { weights: [...defaultProfile], sampleCount: 0 };
  if (dayWeights.length !== 24) return state.profile;
  const sampleCount = Math.max(0, profile.sampleCount ?? 0);
  const nextCount = sampleCount + 1;
  const nextWeights = profile.weights.map((value, index) => (
    (value * sampleCount + dayWeights[index]) / nextCount
  ));
  return {
    weights: normalizeWeights(nextWeights),
    sampleCount: nextCount,
  };
}

function resetLearningPlanState(state: DailyBudgetState): DailyBudgetState {
  return {
    ...state,
    frozen: false,
    lastPlanBucketStartUtcMs: null,
    plannedKWh: [],
  };
}
