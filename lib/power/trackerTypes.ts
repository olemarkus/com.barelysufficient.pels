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

/**
 * The home's measured load at one sample, and which loads it sums: every
 * device whose reading is its own direct measurement, and none at all while a
 * battery or a producing PV inverter may be covering a load's move and holding
 * the grid reading still (`resolveManagedLoadDraw`, `sampleIngest.ts`).
 * Unclamped by the whole-home total, so a meter frozen at 1.1 kW cannot hide a
 * 3 kW heater.
 */
export type ManagedLoadDraw = {
  /** W; `0` when no load is measured. */
  totalW: number;
  /**
   * A key over the summed loads' ids, equal exactly when the set is: two draws
   * are comparable only over the same loads, so a device joining the sum (the
   * snapshot loading after a restart, say) is not read as load moving.
   */
  loadKey: number;
};

/** See `PowerTrackerState.heldReading` and `lib/power/heldReading.ts`. */
export type HeldReading = {
  /** The watts held: the latch's `lastPowerW`. */
  powerW: number;
  /** When the reading took this value. */
  sinceMs: number;
  /** The sample this hold describes: the latch's `lastTimestamp` when it was written. */
  atMs: number;
  /**
   * The measured load the reading is held against. It follows the load
   * through the settle window after the reading took its value, while the
   * meter is one seen to hold values of its own accord, and whenever the
   * loads summed change.
   */
  baseline: ManagedLoadDraw;
  /**
   * The first of the unbroken run of samples, up to `atMs`, whose load sat far
   * enough from the baseline that the reading should have followed; `null`
   * while the latest did not. Once the run has lasted long enough to freeze
   * the reading it no longer ends: the hold carries until the watts change.
   */
  contradictedAtMs: number | null;
  /**
   * When one of this meter's holds last ended clean after lasting as long as
   * it takes to freeze a reading, or `null` if none has: a meter seen holding
   * a value that long, and moving on, reports only on change, and for a day
   * its holds are not judged.
   */
  longHoldEndedAtMs: number | null;
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
  /**
   * The whole-home reading as it has held since it last changed, and whether
   * the home's measured load has since said it should have moved. What makes a
   * reading that stopped changing a suspect or dead meter rather than a quiet
   * home is `lib/power/heldReading.ts`'s rule. Written with `lastTimestamp` on
   * every sample and cleared with it on a freshness reset.
   */
  heldReading?: HeldReading;
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
  /** The evidence a held reading is checked against (`lib/power/heldReading.ts`). */
  managedDraw: ManagedLoadDraw;
  nowMs?: number;
  hourBudgetKWh?: number;
  /** IANA timezone used to assign completed quarters to their local billing month. */
  timeZone: string;
  rebuildPlanFromCache: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
};
