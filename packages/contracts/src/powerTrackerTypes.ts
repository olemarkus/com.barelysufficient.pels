import type { DeviceObjectiveProfile } from './objectiveProfileTypes.js';

export type PowerTrackerMeterIdentity = {
  powerSource: 'homey_energy' | 'flow';
  meterDeviceId: string | null;
};

export type PowerTrackerState = {
  // Sub-home-only provenance for the freshness latch; absent on legacy/main trackers.
  meterIdentity?: PowerTrackerMeterIdentity;
  lastPowerW?: number;
  lastControlledPowerW?: number;
  lastUncontrolledPowerW?: number;
  lastExemptPowerW?: number;
  // Gross PV generation (W) carried by the last sample; absent when that
  // sample had no generation signal (never stale-held).
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
  // Sparse solar accounting families — present only in homes with a generation
  // signal / observed export. Hourly buckets keyed by UTC-hour ISO strings;
  // daily totals by the Homey-local calendar date. kWh only.
  generationBuckets?: Record<string, number>;
  exportBuckets?: Record<string, number>;
  generationDailyTotals?: Record<string, number>;
  exportDailyTotals?: Record<string, number>;
  unreliablePeriods?: Array<{ start: number; end: number }>;
  objectiveProfiles?: Record<string, DeviceObjectiveProfile>;
};
