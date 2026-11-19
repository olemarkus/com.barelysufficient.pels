/**
 * The seam between reading meters and the homes they belong to.
 *
 * The device transport reads whichever meters it is asked for out of one live
 * energy report (`DeviceTransport.readMeters`), knowing nothing of homes. Which
 * home a meter belongs to, and which one is Main, is `lib/home/homeMeters.ts`'s
 * answer; the whole-home poll (`lib/power/sources/homeyEnergyPoll.ts`) joins the
 * two.
 */

/**
 * A whole-home meter's cumulative import counter (`meter_power.imported`) as
 * Homey last held it: the kWh, and when the meter last changed the value. Import
 * only, never netted against export. Whether a step between two of these is
 * energy PELS may book is `lib/power/importCounter.ts`'s answer.
 */
export type MeterImportCounter = {
  readonly meterDeviceId: string;
  /** kWh; finite and not negative. */
  readonly importedKWh: number;
  /** When the meter last changed the value (Homey's `lastUpdated`). */
  readonly observedAtMs: number;
};

/** One live read of the requested meters. */
export type LiveMeterReadings = {
  /**
   * One entry per requested meter that produced a FINITE reading; a requested
   * meter with none is simply not a key.
   */
  readonly meterPowerW: Readonly<Record<string, number>>;
  /** Gross PV generation from the same report, when it carries one. */
  readonly generationW?: number;
  /**
   * The import counter of each requested meter that reports a usable one, by
   * meter device id. Left out when none does: a meter without the counter, and
   * a read of it that failed, are the same to the consumer, which keeps the
   * counter it last accepted.
   */
  readonly importCounters?: Readonly<Record<string, MeterImportCounter>>;
};

/** One whole-home power sample, carrying the meter it was read from. */
export type MeterPowerSample = {
  powerW: number;
  generationW?: number;
  /**
   * The meter `powerW` was read from, stamped where the sample is built. A
   * consumer that records the sample hands the identity to the ingest seam;
   * one that discards it discards the identity with it.
   */
  meterDeviceId: string;
  /** That meter's import counter, read beside the power; absent when the read carried none. */
  importCounter?: MeterImportCounter;
};

/**
 * One poll's meters, captured once, and where each reading goes. Recording only
 * after the poll is known current is what lets a poll be discarded as a unit:
 * every home's reading, or none.
 */
export type HomeMeterRequest = {
  readonly meterDeviceIds: readonly string[];
  record(readings: LiveMeterReadings): Promise<void>;
};

/**
 * Main's part of a meter read (`resolveMainMeterRead`, `lib/home/homeMeters.ts`):
 * which meter to request for the selection, and the whole-home sample the
 * readings make, null when they make none.
 */
export type MainMeterRead = {
  readonly meterDeviceIds: readonly string[];
  sampleFrom(readings: LiveMeterReadings): MeterPowerSample | null;
};

export type PhaseTriple = readonly [number, number, number];

/**
 * One read of the whole-home meter's per-phase capabilities. `none` is a meter
 * with no usable phase capabilities, `unavailable` a read that failed. A facet
 * is present only when all three of its phases read as finite numbers.
 */
export type MeterPhasesRead =
  | { readonly state: 'unavailable' }
  | { readonly state: 'none'; readonly capabilityIds: readonly string[] }
  | {
    readonly state: 'read';
    readonly capabilityIds: readonly string[];
    /** Signed per-phase power, W; positive is import. */
    readonly powerW?: PhaseTriple;
    readonly currentA?: PhaseTriple;
    readonly voltageV?: PhaseTriple;
  };

/**
 * One read of the month peak a whole-home meter reports itself: the highest
 * 15-minute average import of the current month as the meter counts it, which
 * is what a grid operator bills from such a meter. Which capability holds it is
 * the meter integration's answer (`DeviceAdapter.meterMonthlyPeak`).
 *
 * - `none`: the meter reports no month peak.
 * - `unavailable`: the read failed, or the meter's value was malformed or
 *   undated. Not zero: the last accepted value stands.
 * - `read`: the peak in kW and when the meter last changed it (Homey's
 *   `lastUpdated`), which says which month it belongs to.
 */
export type MeterMonthlyPeakRead =
  | { readonly state: 'none' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'read'; readonly peakKw: number; readonly observedAtMs: number };
