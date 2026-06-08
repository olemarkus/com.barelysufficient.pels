import type { DeviceObservation } from '../device/deviceObservation';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  type BinaryControlOutcome,
  type BinaryControlTransport,
  decideAndDispatchBinaryControl,
} from './binaryControlDispatch';
import type { PlanEngineState } from '../plan/planState';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PlanActuationMode } from './executorTypes';

export type PlanExecutorBinaryContext = {
  state: PlanEngineState;
  observation: DeviceObservation;
  capacityDryRun: boolean;
  buildBinaryControlTransport: () => BinaryControlTransport;
  getRestoreLogSource: (deviceId: string) => 'shed_state' | 'current_plan';
  recordShedActuation: (deviceId: string, name: string, now: number) => void;
  // Diagnostic-only recorder for the smart-task lifecycle-end disable path: records
  // the pels_shed diagnostic + closes the activation attempt WITHOUT stamping the
  // capacity cooldown markers (a lifecycle disable is not capacity pressure).
  recordReleaseShedActuation: (deviceId: string, name: string, now: number) => void;
  recordRestoreActuation: (deviceId: string, name: string, now: number) => void;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
};

export const runBinaryControl = async (params: {
  ctx: PlanExecutorBinaryContext;
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: TargetDeviceSnapshot;
  logContext: 'capacity' | 'capacity_control_off';
  restoreSource?: 'shed_state' | 'current_plan';
  reason?: string;
  actuationMode?: PlanActuationMode;
  lifecycleRelease?: boolean;
}): Promise<BinaryControlOutcome> => {
  const {
    ctx, deviceId, name, desired, snapshot, logContext, restoreSource, reason, actuationMode,
    lifecycleRelease,
  } = params;
  return decideAndDispatchBinaryControl({
    transport: ctx.buildBinaryControlTransport(),
    deviceId,
    name,
    desired,
    snapshot,
    logContext,
    restoreSource,
    reason,
    actuationMode,
    lifecycleRelease,
  });
};
