import { getNextLocalDayStartUtcMs } from '../utils/dateUtils';
import { buildPriceDebugData, type CombinedPriceData } from './dailyBudgetMath';
import { buildDailyBudgetPreview } from './dailyBudgetPreview';
import type { DayContext, PriceData } from './dailyBudgetState';
import type { DailyBudgetSettings, DailyBudgetState } from './dailyBudgetTypes';
import { logDailyBudgetPlanDebug } from './dailyBudgetManagerPlan';
import { getEffectiveProfileData, getProfileSplitSampleCount } from './dailyBudgetProfile';
import type { StructuredDebugEmitter } from '../logging/logger';

const isEnabled = (settings: DailyBudgetSettings): boolean => (
  settings.enabled && settings.dailyBudgetKWh > 0
);

export function logNextDayPlanDebug(params: {
  debugStructured: StructuredDebugEmitter;
  shouldLog: boolean;
  context: DayContext;
  settings: DailyBudgetSettings;
  state: DailyBudgetState;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  capacityBudgetKWh?: number;
  defaultProfile: number[];
}): void {
  const {
    debugStructured,
    shouldLog,
    context,
    settings,
    state,
    combinedPrices,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    defaultProfile,
  } = params;
  if (!shouldLog || !isEnabled(settings)) return;
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(context.dayStartUtcMs, context.timeZone);
  const profileData = getEffectiveProfileData(state, settings, defaultProfile);
  const preview = buildDailyBudgetPreview({
    dayStartUtcMs: nextDayStartUtcMs,
    timeZone: context.timeZone,
    settings,
    combinedPrices,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    enabled: true,
    priceShapingEnabled: settings.priceShapingEnabled,
    profileWeights: profileData.combinedWeights,
    profileSampleCount: profileData.sampleCount,
    profileSplitSampleCount: getProfileSplitSampleCount(state),
    profileBreakdown: profileData.breakdown,
    profileObservedMaxUncontrolledKWh: state.profileObservedMaxUncontrolledKWh,
    profileObservedMaxControlledKWh: state.profileObservedMaxControlledKWh,
    profileObservedMinUncontrolledKWh: state.profileObservedMinUncontrolledKWh,
    profileObservedMinControlledKWh: state.profileObservedMinControlledKWh,
    profileObservedP50UncontrolledKWh: state.profileObservedP50UncontrolledKWh,
    profileObservedP75UncontrolledKWh: state.profileObservedP75UncontrolledKWh,
    profileObservedP90UncontrolledKWh: state.profileObservedP90UncontrolledKWh,
    profileObservedUncontrolledSampleCounts: state.profileObservedUncontrolledSampleCounts,
  });
  const bucketStartUtcMs = preview.buckets.startUtc.map((ts) => new Date(ts).getTime());
  const priceData: PriceData = buildPriceDebugData({
    bucketStartUtcMs,
    currentBucketIndex: preview.currentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled: settings.priceShapingEnabled,
    priceShapingFlexShare: settings.priceShapingFlexShare,
  });
  logDailyBudgetPlanDebug({
    debugStructured,
    snapshot: preview,
    priceData,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    settings,
    state,
    defaultProfile,
    variant: 'next_day',
    planDebug: {
      lockCurrentBucket: false,
      shouldLockCurrent: false,
      remainingStartIndex: 0,
      hasPreviousPlan: false,
    },
  });
}
