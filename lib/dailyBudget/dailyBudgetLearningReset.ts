import type { DailyBudgetState } from './dailyBudgetTypes';
import { emptyObservedHourlyStats } from './observedHourlyStats';

export const resetDailyBudgetLearningState = (
  state: DailyBudgetState,
  defaultProfile: number[],
): DailyBudgetState => ({
  ...state,
  profileUncontrolled: { weights: [...defaultProfile], sampleCount: 0 },
  profileControlled: { weights: [...defaultProfile], sampleCount: 0 },
  profileControlledShare: 0,
  profileSampleCount: 0,
  profileSplitSampleCount: 0,
  ...emptyObservedHourlyStats(),
  profile: undefined,
  frozen: false,
});


/** Profiles learned before this basis counted exempt load as background demand. */
export const DAILY_BUDGET_ACCOUNTING_BASIS = 'budget-counted-v1';

const DERIVED_PLAN_FIELDS = new Set([
  'plannedKWh', 'plannedUncontrolledKWh', 'plannedGrossUncontrolledKWh', 'plannedControlledKWh',
  'lastPlanBucketStartUtcMs',
]);

/**
 * Stored learning cannot be converted from averages: the exempt portion was
 * lost when each day entered them. Drop only those derived fields and the day
 * allocation built from them. The normal update rebuilds observed statistics
 * from power history and starts new running profiles; dates, usage marks and
 * applied/closed budget history survive.
 */
export const migrateDailyBudgetAccountingBasis = (state: DailyBudgetState): DailyBudgetState => {
  if (state.profileAccountingBasis === DAILY_BUDGET_ACCOUNTING_BASIS) return state;
  return {
    ...Object.fromEntries(Object.entries(state).filter(([key]) => (
      !key.startsWith('profile') && !DERIVED_PLAN_FIELDS.has(key)
    ))),
    profileAccountingBasis: DAILY_BUDGET_ACCOUNTING_BASIS,
    frozen: false,
  };
};
