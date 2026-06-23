import type { DailyBudgetState } from './dailyBudgetTypes';

const emptyHourly = (): number[] => Array.from({ length: 24 }, () => 0);

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
  profileObservedMaxUncontrolledKWh: emptyHourly(),
  profileObservedMaxControlledKWh: emptyHourly(),
  profileObservedMinUncontrolledKWh: emptyHourly(),
  profileObservedMinControlledKWh: emptyHourly(),
  profileObservedP50UncontrolledKWh: emptyHourly(),
  profileObservedP75UncontrolledKWh: emptyHourly(),
  profileObservedP90UncontrolledKWh: emptyHourly(),
  profileObservedUncontrolledSampleCounts: emptyHourly(),
  profileObservedP50GrossUncontrolledKWh: emptyHourly(),
  profileObservedP75GrossUncontrolledKWh: emptyHourly(),
  profileObservedP90GrossUncontrolledKWh: emptyHourly(),
  profileObservedGrossUncontrolledSampleCounts: emptyHourly(),
  profile: undefined,
  frozen: false,
});
