import type { BinaryControlTransport } from './binaryControlDispatch';
import type { DeviceObservation } from '../device/deviceObservation';
import type { PlanEngineState } from '../plan/planState';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { SteppedLoadStepRequestResult } from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';

export type PlanExecutorSteppedContext = {
  state: PlanEngineState;
  observation: DeviceObservation;
  buildBinaryControlTransport: () => BinaryControlTransport;
  requestSteppedLoadStep: (params: {
    deviceId: string;
    profile: SteppedLoadProfile;
    desiredStepId: string;
    planningPowerW: number;
    planningCurrentA: number;
    previousStepId?: string;
  }) => Promise<SteppedLoadStepRequestResult>;
  markSteppedLoadDesiredStepIssued: (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
    confirmationPolicy?: 'required' | 'assume_applied';
  }) => void;
  recordShedActuation: (deviceId: string, name: string, now: number) => void;
  recordRestoreActuation: (deviceId: string, name: string, now: number) => void;
  getRestoreLogSource: (deviceId: string) => 'shed_state' | 'current_plan';
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
};
