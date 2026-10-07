import type { DeviceObjectiveProfile, ObjectiveProfileStat } from './objectiveProfileTypes.js';

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

/**
 * The learned profile as the smart-task page reads it: the energy-per-unit
 * mean (an old plan revision's fallback) and its confidence. The sample
 * buffer, bands and accumulators stay in the app.
 */
export type SettingsUiObjectiveProfile = {
  kwhPerUnit?: Pick<ObjectiveProfileStat, 'mean' | 'confidence'>;
};

/**
 * The usage history the settings WebView draws, and nothing else. A physical
 * projection of `PowerTrackerState` (`lib/power/trackerUiProjection.ts`), not
 * a type narrowing: the full tracker is 30 days of hourly families for every
 * tracked device (~640 kB on a 14-device home) and the page refetches it every
 * 30 s while open, so what is not read must not be serialised.
 *
 * Windows: `buckets`, sample counts, the solar families and the averages keep
 * their full retention (the week heatmap's colour range, the typical-day
 * pattern and the "any export ever" gates read all of it). The
 * controlled/uncontrolled split is read for today and yesterday only;
 * `deviceBuckets` for the one device with an open smart task over its plan
 * window. Both are cut to the last `SETTINGS_UI_RECENT_HOURS` hours
 * (`lib/power/trackerUiProjection.ts`).
 */
export type SettingsUiPowerTracker = Pick<PowerTrackerState,
  | 'lastPowerW'
  | 'lastGenerationW'
  | 'lastTimestamp'
  | 'buckets'
  | 'hourlySampleCounts'
  | 'unreliablePeriods'
  | 'controlledBuckets'
  | 'uncontrolledBuckets'
  | 'dailyTotals'
  | 'hourlyAverages'
  | 'generationBuckets'
  | 'exportBuckets'
  | 'exportDailyTotals'
  | 'deviceBuckets'
> & {
  objectiveProfiles?: Record<string, SettingsUiObjectiveProfile>;
};
