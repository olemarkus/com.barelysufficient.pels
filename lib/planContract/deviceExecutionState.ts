/**
 * Executor-owned convergence facts: what the device is observed doing against
 * what PELS committed to and has in flight. The executor produces them
 * (`lib/executor/deviceExecutionState.ts`); the plan's status read model consumes
 * them to present a device. Never a decision input, and never sent to the
 * settings UI, which receives only the resolved `DeviceStatus`.
 */
export type AxisProgress = 'settled' | 'pending' | 'unmet' | 'unobserved' | 'undriven';
export type DeviceExecutionState = {
  available: boolean;
  physicalState: 'on' | 'off' | 'not_applicable';
  observedStepId: string | null;
  currentDrawKw?: number;
  desiredBinary: 'on' | 'off' | null;
  desiredStepId: string | null;
  binaryProgress: AxisProgress;
  stepProgress: AxisProgress;
  targetProgress: AxisProgress;
  /** Observed off, with a decision to resume through the binary or step axis. */
  resumeExpected: boolean;
  /** A pending binary or step command contributes to the stepped transition. */
  steppedTransitionPending: boolean;
  externalOffHeld: boolean;
};
