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
