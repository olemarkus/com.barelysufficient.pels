import type { DeviceObservation } from '../device/deviceObservation';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  type BinaryControlOutcome,
  type BinaryControlTransport,
  decideAndDispatchBinaryControl,
} from './binaryControlDispatch';
import type { PlanEngineState } from '../plan/planState';
import type { BinaryControlDecisionSnapshot } from '../plan/planBinaryControlHelpers';
import type { PlanActuationMode } from './executorTypes';
import { getLogger } from '../logging/logger';

const sharedLogger = getLogger('executor/binary');

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

/**
 * "Run on solar surplus" restore carve-out (PR-7), the SINGLE home for the
 * merge-blocking invariant: a device whose standing shed decision was the
 * baseline-off dump-load posture must NEVER be force-turned-ON when capacity
 * control is turned off (or the device unmanaged). Reads the plan-less-safe
 * `surplusOnlyShedByDevice` stamp on engine state — never the plan device — so a
 * cold/absent plan cannot bypass it. When it fires, it clears the shed
 * bookkeeping (PELS releases its claim on the device) and returns `true` so the
 * caller skips commanding ON. Both binary-restore lanes
 * (`applyUncontrolledBinaryRestore`, `applyCapacityControlOffRestoreWithSnapshot`)
 * call this so the two can never drift.
 */
export const skipRestoreForSurplusPosture = (
  ctx: Pick<PlanExecutorBinaryContext, 'state'>,
  deviceId: string,
  name: string,
): boolean => {
  if (ctx.state.surplusOnlyShedByDevice[deviceId] !== true) return false;
  sharedLogger.debug({
    event: 'restore_command_skipped',
    reasonCode: 'surplus_only_posture',
    deviceId,
    deviceName: name,
    logContext: 'capacity_control_off',
    actuationMode: 'plan',
  });
  ctx.state.clearDeviceShed(deviceId);
  ctx.state.clearShedDecision(deviceId); // clears shedDecidedMs + the surplus stamp
  return true;
};

export const runBinaryControl = async (params: {
  ctx: PlanExecutorBinaryContext;
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: BinaryControlDecisionSnapshot;
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
