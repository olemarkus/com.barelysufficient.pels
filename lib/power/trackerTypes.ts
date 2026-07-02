import type CapacityGuard from './capacityGuard';
import type { DeviceObjectiveProfile } from '../objectives/types';

export type PowerTrackerState = {
  lastPowerW?: number;
  lastControlledPowerW?: number;
  lastUncontrolledPowerW?: number;
  lastExemptPowerW?: number;
  /**
   * Gross PV generation (W) carried by the LAST sample, present only when that
   * sample carried a finite generation reading. A generation-less sample drops
   * the field (absence as absence — never stale-held), so generation accrual
   * only ever integrates between two generation-carrying samples.
   */
  lastGenerationW?: number;
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
  deviceBuckets?: Record<string, Record<string, number>>;
  lastDevicePowerWById?: Record<string, number>;
  // Solar accounting families (sparse — only ever written in homes with a
  // generation signal / observed export, so a non-solar home's persisted state
  // stays deep-equal with the pre-solar shape). Hourly buckets are keyed by
  // UTC-hour ISO strings like `buckets`; daily totals by the Homey-local
  // calendar date via the prune fold. kWh only — money is derived read-side.
  generationBuckets?: Record<string, number>;
  exportBuckets?: Record<string, number>;
  generationDailyTotals?: Record<string, number>;
  exportDailyTotals?: Record<string, number>;
  unreliablePeriods?: Array<{ start: number; end: number }>;
  objectiveProfiles?: Record<string, DeviceObjectiveProfile>;
};

export type RecordPowerSampleParams = {
  state: PowerTrackerState;
  currentPowerW: number;
  /**
   * Authoritative whole-home actual consumption (W) = net grid import + gross
   * generation. Feeds ONLY the managed/unmanaged split (controlled/uncontrolled
   * bound + residual); the total energy bucket and the capacity guard stay on
   * `currentPowerW` (net import). Defaults to `currentPowerW` when omitted, so
   * callers without a generation signal keep the prior net-only behaviour.
   */
  grossConsumptionW?: number;
  /**
   * Gross PV generation (W) co-sampled with `currentPowerW`. Producer-resolved:
   * finite and >= 0, absence = no generation signal for this sample (flow
   * source, transient SDK failure). Feeds ONLY the sparse solar accounting
   * families (`generationBuckets` accrual + the `lastGenerationW` latch);
   * capacity/budget/billed buckets never read it.
   */
  generationW?: number;
  controlledPowerW?: number;
  exemptPowerW?: number;
  currentDevicePowerWById?: Record<string, number>;
  nowMs?: number;
  capacityGuard?: CapacityGuard;
  hourBudgetKWh?: number;
  rebuildPlanFromCache: (reason?: string) => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
};
