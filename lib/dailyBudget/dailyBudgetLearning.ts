import type { PowerTrackerState } from '../power/tracker';
import {
  buildLocalDayBuckets,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../../packages/shared-domain/src/utils/dateUtils';
import { zeroHourProfile } from './hourProfile';
import { OBSERVED_HOURLY_PEAK_WINDOW_DAYS } from './dailyBudgetConstants';
import { buildObservedHourlyStatsFromWindow } from './dailyBudgetObservedStats';
import { normalizeWeights, sumArray } from './dailyBudgetMath';
import type { DailyBudgetProfile, DailyBudgetState } from './dailyBudgetTypes';
import type { ObservedHourlyStats } from './observedHourlyStats';

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
  const exemptBuckets = powerTracker.exemptBuckets || {};
  const entries = bucketKeys.map((key) => {
    const total = totalBuckets[key];
    const controlled = controlledBuckets[key];
    const exempt = exemptBuckets[key];
    const hasTotal = typeof total === 'number' && Number.isFinite(total);
    const hasControlled = typeof controlled === 'number' && Number.isFinite(controlled);
    let nextUncontrolled = 0;
    let nextControlled = 0;

    if (hasTotal) {
      const safeTotal = Math.max(0, total);
      if (hasControlled) {
        const boundedExempt = typeof exempt === 'number' && Number.isFinite(exempt)
          ? Math.max(0, Math.min(exempt, safeTotal))
          : 0;
        const boundedControlled = Math.max(0, Math.min(controlled - boundedExempt, safeTotal));
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

type LearningSkipResult = { nextState: DailyBudgetState; shouldMarkDirty: boolean; logEvent?: Record<string, unknown> };

type LearningSkipReason = 'incomplete_data' | 'missing_totals' | 'zero_kwh';

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

type HourlyTotals = { hourlyUncontrolled: number[]; hourlyControlled: number[] };

type DayWeights = { dayUncontrolledWeights: number[] | null; dayControlledWeights: number[] | null };

const skipLearning = (
  state: DailyBudgetState,
  previousDateKey: string,
  reason: LearningSkipReason,
): LearningSkipResult => ({
  nextState: resetLearningPlanState(state),
  shouldMarkDirty: true,
  logEvent: { event: 'daily_budget_learning_skipped', dateKey: previousDateKey, reason },
});

/** The previous local day's buckets, or null when the tracker marked part of that day unreliable. */
const resolveLearningWindow = (
  previousDayStartUtcMs: number,
  timeZone: string,
  powerTracker: PowerTrackerState,
): LearningWindow | null => {
  const previousNextDayStartUtcMs = getNextLocalDayStartUtcMs(previousDayStartUtcMs, timeZone);
  if (hasUnreliableOverlap({
    startUtcMs: previousDayStartUtcMs,
    endUtcMs: previousNextDayStartUtcMs,
    unreliablePeriods: powerTracker.unreliablePeriods,
  })) {
    return null;
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

const resolveLearningTotals = (
  learningWindow: LearningWindow,
  powerTracker: PowerTrackerState,
): LearningTotals | Exclude<LearningSkipReason, 'incomplete_data'> => {
  const { bucketStartUtcMs } = learningWindow;
  const bucketUsage = buildBucketUsageSplit({
    bucketStartUtcMs,
    powerTracker,
  });
  if (!bucketUsage.hasTotalData) return 'missing_totals';
  const totalUncontrolledKWh = sumArray(bucketUsage.bucketUsageUncontrolled);
  const totalControlledKWh = sumArray(bucketUsage.bucketUsageControlled);
  const totalKWh = totalUncontrolledKWh + totalControlledKWh;
  if (totalKWh <= 0) return 'zero_kwh';
  return {
    bucketStartUtcMs,
    bucketUsage,
    totalUncontrolledKWh,
    totalControlledKWh,
    totalKWh,
  };
};

/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
const buildHourlyTotals = (totals: LearningTotals, timeZone: string): HourlyTotals => {
  const { bucketStartUtcMs, bucketUsage } = totals;
  // 24-slot profiles, so the `Hour` a bucket resolves to indexes them checked.
  const hourlyUncontrolled = zeroHourProfile();
  const hourlyControlled = zeroHourProfile();
  for (const [index, ts] of bucketStartUtcMs.entries()) {
    const bucketHour = getZonedParts(new Date(ts), timeZone).hour;
    const uncontrolledIncrement = bucketUsage.bucketUsageUncontrolled[index] ?? 0;
    const controlledIncrement = bucketUsage.bucketUsageControlled[index] ?? 0;
    hourlyUncontrolled[bucketHour] += uncontrolledIncrement;
    hourlyControlled[bucketHour] += controlledIncrement;
  }
  return { hourlyUncontrolled, hourlyControlled };
};
/* eslint-enable functional/immutable-data */

const buildDayWeights = (hourlyTotals: HourlyTotals, totals: LearningTotals): DayWeights => ({
  dayUncontrolledWeights: totals.totalUncontrolledKWh > 0 ? normalizeWeights(hourlyTotals.hourlyUncontrolled) : null,
  dayControlledWeights: totals.totalControlledKWh > 0 ? normalizeWeights(hourlyTotals.hourlyControlled) : null,
});

/** How many days the profile has learned from, whichever field of the state carries the count. */
export const resolveProfileSampleCount = (state: DailyBudgetState): number => Math.max(
  0,
  typeof state.profileSampleCount === 'number'
    ? state.profileSampleCount
    : (state.profile?.sampleCount ?? 0),
);

const resolveProfileSplitSampleCount = (state: DailyBudgetState): number => Math.max(
  0,
  typeof state.profileSplitSampleCount === 'number' ? state.profileSplitSampleCount : 0,
);


const buildNextLearningState = (
  state: DailyBudgetState,
  defaultProfile: number[],
  totals: LearningTotals,
  dayWeights: DayWeights,
  observedStats: ObservedHourlyStats,
): DailyBudgetState => {
  const previousSampleCount = resolveProfileSampleCount(state);
  const previousSplitSampleCount = resolveProfileSplitSampleCount(state);
  const nextSampleCount = previousSampleCount + 1;
  const nextSplitSampleCount = totals.bucketUsage.usedControlledData
    ? previousSplitSampleCount + 1
    : previousSplitSampleCount;
  const controlledShare = totals.totalControlledKWh / totals.totalKWh;
  const nextControlledShare = buildNextShare({
    previousShare: typeof state.profileControlledShare === 'number' ? state.profileControlledShare : 0,
    previousCount: previousSampleCount,
    dayShare: controlledShare,
    nextCount: nextSampleCount,
  });
  const nextUncontrolled = buildNextProfile(
    state.profileUncontrolled ?? buildProfileFallback(defaultProfile),
    previousSampleCount,
    dayWeights.dayUncontrolledWeights,
  );
  const nextControlled = buildNextProfile(
    state.profileControlled ?? buildProfileFallback(defaultProfile),
    previousSplitSampleCount,
    dayWeights.dayControlledWeights,
  );
  return resetLearningPlanState({
    ...state,
    profileUncontrolled: nextUncontrolled,
    profileControlled: nextControlled,
    profileControlledShare: nextControlledShare,
    profileSampleCount: nextSampleCount,
    profileSplitSampleCount: nextSplitSampleCount,
    ...observedStats,
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
}): { nextState: DailyBudgetState; shouldMarkDirty: boolean; logEvent?: Record<string, unknown> } {
  const {
    state,
    timeZone,
    powerTracker,
    previousDateKey,
    previousDayStartUtcMs,
    defaultProfile,
    nowMs,
  } = params;
  if (previousDayStartUtcMs === null) {
    return { nextState: state, shouldMarkDirty: false };
  }
  const learningWindow = resolveLearningWindow(previousDayStartUtcMs, timeZone, powerTracker);
  if (learningWindow === null) {
    return skipLearning(state, previousDateKey, 'incomplete_data');
  }
  const totals = resolveLearningTotals(learningWindow, powerTracker);
  if (typeof totals === 'string') {
    return skipLearning(state, previousDateKey, totals);
  }
  const dayWeights = buildDayWeights(buildHourlyTotals(totals, timeZone), totals);
  const observedWindowEndMs = resolveObservedWindowEndMs(nowMs, learningWindow.windowEndUtcMs);
  const observedWindowStartMs = observedWindowEndMs - OBSERVED_HOURLY_PEAK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const { stats: observedStats, windowBucketCount } = buildObservedHourlyStatsFromWindow({
    powerTracker,
    timeZone,
    windowStartUtcMs: observedWindowStartMs,
    windowEndUtcMs: observedWindowEndMs,
  });
  const nextState = buildNextLearningState(state, defaultProfile, totals, dayWeights, observedStats);

  const usageKindLabel = totals.bucketUsage.usedControlledData ? 'split' : 'total';
  return {
    nextState,
    shouldMarkDirty: true,
    logEvent: {
      event: 'daily_budget_learning_finalized',
      dateKey: previousDateKey,
      totalKWh: totals.totalKWh,
      usageKind: usageKindLabel,
      windowBucketCount,
    },
  };
}

function resolveObservedWindowEndMs(nowMs: number | undefined, fallbackEndMs: number): number {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return fallbackEndMs;
  const hourMs = 60 * 60 * 1000;
  return Math.floor(nowMs / hourMs) * hourMs;
}


function buildProfileFallback(defaultProfile: number[]): DailyBudgetProfile {
  return {
    weights: [...defaultProfile],
    sampleCount: 0,
  };
}

/**
 * Blend one day's weights into a profile learned over `sampleCount` days. A day
 * with no weights for this split, or not exactly 24 of them, leaves the profile
 * as it was.
 */
function buildNextProfile(
  profile: DailyBudgetProfile,
  sampleCount: number,
  dayWeights: number[] | null,
): DailyBudgetProfile {
  if (!dayWeights || dayWeights.length !== 24) return profile;
  const nextCount = sampleCount + 1;
  const nextWeights = profile.weights.map((value, index) => (
    // `dayWeights` is length-checked to 24 above; a stored profile with more
    // slots than that has no day weight to blend in, and 0 is a weight's identity.
    (value * sampleCount + (dayWeights[index] ?? 0)) / nextCount
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
    plannedUncontrolledKWh: [],
    plannedGrossUncontrolledKWh: [],
    plannedControlledKWh: [],
  };
}
