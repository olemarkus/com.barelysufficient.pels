import { computePlanDeviation, type DayContext, type PriceData } from './dailyBudgetState';
import type { ExistingPlanState } from './dailyBudgetManagerTypes';
import { getConfidence } from './dailyBudgetMath';
import {
  OBSERVED_HOURLY_MAX_QUANTILE,
  OBSERVED_HOURLY_MIN_QUANTILE,
  OBSERVED_HOURLY_PEAK_MARGIN_RATIO,
  OBSERVED_HOURLY_PEAK_WINDOW_DAYS,
  OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES,
  PLAN_REBUILD_INTERVAL_MS,
  PLAN_REBUILD_USAGE_DELTA_KWH,
  PLAN_REBUILD_USAGE_MIN_INTERVAL_MS,
} from './dailyBudgetConstants';
import { getProfileDebugSummary } from './dailyBudgetProfile';
import type {
  DailyBudgetDayPayload,
  DailyBudgetSettings,
  DailyBudgetState,
} from './dailyBudgetTypes';

export function resolveExistingPlanState(params: {
  state: DailyBudgetState;
  context: DayContext;
  enabled: boolean;
  dailyBudgetKWh: number;
}): {
  planState: ExistingPlanState;
  resetPlanState: boolean;
} {
  const {
    state,
    context,
    enabled,
    dailyBudgetKWh,
  } = params;
  const planStateMismatch = hasPlanStateMismatch(state, context);
  const existingPlan = getExistingPlan(
    state,
    planStateMismatch,
    context.bucketStartUtcMs.length,
  );
  let deviationExisting = 0;
  if (enabled && existingPlan) {
    const deviation = computePlanDeviation({
      enabled,
      plannedKWh: existingPlan,
      dailyBudgetKWh,
      currentBucketIndex: context.currentBucketIndex,
      currentBucketProgress: context.currentBucketProgress,
      usedNowKWh: context.usedNowKWh,
    });
    deviationExisting = deviation.deviationKWh;
  }
  return {
    planState: {
      planStateMismatch,
      existingPlan,
      deviationExisting,
    },
    resetPlanState: planStateMismatch,
  };
}

export function resolvePlanLockState(params: {
  context: DayContext;
  existingPlan: number[] | null;
  lastPlanBucketStartUtcMs?: number | null;
}): {
  lockCurrentBucket: boolean;
  hasPreviousPlan: boolean;
  shouldLockCurrent: boolean;
  remainingStartIndex: number;
  currentBucketStartUtcMs: number;
} {
  const { context, existingPlan, lastPlanBucketStartUtcMs } = params;
  const currentBucketStartUtcMs = context.bucketStartUtcMs[context.currentBucketIndex];
  const lockCurrentBucket = lastPlanBucketStartUtcMs === currentBucketStartUtcMs;
  const hasPreviousPlan = Array.isArray(existingPlan)
    && existingPlan.length === context.bucketStartUtcMs.length;
  const shouldLockCurrent = Boolean(lockCurrentBucket) && hasPreviousPlan;
  const remainingStartIndex = shouldLockCurrent
    ? Math.min(context.currentBucketIndex + 1, context.bucketStartUtcMs.length)
    : context.currentBucketIndex;
  return {
    lockCurrentBucket,
    hasPreviousPlan,
    shouldLockCurrent,
    remainingStartIndex,
    currentBucketStartUtcMs,
  };
}

export function shouldRebuildDailyBudgetPlan(params: {
  context: DayContext;
  enabled: boolean;
  planStateMismatch: boolean;
  forcePlanRebuild?: boolean;
  frozen: boolean;
  lastPlanBucketStartUtcMs?: number | null;
  lastUsedNowKWh?: number;
  lastPlanRebuildMs: number;
}): boolean {
  const {
    context,
    enabled,
    planStateMismatch,
    forcePlanRebuild,
    frozen,
    lastPlanBucketStartUtcMs,
    lastUsedNowKWh,
    lastPlanRebuildMs,
  } = params;
  if (!enabled || frozen) return false;
  const currentBucketStartUtcMs = context.bucketStartUtcMs[context.currentBucketIndex];
  const usageDeltaKWh = typeof lastUsedNowKWh === 'number'
    ? Math.abs(context.usedNowKWh - lastUsedNowKWh)
    : 0;
  const usageChanged = usageDeltaKWh >= PLAN_REBUILD_USAGE_DELTA_KWH
    && context.nowMs - lastPlanRebuildMs >= PLAN_REBUILD_USAGE_MIN_INTERVAL_MS;
  return (
    planStateMismatch
    || Boolean(forcePlanRebuild)
    || usageChanged
    || lastPlanBucketStartUtcMs !== currentBucketStartUtcMs
    || context.nowMs - lastPlanRebuildMs >= PLAN_REBUILD_INTERVAL_MS
  );
}

