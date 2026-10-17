/**
 * The seam between reading meters and the homes they belong to.
 *
 * The device transport reads whichever meters it is asked for out of one live
 * energy report (`DeviceTransport.readMeters`), knowing nothing of homes. Which
 * home a meter belongs to, and which one is Main, is `lib/home/homeMeters.ts`'s
 * answer; the whole-home poll (`lib/power/sources/homeyEnergyPoll.ts`) joins the
 * two.
 */

/** One live read of the requested meters. */
export type LiveMeterReadings = {
  /**
   * One entry per requested meter that produced a FINITE reading; a requested
   * meter with none is simply not a key.
   */
  readonly meterPowerW: Readonly<Record<string, number>>;
  /** Gross PV generation from the same report, when it carries one. */
  readonly generationW?: number;
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
