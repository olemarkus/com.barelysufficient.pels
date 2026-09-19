import type { DeviceObjectiveProfile } from '../objectives/types';
import type { PowerSource } from './powerSource';

/** Longest interval for which one held whole-home sample remains accounting evidence. */
export const MAX_POWER_SAMPLE_GAP_MS = 48 * 60 * 60 * 1000;

/**
 * Durable identity of the meter signal whose freshness latch is carried by a
 * sub-home tracker. Completed accounting may span identity changes, but the
 * held sample and unfinished capacity quarter may only be reused when this
 * identity matches the runtime being constructed.
 */
export type PowerTrackerMeterIdentity = {
  powerSource: PowerSource;
  meterDeviceId: string | null;
};

export type CapacityQuarter = {
  startMs: number;
  energyKWh: number;
  trackedMs: number;
};

export type CapacityMonthlyPeak = {
  monthKey: string;
  peakKw: number;
};

export type PowerTrackerState = {
  /** Sub-home-only provenance for the freshness latch; absent on legacy/main trackers. */
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
  capacityQuarter?: CapacityQuarter;
  capacityMonthlyPeak?: CapacityMonthlyPeak;
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
 * A stretch of constant gross production (W) that a production reading vouches
 * for. Structural twin of the observer's `GenerationSegment`
 * (`lib/observer/generationFreshness.ts`), which produces it: `lib/power` and
 * `lib/observer` may not import each other (`no-power-to-peer-except-objectives`,
 * `no-observer-to-peer`), so the shape is declared on both sides and the wiring
 * layer passes one into the other.
 */
export type GenerationSegment = {
  readonly startMs: number;
  readonly endMs: number;
  readonly watts: number;
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
   * finite and >= 0, absence = no generation signal for this sample (no fresh
   * reading, transient SDK failure). Feeds ONLY the `lastGenerationW` latch —
   * the live "producing now" reading; kWh accrue from `generationSegments`.
   */
  generationW?: number;
  /**
   * Gross production the readings observed, up to this sample. Generation kWh
   * accrue from these stretches, clipped to the sample interval, never from one
   * reading held across it: net can arrive sparsely (a Flow card), and a held
   * reading then mints production that never happened. Empty for a home that
   * reads no production.
   */
  generationSegments: readonly GenerationSegment[];
  controlledPowerW?: number;
  exemptPowerW?: number;
  currentDevicePowerWById?: Record<string, number>;
  nowMs?: number;
  hourBudgetKWh?: number;
  /** IANA timezone used to assign completed quarters to their local billing month. */
  timeZone: string;
  rebuildPlanFromCache: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
};
