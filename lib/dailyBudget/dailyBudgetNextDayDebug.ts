import { getNextLocalDayStartUtcMs } from '../utils/dateUtils';
import { buildPriceDebugData, type CombinedPriceData } from './dailyBudgetMath';
import { buildDailyBudgetPreview } from './dailyBudgetPreview';
import type { DayContext, PriceData } from './dailyBudgetState';
import type { DailyBudgetSettings, DailyBudgetState } from './dailyBudgetTypes';
import { logDailyBudgetPlanDebug } from './dailyBudgetManagerPlan';
import { getEffectiveProfileData, getProfileSplitSampleCount } from './dailyBudgetProfile';

const isEnabled = (settings: DailyBudgetSettings): boolean => (
  settings.enabled && settings.dailyBudgetKWh > 0
);

export function logNextDayPlanDebug(params: {
  logDebug: (...args: unknown[]) => void;
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
    logDebug,
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
    logDebug,
    snapshot: preview,
    priceData,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    settings,
    state,
    defaultProfile,
    label: 'Daily budget: plan debug (next day)',
    planDebug: {
      lockCurrentBucket: false,
      shouldLockCurrent: false,
      remainingStartIndex: 0,
      hasPreviousPlan: false,
    },
  });
}
