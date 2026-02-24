import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildLocalDayBuckets,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';
import { OBSERVED_HOURLY_PEAK_WINDOW_DAYS } from './dailyBudgetConstants';
import { buildObservedHourlyStatsFromWindow } from './dailyBudgetObservedStats';
import { normalizeWeights, sumArray } from './dailyBudgetMath';
import type { DailyBudgetState } from './dailyBudgetTypes';

export function buildBucketUsageSplit(params: {
  bucketStartUtcMs: number[];
  powerTracker: PowerTrackerState;
}): {
  bucketUsageUncontrolled: number[];
  bucketUsageControlled: number[];
  usedControlledData: boolean;
  hasTotalData: boolean;
} {
  const { bucketStartUtcMs, powerTracker } = params;
  const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
  const totalBuckets = powerTracker.buckets || {};
  const controlledBuckets = powerTracker.controlledBuckets || {};
  const entries = bucketKeys.map((key) => {
    const total = totalBuckets[key];
    const controlled = controlledBuckets[key];
    const hasTotal = typeof total === 'number' && Number.isFinite(total);
    const hasControlled = typeof controlled === 'number' && Number.isFinite(controlled);
    let nextUncontrolled = 0;
    let nextControlled = 0;

    if (hasTotal) {
      const safeTotal = Math.max(0, total as number);
      if (hasControlled) {
        const boundedControlled = Math.max(0, Math.min(controlled as number, safeTotal));
        nextUncontrolled = Math.max(0, safeTotal - boundedControlled);
        nextControlled = boundedControlled;
      } else {
        nextUncontrolled = safeTotal;
      }
    }

    return {
      uncontrolled: nextUncontrolled,
      controlled: nextControlled,
      usedControlledData: hasTotal && hasControlled,
      hasTotalData: hasTotal,
    };
  });

  return {
    bucketUsageUncontrolled: entries.map((entry) => entry.uncontrolled),
    bucketUsageControlled: entries.map((entry) => entry.controlled),
    usedControlledData: entries.some((entry) => entry.usedControlledData),
    hasTotalData: entries.some((entry) => entry.hasTotalData),
  };
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
  windowEndUtcMs: number;
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
  return {
    bucketStartUtcMs,
    windowEndUtcMs: previousNextDayStartUtcMs,
  };
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
  if (!bucketUsage.hasTotalData) {
    return {
      nextState: resetLearningPlanState(state),
      shouldMarkDirty: true,
      logMessage: `Daily budget: skip learning for ${previousDateKey} (missing totals)`,
    };
  }
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
  const totals = bucketStartUtcMs.reduce((acc, ts, index) => {
    const bucketHour = getZonedParts(new Date(ts), timeZone).hour;
    const uncontrolledIncrement = bucketUsage.bucketUsageUncontrolled[index] ?? 0;
    const controlledIncrement = bucketUsage.bucketUsageControlled[index] ?? 0;
    return {
      uncontrolled: {
        ...acc.uncontrolled,
        [bucketHour]: (acc.uncontrolled[bucketHour] ?? 0) + uncontrolledIncrement,
      },
      controlled: {
        ...acc.controlled,
        [bucketHour]: (acc.controlled[bucketHour] ?? 0) + controlledIncrement,
      },
    };
  }, { uncontrolled: {} as Record<number, number>, controlled: {} as Record<number, number> });

  return {
    hourlyUncontrolled: Array.from({ length: 24 }, (_, hour) => totals.uncontrolled[hour] ?? 0),
    hourlyControlled: Array.from({ length: 24 }, (_, hour) => totals.controlled[hour] ?? 0),
  };
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
  sampleCount: number;
  dayWeights: number[] | null;
  defaultProfile: number[];
}): DailyBudgetState['profileControlled'] => {
  const { current, sampleCount, dayWeights, defaultProfile } = params;
  if (!dayWeights) return current ?? buildProfileFallback(defaultProfile);
  return buildNextProfile({
    current,
    sampleCount,
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
  observedMaxUncontrolled: number[];
  observedMaxControlled: number[];
  observedMinUncontrolled: number[];
  observedMinControlled: number[];
}): DailyBudgetState => {
  const {
    state,
    defaultProfile,
    totalKWh,
    totalControlledKWh,
    bucketUsage,
    dayUncontrolledWeights,
    dayControlledWeights,
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
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
    sampleCount: previousSampleCount,
    dayWeights: dayUncontrolledWeights,
    defaultProfile,
  });
  const nextControlled = resolveNextProfile({
    current: state.profileControlled,
    sampleCount: previousSplitSampleCount,
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
    profileObservedMaxUncontrolledKWh: observedMaxUncontrolled,
    profileObservedMaxControlledKWh: observedMaxControlled,
    profileObservedMinUncontrolledKWh: observedMinUncontrolled,
    profileObservedMinControlledKWh: observedMinControlled,
  });
};


export function finalizePreviousDayLearning(params: {
  state: DailyBudgetState;
  timeZone: string;
  powerTracker: PowerTrackerState;
  previousDateKey: string;
  previousDayStartUtcMs: number | null;
  defaultProfile: number[];
  nowMs?: number;
}): { nextState: DailyBudgetState; shouldMarkDirty: boolean; logMessage?: string } {
  const {
    state,
    timeZone,
    powerTracker,
    previousDateKey,
    previousDayStartUtcMs,
    defaultProfile,
    nowMs,
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
  const observedWindowEndMs = typeof nowMs === 'number' && Number.isFinite(nowMs)
    ? nowMs
    : windowResult.windowEndUtcMs;
  const observedWindowStartMs = observedWindowEndMs - OBSERVED_HOURLY_PEAK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const {
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
    windowBucketCount,
  } = buildObservedHourlyStatsFromWindow({
    powerTracker,
    timeZone,
    windowStartUtcMs: observedWindowStartMs,
    windowEndUtcMs: observedWindowEndMs,
  });
  const nextState = buildNextLearningState({
    state,
    defaultProfile,
    totalKWh,
    totalControlledKWh,
    bucketUsage,
    dayUncontrolledWeights,
    dayControlledWeights,
    observedMaxUncontrolled,
    observedMaxControlled,
    observedMinUncontrolled,
    observedMinControlled,
  });

  const sourceLabel = bucketUsage.usedControlledData ? 'split' : 'total';
  return {
    nextState,
    shouldMarkDirty: true,
    logMessage: `Daily budget: finalized ${previousDateKey} (${totalKWh.toFixed(2)} kWh ${sourceLabel}, window buckets ${windowBucketCount})`,
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
  sampleCount: number;
  dayWeights: number[];
  defaultProfile: number[];
}): DailyBudgetState['profileControlled'] {
  const { current, sampleCount, dayWeights, defaultProfile } = params;
  const profile = current ?? buildProfileFallback(defaultProfile);
  if (dayWeights.length !== 24) return current ?? profile;
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
