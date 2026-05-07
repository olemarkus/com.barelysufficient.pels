import type CapacityGuard from './capacityGuard';
import type { DeviceObjectiveProfile } from './objectiveProfileTypes';

export type PowerTrackerState = {
  lastPowerW?: number;
  lastControlledPowerW?: number;
  lastUncontrolledPowerW?: number;
  lastExemptPowerW?: number;
  lastTimestamp?: number;
  buckets?: Record<string, number>;
  hourlySampleCounts?: Record<string, number>;
  hourlyBudgets?: Record<string, number>;
  dailyBudgetCaps?: Record<string, number>;
  dailyTotals?: Record<string, number>;
  hourlyAverages?: Record<string, { sum: number; count: number }>;
  controlledBuckets?: Record<string, number>;
  uncontrolledBuckets?: Record<string, number>;
  exemptBuckets?: Record<string, number>;
  controlledDailyTotals?: Record<string, number>;
  uncontrolledDailyTotals?: Record<string, number>;
  exemptDailyTotals?: Record<string, number>;
  controlledHourlyAverages?: Record<string, { sum: number; count: number }>;
  uncontrolledHourlyAverages?: Record<string, { sum: number; count: number }>;
  exemptHourlyAverages?: Record<string, { sum: number; count: number }>;
  unreliablePeriods?: Array<{ start: number; end: number }>;
  objectiveProfiles?: Record<string, DeviceObjectiveProfile>;
};

export type RecordPowerSampleParams = {
  state: PowerTrackerState;
  currentPowerW: number;
  controlledPowerW?: number;
  exemptPowerW?: number;
  nowMs?: number;
  capacityGuard?: CapacityGuard;
  hourBudgetKWh?: number;
  rebuildPlanFromCache: (reason?: string) => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
};
