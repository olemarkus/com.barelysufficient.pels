/** Executor-owned convergence facts. Never sent to the settings UI. */
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

/** Complete presentation, resolved by the backend. No actuation inputs. */
export type DeviceStatus = {
  cardKind: 'binary' | 'temperature' | 'stepped';
  kind: 'active' | 'idle' | 'held' | 'resuming' | 'off' | 'manual' | 'unavailable';
  tone: 'active' | 'idle' | 'held' | 'resuming' | 'neutral' | 'warning';
  label: string;
  powerText: string | null;
  powerVariant: 'live' | 'expected' | 'reported';
  factText: string | null;
  reason: {
    text: string;
    tone?: 'neutral' | 'warning';
    detail?: string;
    countdown?: { endsAtMs: number; totalSec: number; prefix: string; suffix: string };
  } | null;
  rail: { labels: string[]; activeIndex: number | null } | null;
  limited: boolean;
  wouldLimit: boolean;
  canEaseOff: boolean;
  controlOffDrawing: boolean;
  holdCause: 'smart_task' | 'daily_budget' | null;
};
