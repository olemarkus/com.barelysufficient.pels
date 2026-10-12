import type { DeviceObjectiveProfile } from './objectiveProfileTypes.js';

/**
 * Durable identity of the meter signal whose freshness latch is carried by a
 * sub-home tracker. Completed accounting may span identity changes, but the
 * held sample and unfinished capacity quarter may only be reused when this
 * identity matches the runtime being constructed.
 */
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
 * (`lib/power/trackerUiProjection.ts`). The learned objective profiles stay in
 * the app: a smart task's page reads the rate and confidence its plan was
 * built with off the plan itself.
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
>;
