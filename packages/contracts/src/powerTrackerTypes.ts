export type PowerTrackerState = {
  lastPowerW?: number;
  lastControlledPowerW?: number;
  lastUncontrolledPowerW?: number;
  lastTimestamp?: number;
  buckets?: Record<string, number>;
  hourlyBudgets?: Record<string, number>;
  dailyBudgetCaps?: Record<string, number>;
  dailyTotals?: Record<string, number>;
  hourlyAverages?: Record<string, { sum: number; count: number }>;
  controlledBuckets?: Record<string, number>;
  uncontrolledBuckets?: Record<string, number>;
  controlledDailyTotals?: Record<string, number>;
  uncontrolledDailyTotals?: Record<string, number>;
  controlledHourlyAverages?: Record<string, { sum: number; count: number }>;
  uncontrolledHourlyAverages?: Record<string, { sum: number; count: number }>;
  unreliablePeriods?: Array<{ start: number; end: number }>;
};
