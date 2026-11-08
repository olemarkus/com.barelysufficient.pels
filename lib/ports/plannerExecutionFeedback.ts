export type KeepInvariantShedBlock = { desiredStepId: string; lowestNonZeroStepId: string };

/** Planner-owned consequences of completed execution. No planner state escapes this port. */
export type PlannerExecutionFeedback = {
  isStandingShed(deviceId: string): boolean;
  isExternalOffHeld(deviceId: string): boolean;
  getRestoreCooldownMs(): number;
  getKeepInvariantShedBlock(deviceId: string): KeepInvariantShedBlock | undefined;
  setKeepInvariantShedBlock(deviceId: string, block: KeepInvariantShedBlock): void;
  clearKeepInvariantShedBlock(deviceId: string): void;
  noteInstability(nowMs: number): void;
  noteShedReleased(deviceId: string): void;
  recordActivationAttemptStarted(deviceId: string, name: string, nowMs: number): void;
  closeActivationAttemptForShed(deviceId: string, name: string, nowMs: number): void;
};
