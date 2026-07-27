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
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';

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

/**
 * "Leave off until turned on again" restore carve-out — the defensive twin of
 * {@link skipRestoreForSurplusPosture}. A device the user turned off outside
 * PELS must never be commanded back ON: not by a plan built before the hold
 * existed, not by the capacity-control-off force-ON lane, and not by a smart
 * task's deferred restore.
 *
 * Reads the plan-less-safe flat getter on engine state, never the plan device,
 * so a cold/absent/stale plan cannot bypass it. That getter applies the SAME
 * resolution as the producer (hold AND still observed off), so this can never
 * refuse a resume the planner thinks is fine. Unlike the surplus stamp it is
 * persistence-backed, so the guard also holds across a restart.
 *
 * Deliberately does NOT clear the shed bookkeeping: PELS never shed this device,
 * so there is no claim to release — it is off because the user turned it off.
 */
export const skipRestoreForExternalOffHold = (
  ctx: Pick<PlanExecutorBinaryContext, 'state'>,
  deviceId: string,
  name: string,
): boolean => {
  if (ctx.state.isExternalOffHeld?.(deviceId) !== true) return false;
  sharedLogger.debug({
    event: 'restore_command_skipped',
    reasonCode: PLAN_REASON_CODES.externalOffHold,
    deviceId,
    deviceName: name,
  });
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
