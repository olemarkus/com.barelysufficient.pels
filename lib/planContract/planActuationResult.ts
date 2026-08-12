/**
 * Neutral result of materializing one complete plan.
 *
 * The planner uses this only to report rebuild outcomes; command execution and
 * device I/O remain executor-owned.
 */
export type PlanActuationResult = {
  deviceWriteCount: number;
  commandRequestCount: number;
  /** Devices for which this application wrote or requested a command. */
  writtenDeviceIds: string[];
};