export function logDailyBudgetPlanDebug(params: {
  logDebug: (...args: unknown[]) => void;
  snapshot: DailyBudgetDayPayload;
  priceData: PriceData;
  priceOptimizationEnabled: boolean;
  capacityBudgetKWh?: number;
  settings: DailyBudgetSettings;
  state: DailyBudgetState;
  defaultProfile: number[];
  label?: string;
  planDebug?: {
    lockCurrentBucket: boolean;
    shouldLockCurrent: boolean;
    remainingStartIndex: number;
    hasPreviousPlan: boolean;
  };
}): void {
  const {
    logDebug,
    snapshot,
    priceData,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    settings,
    state,
    defaultProfile,
    label,
    planDebug,
  } = params;
  const { combinedWeights, learnedWeights, profileMeta } = getProfileDebugSummary(
    state,
    settings,
    defaultProfile,
  );
  const debugPayload = buildPlanDebugPayload({
    snapshot,
    settings,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    priceData,
    state,
    defaultProfile,
    combinedWeights,
    learnedWeights,
    profileMeta,
    planDebug,
  });
  logDebug(
    `Daily budget: profile samples ${profileMeta.sampleCount} total, `
    + `${profileMeta.splitSampleCount} split, `
    + `controlled share ${profileMeta.controlledShare.toFixed(2)}`,
  );
  logDebug(`${label ?? 'Daily budget: plan debug'} ${JSON.stringify(debugPayload)}`);
}

function buildPlanDebugPayload(params: {
  snapshot: DailyBudgetDayPayload;
  settings: DailyBudgetSettings;
  priceOptimizationEnabled: boolean;
  capacityBudgetKWh?: number;
  priceData: PriceData;
  state: DailyBudgetState;
  defaultProfile: number[];
  combinedWeights: number[];
  learnedWeights: number[] | null;
  profileMeta: ReturnType<typeof getProfileDebugSummary>['profileMeta'];
  planDebug?: {
    lockCurrentBucket: boolean;
    shouldLockCurrent: boolean;
    remainingStartIndex: number;
    hasPreviousPlan: boolean;
  };
}): DailyBudgetDayPayload & { meta: Record<string, unknown> } {
  const {
    snapshot,
    settings,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    priceData,
    state,
    defaultProfile,
    combinedWeights,
    learnedWeights,
    profileMeta,
    planDebug,
  } = params;
  return {
    ...snapshot,
    meta: {
      settings: {
        dailyBudgetKWh: settings.dailyBudgetKWh,
        priceShapingEnabled: settings.priceShapingEnabled,
        controlledUsageWeight: settings.controlledUsageWeight,
        priceShapingFlexShare: settings.priceShapingFlexShare,
      },
      priceOptimizationEnabled,
      capacityBudgetKWh: Number.isFinite(capacityBudgetKWh) ? capacityBudgetKWh : null,
      profileSampleCount: profileMeta.sampleCount,
      profileSplitSampleCount: profileMeta.splitSampleCount,
      profileConfidence: getConfidence(profileMeta.sampleCount),
      profileDefaultWeights: defaultProfile,
      profileLearnedWeights: learnedWeights,
      profileEffectiveWeights: combinedWeights,
      profileWeightsCombined: state.profile?.weights ?? null,
      profileWeightsUncontrolled: state.profileUncontrolled?.weights ?? null,
      profileWeightsControlled: state.profileControlled?.weights ?? null,
      profileControlledShare: profileMeta.controlledShare,
      observedPeakWindowDays: OBSERVED_HOURLY_PEAK_WINDOW_DAYS,
      observedPeakMarginRatio: OBSERVED_HOURLY_PEAK_MARGIN_RATIO,
      observedPeakMaxQuantile: OBSERVED_HOURLY_MAX_QUANTILE,
      observedPeakMinQuantile: OBSERVED_HOURLY_MIN_QUANTILE,
      observedPeakQuantileMinSamples: OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES,
      profileObservedMaxUncontrolledKWh: state.profileObservedMaxUncontrolledKWh ?? null,
      profileObservedMaxControlledKWh: state.profileObservedMaxControlledKWh ?? null,
      profileObservedMinUncontrolledKWh: state.profileObservedMinUncontrolledKWh ?? null,
      profileObservedMinControlledKWh: state.profileObservedMinControlledKWh ?? null,
      priceSpreadFactor: priceData.priceSpreadFactor ?? null,
      effectivePriceShapingFlexShare: priceData.effectivePriceShapingFlexShare ?? null,
      planDebug: planDebug ?? null,
    },
  };
}

function hasPlanStateMismatch(state: DailyBudgetState, context: DayContext): boolean {
  if (!state.plannedKWh) return true;
  if (state.plannedKWh.length !== context.bucketStartUtcMs.length) return true;
  if (state.dayStartUtcMs !== context.dayStartUtcMs) return true;
  if (typeof state.lastPlanBucketStartUtcMs === 'number' && Number.isFinite(state.lastPlanBucketStartUtcMs)) {
    return !context.bucketStartUtcMs.includes(state.lastPlanBucketStartUtcMs);
  }
  return false;
}

function getExistingPlan(
  state: DailyBudgetState,
  planStateMismatch: boolean,
  bucketCount: number,
): number[] | null {
  if (planStateMismatch) return null;
  if (!Array.isArray(state.plannedKWh)) return null;
  if (state.plannedKWh.length !== bucketCount) return null;
  return state.plannedKWh;
}
