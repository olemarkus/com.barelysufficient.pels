/**
 * Neutral result of materializing one complete plan.
 *
 * The planner uses this only to report rebuild outcomes; command execution and
 * device I/O remain executor-owned.
 */
export type PlanActuationResult = {
  deviceWriteCount: number;
  commandRequestCount: number;
  /**
   * Devices whose apply THREW (caught per-device; the dispatch continues).
   * Zero writes with failures is "the plan did not take effect", not "the
   * plan had nothing to do" — the silence escalation must not latch its one
   * fail-closed pass on such an outcome.
   */
  deviceApplyFailureCount: number;
  /** Devices for which this application wrote or requested a command. */
  writtenDeviceIds: string[];
};
