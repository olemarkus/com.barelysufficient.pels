/**
 * Where the battery owner keeps its accepted round-trip efficiency results.
 * lib/battery is a leaf domain and cannot open the userdata database itself;
 * setup builds the row-table implementation
 * (`setup/appInit/batteryMeterLearning.ts`) and passes it in.
 */

/** Accepted cycle results per battery, oldest first. */
export type BatteryEfficiencyCycles = ReadonlyMap<string, readonly number[]>;

export type BatteryEfficiencyStore = {
  /** What the store holds; no batteries when it holds none. Throws only on I/O. */
  read(): BatteryEfficiencyCycles;
  /** Persist `cycles`, touching only the batteries that differ. Throws only on I/O. */
  write(cycles: BatteryEfficiencyCycles): void;
};
