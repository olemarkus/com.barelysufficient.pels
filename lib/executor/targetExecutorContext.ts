import type { PendingTargetObservationSource } from '../plan/planTypes';
import type { PendingTargetCommandState } from '../plan/planState';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Actuator } from '../actuator/deviceActuator';
import type {
  TargetCommandClaim,
  TargetCommandClaimState,
  TargetCommandOwner,
} from './targetCommandClaim';

export type PlanExecutorTargetContext = {
  state: {
    pendingTargetCommands: Record<string, PendingTargetCommandState>;
    deletePendingTargetCommand: (deviceId: string) => void;
  };
  /**
   * Observed-state read seam (stage 5): the target executor reads observed
   * capability values (`targets`) from the observer projection rather than the
   * raw transport snapshot. Narrowed to the only field it consumes. `undefined`
   * before the first observation for the device lands.
   */
  getObservedTemperatureValue: (deviceId: string) => unknown;
  /**
   * Executor-owned lifecycle fallback has claimed this command from the
   * ordinary plan state. A matching ordinary dispatch must stand down even
   * after plan maintenance prunes its own pending map.
   */
  getLifecycleOwnedPendingTargetCommand?: (deviceId: string) => PendingTargetCommandState | undefined;
  isLifecycleFallbackActive?: (deviceId: string) => boolean;
  /** Shared synchronous claim closing the pre-pending async dispatch race. */
  targetCommandClaim: TargetCommandClaim;
  targetCommandOwner: TargetCommandOwner;
  /** Prevents late actuator completion from reinstalling state after authority ended. */
  isTargetCommandAuthorityCurrent?: () => boolean;
  /** Lifecycle-only retry scheduled when an already-running ordinary write releases its claim. */
  onTargetCommandClaimReleased?: (released: TargetCommandClaimState) => void;
  /**
   * Single write seam: the setpoint write routes through here
   * (`actuator.apply({ kind: 'target', ... })`).
   */
  actuator: Actuator;
  operatingMode: string;
  syncLivePlanStateAfterTargetActuation?: (source: PendingTargetObservationSource) => boolean | void;
  logTargetRetryComparison?: (params: {
    deviceId: string;
    name: string;
    target: 'temperature';
    desired: number;
    observedValue?: unknown;
    observedSource?: string;
    retryCount: number;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  }) => Promise<void> | void;
  recordShedActuation: (deviceId: string, name: string, now: number) => void;
  recordRestoreActuation: (deviceId: string, name: string, now: number) => void;
  recordActivationAttemptStarted: (deviceId: string, name: string, now: number) => void;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
};
