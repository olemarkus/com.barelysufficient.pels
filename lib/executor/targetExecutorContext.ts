import type { ObservedDeviceState } from '../../packages/contracts/src/types';
import type { PendingTargetObservationSource } from '../plan/planTypes';
import type { PlanEngineState } from '../plan/planState';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Actuator } from '../actuator/deviceActuator';

export type PlanExecutorTargetContext = {
  state: PlanEngineState;
  /**
   * Observed-state read seam (stage 5): the target executor reads observed
   * capability values (`targets`) from the observer projection rather than the
   * raw transport snapshot. Narrowed to the only field it consumes. `undefined`
   * before the first observation for the device lands.
   */
  getObservedState: (deviceId: string) => Pick<ObservedDeviceState, 'targets'> | undefined;
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
    targetCap: string;
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
