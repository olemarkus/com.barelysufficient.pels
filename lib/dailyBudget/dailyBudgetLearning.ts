import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildLocalDayBuckets,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';
import { normalizeWeights, sumArray } from './dailyBudgetMath';
import type { DailyBudgetState } from './dailyBudgetTypes';

export function buildBucketUsageSplit(params: {
  bucketStartUtcMs: number[];
  powerTracker: PowerTrackerState;
}): { bucketUsageUncontrolled: number[]; bucketUsageControlled: number[]; usedControlledData: boolean } {
  const { bucketStartUtcMs, powerTracker } = params;
  const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
  const totalBuckets = powerTracker.buckets || {};
  const controlledBuckets = powerTracker.controlledBuckets || {};
  let usedControlledData = false;
  const bucketUsageUncontrolled = bucketKeys.map((key) => {
    const total = totalBuckets[key];
    const controlled = controlledBuckets[key];
    if (typeof total === 'number' && Number.isFinite(total)
      && typeof controlled === 'number' && Number.isFinite(controlled)) {
      usedControlledData = true;
      const safeTotal = Math.max(0, total);
      const boundedControlled = Math.max(0, Math.min(controlled, safeTotal));
      return Math.max(0, safeTotal - boundedControlled);
    }
    return typeof total === 'number' && Number.isFinite(total) ? Math.max(0, total) : 0;
  });
  const bucketUsageControlled = bucketKeys.map((key, index) => {
    const total = totalBuckets[key];
    const controlled = controlledBuckets[key];
    if (typeof total === 'number' && Number.isFinite(total)
      && typeof controlled === 'number' && Number.isFinite(controlled)) {
      const safeTotal = Math.max(0, total);
      const boundedControlled = Math.max(0, Math.min(controlled, safeTotal));
      return boundedControlled;
    }
    if (bucketUsageUncontrolled[index] > 0) return 0;
    return typeof controlled === 'number' && Number.isFinite(controlled) ? Math.max(0, controlled) : 0;
  });
  return { bucketUsageUncontrolled, bucketUsageControlled, usedControlledData };
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

type LearningSkipResult = { nextState: DailyBudgetState; shouldMarkDirty: boolean; logMessage?: string };

type LearningWindow = {
  bucketStartUtcMs: number[];
};

type LearningTotals = {
  bucketStartUtcMs: number[];
  bucketUsage: ReturnType<typeof buildBucketUsageSplit>;
  totalUncontrolledKWh: number;
  totalControlledKWh: number;
  totalKWh: number;
};

const resolveLearningWindow = (params: {
  state: DailyBudgetState;
  timeZone: string;
  powerTracker: PowerTrackerState;
  previousDateKey: string;
  previousDayStartUtcMs: number | null;
}): LearningWindow | LearningSkipResult => {
  const {
    state,
    timeZone,
    powerTracker,
    previousDateKey,
    previousDayStartUtcMs,
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
  return { bucketStartUtcMs };
};

const resolveLearningTotals = (params: {
  state: DailyBudgetState;
  powerTracker: PowerTrackerState;
  previousDateKey: string;
  bucketStartUtcMs: number[];
}): LearningTotals | LearningSkipResult => {
  const {
    state,
    powerTracker,
    previousDateKey,
    bucketStartUtcMs,
  } = params;
  const bucketUsage = buildBucketUsageSplit({
    bucketStartUtcMs,
    powerTracker,
  });
  const totalUncontrolledKWh = sumArray(bucketUsage.bucketUsageUncontrolled);
  const totalControlledKWh = sumArray(bucketUsage.bucketUsageControlled);
  const totalKWh = totalUncontrolledKWh + totalControlledKWh;
  if (totalKWh <= 0) {
    return {
      nextState: resetLearningPlanState(state),
      shouldMarkDirty: true,
      logMessage: `Daily budget: skip learning for ${previousDateKey} (0 kWh)`,
    };
  }
  return {
    bucketStartUtcMs,
    bucketUsage,
    totalUncontrolledKWh,
    totalControlledKWh,
    totalKWh,
  };
};

const buildHourlyTotals = (params: {
  bucketStartUtcMs: number[];
  timeZone: string;
  bucketUsage: ReturnType<typeof buildBucketUsageSplit>;
}): { hourlyUncontrolled: number[]; hourlyControlled: number[] } => {
  const { bucketStartUtcMs, timeZone, bucketUsage } = params;
  const hourlyUncontrolled = bucketStartUtcMs.reduce((totals, ts, index) => {
    const bucketHour = getZonedParts(new Date(ts), timeZone).hour;
    const increment = bucketUsage.bucketUsageUncontrolled[index] ?? 0;
    return totals.map((value, hourIndex) => (
      hourIndex === bucketHour ? value + increment : value
    ));
  }, Array.from({ length: 24 }, () => 0));
  const hourlyControlled = bucketStartUtcMs.reduce((totals, ts, index) => {
    const bucketHour = getZonedParts(new Date(ts), timeZone).hour;
    const increment = bucketUsage.bucketUsageControlled[index] ?? 0;
    return totals.map((value, hourIndex) => (
      hourIndex === bucketHour ? value + increment : value
    ));
  }, Array.from({ length: 24 }, () => 0));
  return { hourlyUncontrolled, hourlyControlled };
};

const buildDayWeights = (params: {
  hourlyUncontrolled: number[];
  hourlyControlled: number[];
  totalUncontrolledKWh: number;
  totalControlledKWh: number;
}): { dayUncontrolledWeights: number[] | null; dayControlledWeights: number[] | null } => {
  const {
    hourlyUncontrolled,
    hourlyControlled,
    totalUncontrolledKWh,
    totalControlledKWh,
  } = params;
  return {
    dayUncontrolledWeights: totalUncontrolledKWh > 0 ? normalizeWeights(hourlyUncontrolled) : null,
    dayControlledWeights: totalControlledKWh > 0 ? normalizeWeights(hourlyControlled) : null,
  };
};

const resolveProfileSampleCount = (state: DailyBudgetState): number => Math.max(
  0,
  typeof state.profileSampleCount === 'number'
    ? state.profileSampleCount
    : (state.profile?.sampleCount ?? 0),
);

const resolveProfileSplitSampleCount = (state: DailyBudgetState): number => Math.max(
  0,
  typeof state.profileSplitSampleCount === 'number' ? state.profileSplitSampleCount : 0,
);

const resolveNextProfile = (params: {
  current?: DailyBudgetState['profileControlled'];
  dayWeights: number[] | null;
  defaultProfile: number[];
}): DailyBudgetState['profileControlled'] => {
  const { current, dayWeights, defaultProfile } = params;
  if (!dayWeights) return current ?? buildProfileFallback(defaultProfile);
  return buildNextProfile({
    current,
    dayWeights,
    defaultProfile,
  });
};

const buildNextLearningState = (params: {
  state: DailyBudgetState;
  defaultProfile: number[];
  totalKWh: number;
  totalControlledKWh: number;
  bucketUsage: ReturnType<typeof buildBucketUsageSplit>;
  dayUncontrolledWeights: number[] | null;
  dayControlledWeights: number[] | null;
}): DailyBudgetState => {
  const {
    state,
    defaultProfile,
    totalKWh,
    totalControlledKWh,
    bucketUsage,
    dayUncontrolledWeights,
    dayControlledWeights,
  } = params;
  const previousSampleCount = resolveProfileSampleCount(state);
  const previousSplitSampleCount = resolveProfileSplitSampleCount(state);
  const nextSampleCount = previousSampleCount + 1;
  const nextSplitSampleCount = bucketUsage.usedControlledData
    ? previousSplitSampleCount + 1
    : previousSplitSampleCount;
  const controlledShare = totalControlledKWh / totalKWh;
  const nextControlledShare = buildNextShare({
    previousShare: typeof state.profileControlledShare === 'number' ? state.profileControlledShare : 0,
    previousCount: previousSampleCount,
    dayShare: controlledShare,
    nextCount: nextSampleCount,
  });
  const nextUncontrolled = resolveNextProfile({
    current: state.profileUncontrolled,
    dayWeights: dayUncontrolledWeights,
    defaultProfile,
  });
  const nextControlled = resolveNextProfile({
    current: state.profileControlled,
    dayWeights: dayControlledWeights,
    defaultProfile,
  });
  return resetLearningPlanState({
    ...state,
    profileUncontrolled: nextUncontrolled,
    profileControlled: nextControlled,
    profileControlledShare: nextControlledShare,
    profileSampleCount: nextSampleCount,
    profileSplitSampleCount: nextSplitSampleCount,
  });
};

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
  const windowResult = resolveLearningWindow({
    state,
    timeZone,
    powerTracker,
    previousDateKey,
    previousDayStartUtcMs,
  });
  if (!('bucketStartUtcMs' in windowResult)) {
    return windowResult;
  }
  const totalsResult = resolveLearningTotals({
    state,
    powerTracker,
    previousDateKey,
    bucketStartUtcMs: windowResult.bucketStartUtcMs,
  });
  if (!('totalKWh' in totalsResult)) {
    return totalsResult;
  }
  const { bucketUsage, totalUncontrolledKWh, totalControlledKWh, totalKWh } = totalsResult;
  const { hourlyUncontrolled, hourlyControlled } = buildHourlyTotals({
    bucketStartUtcMs: totalsResult.bucketStartUtcMs,
    timeZone,
    bucketUsage,
  });
  const { dayUncontrolledWeights, dayControlledWeights } = buildDayWeights({
    hourlyUncontrolled,
    hourlyControlled,
    totalUncontrolledKWh,
    totalControlledKWh,
  });
  const nextState = buildNextLearningState({
    state,
    defaultProfile,
    totalKWh,
    totalControlledKWh,
    bucketUsage,
    dayUncontrolledWeights,
    dayControlledWeights,
  });
  const sourceLabel = bucketUsage.usedControlledData ? 'split' : 'total';
  return {
    nextState,
    shouldMarkDirty: true,
    logMessage: `Daily budget: finalized ${previousDateKey} (${totalKWh.toFixed(2)} kWh ${sourceLabel})`,
  };
}

function buildProfileFallback(defaultProfile: number[]) {
  return {
    weights: [...defaultProfile],
    sampleCount: 0,
  };
}

function buildNextProfile(params: {
  current?: DailyBudgetState['profileControlled'];
  dayWeights: number[];
  defaultProfile: number[];
}): DailyBudgetState['profileControlled'] {
  const { current, dayWeights, defaultProfile } = params;
  const profile = current ?? buildProfileFallback(defaultProfile);
  if (dayWeights.length !== 24) return current ?? profile;
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

function buildNextShare(params: {
  previousShare: number;
  previousCount: number;
  dayShare: number;
  nextCount: number;
}): number {
  const { previousShare, previousCount, dayShare, nextCount } = params;
  if (nextCount <= 0) return Math.max(0, Math.min(1, dayShare));
  const weighted = (previousShare * previousCount + dayShare) / nextCount;
  return Math.max(0, Math.min(1, weighted));
}

function resetLearningPlanState(state: DailyBudgetState): DailyBudgetState {
  return {
    ...state,
    frozen: false,
    lastPlanBucketStartUtcMs: null,
    plannedKWh: [],
  };
}
