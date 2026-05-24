import type { DeviceObservation } from '../device/deviceObservation';
import type { PlanEngineState } from '../plan/planState';
import {
  type BinaryControlActuationMode,
  type BinaryControlDecision,
  type BinaryControlLogContext,
  type BinaryControlRestoreSource,
  buildBinaryControlLogMessage,
  buildEvBinaryControlLogMessage,
  buildFlowBackedBinaryControlRequestLogMessage,
  buildFlowBackedEvBinaryControlRequestLogMessage,
  formatEvSnapshot,
} from '../plan/planBinaryControlHelpers';
import { decideBinaryControl } from '../plan/planBinaryControl';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { getLogger } from '../logging/logger';

/**
 * Transport seam for binary-control dispatch. Executor talks to this
 * (an interface implementing the two writeable seams) rather than
 * importing `DeviceManager` directly. Today the same concrete object
 * services both reads (`DeviceObservation`) and writes — once PR #2/PR
 * #3 split the class, this shape stays put and only the implementer
 * changes.
 */
export type BinaryControlTransport = {
  observation: DeviceObservation;
  setCapability: (deviceId: string, capabilityId: string, value: boolean) => Promise<unknown>;
  triggerFlowBackedBinaryControlRequest?: (params: {
    deviceId: string;
    name: string;
    capabilityId: 'onoff' | 'evcharger_charging';
    desired: boolean;
    logContext: BinaryControlLogContext;
    actuationMode: BinaryControlActuationMode;
  }) => Promise<void>;
};

const logger = getLogger('executor/binary-dispatch');

/**
 * Convenience wrapper: ask the plan layer to decide (reading state via the
 * transport's bound `observation`) and, if it returns a decision, dispatch
 * it via the same transport. Returns `true` when the underlying dispatch
 * succeeded; `false` when the plan skipped or the dispatch failed.
 *
 * The decide-and-dispatch pair must share one observation source to avoid
 * deciding against one snapshot and logging against another; that's why the
 * wrapper sources both from `transport.observation` rather than accepting a
 * second `DeviceObservation` parameter.
 */
export async function decideAndDispatchBinaryControl(params: {
  state: PlanEngineState;
  transport: BinaryControlTransport;
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: TargetDeviceSnapshot;
  logContext: BinaryControlLogContext;
  restoreSource?: BinaryControlRestoreSource;
  reason?: string;
  actuationMode?: BinaryControlActuationMode;
}): Promise<boolean> {
  const {
    state, transport, deviceId, name, desired, snapshot, logContext,
    restoreSource, reason, actuationMode,
  } = params;
  const decision = decideBinaryControl({
    state,
    deviceObservation: transport.observation,
    deviceId,
    name,
    desired,
    snapshot,
    logContext,
    restoreSource,
    reason,
    actuationMode,
  });
  if (!decision) return false;
  return dispatchBinaryControlDecision({ decision, transport, state });
}

/**
 * Dispatch a decision produced by the plan layer. On failure, clears the
 * pre-recorded `pendingBinaryCommands` entry so subsequent cycles can
 * retry; on success leaves the pending entry intact for
 * `syncPendingBinaryCommands` to clear once telemetry confirms.
 */
export async function dispatchBinaryControlDecision(params: {
  decision: BinaryControlDecision;
  transport: BinaryControlTransport;
  state: PlanEngineState;
}): Promise<boolean> {
  const { decision, transport, state } = params;
  try {
    await dispatchBinaryCommand({
      decision,
      transport,
    });
    emitBinaryCommandSuccess({
      decision,
      observation: transport.observation,
    });
    return true;
  } catch (caughtError) {
    // Mirror the pre-split behaviour: failed dispatch clears the pending
    // entry the plan recorded before handing the decision over.
    // eslint-disable-next-line functional/immutable-data -- shared executor state cleanup
    delete state.pendingBinaryCommands[decision.deviceId];
    emitBinaryCommandFailure({
      decision,
      err: caughtError,
    });
    return false;
  }
}

async function dispatchBinaryCommand(params: {
  decision: BinaryControlDecision;
  transport: BinaryControlTransport;
}): Promise<void> {
  const { decision, transport } = params;
  if (decision.flowBackedControl) {
    await requestFlowBackedBinaryControl({
      triggerFlowBackedBinaryControlRequest: transport.triggerFlowBackedBinaryControlRequest,
      deviceId: decision.deviceId,
      name: decision.name,
      capabilityId: decision.capabilityId,
      desired: decision.desired,
      logContext: decision.logContext,
      actuationMode: decision.actuationMode,
    });
    return;
  }
  await transport.setCapability(decision.deviceId, decision.capabilityId, decision.desired);
}

async function requestFlowBackedBinaryControl(params: {
  triggerFlowBackedBinaryControlRequest?: BinaryControlTransport['triggerFlowBackedBinaryControlRequest'];
  deviceId: string;
  name: string;
  capabilityId: 'onoff' | 'evcharger_charging';
  desired: boolean;
  logContext: BinaryControlLogContext;
  actuationMode: BinaryControlActuationMode;
}): Promise<void> {
  const {
    triggerFlowBackedBinaryControlRequest,
    deviceId,
    name,
    capabilityId,
    desired,
    logContext,
    actuationMode,
  } = params;
  if (!triggerFlowBackedBinaryControlRequest) {
    throw new Error(`Flow-backed control trigger is unavailable for ${capabilityId}`);
  }
  await triggerFlowBackedBinaryControlRequest({
    deviceId,
    name,
    capabilityId,
    desired,
    logContext,
    actuationMode,
  });
  logger.info({
    event: 'flow_backed_binary_command_requested',
    deviceId,
    deviceName: name,
    capabilityId,
    desired,
    logContext,
    actuationMode,
  });
}

function emitBinaryCommandSuccess(params: {
  decision: BinaryControlDecision;
  observation: DeviceObservation;
}): void {
  const { decision, observation } = params;
  logger.info({
    event: decision.flowBackedControl ? 'flow_backed_binary_command_succeeded' : 'binary_command_succeeded',
    deviceId: decision.deviceId,
    deviceName: decision.name,
    capabilityId: decision.capabilityId,
    desired: decision.desired,
    logContext: decision.logContext,
    actuationMode: decision.actuationMode,
    ...(decision.restoreSource ? { restoreSource: decision.restoreSource } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    msg: buildBinaryControlSuccessLogMessage({
      isEv: decision.isEv,
      logContext: decision.logContext,
      desired: decision.desired,
      name: decision.name,
      reason: decision.reason,
      restoreSource: decision.restoreSource,
      actuationMode: decision.actuationMode,
      flowBackedControl: decision.flowBackedControl,
    }),
  });
  if (!decision.isEv) return;
  logger.debug({
    event: decision.flowBackedControl ? 'ev_action_requested_via_flow' : 'ev_action_completed',
    deviceId: decision.deviceId,
    deviceName: decision.name,
    capabilityId: decision.capabilityId,
    desired: decision.desired,
    evSnapshot: formatEvSnapshot(observation.getSnapshotByDeviceId(decision.deviceId)),
  });
}

function emitBinaryCommandFailure(params: {
  decision: BinaryControlDecision;
  err: unknown;
}): void {
  const { decision, err } = params;
  logger.error({
    event: decision.flowBackedControl ? 'flow_backed_binary_command_failed' : 'binary_command_failed',
    reasonCode: decision.flowBackedControl ? 'flow_trigger_failed' : 'device_manager_write_failed',
    deviceId: decision.deviceId,
    deviceName: decision.name,
    desired: decision.desired,
    capabilityId: decision.capabilityId,
    logContext: decision.logContext,
    actuationMode: decision.actuationMode,
    ...(decision.restoreSource ? { restoreSource: decision.restoreSource } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    err,
    msg: buildBinaryControlFailureLogMessage({
      isEv: decision.isEv,
      desired: decision.desired,
      name: decision.name,
      flowBackedControl: decision.flowBackedControl,
    }),
  });
}

function buildBinaryControlSuccessLogMessage(params: {
  isEv: boolean;
  logContext: BinaryControlLogContext;
  desired: boolean;
  name: string;
  reason?: string;
  restoreSource?: BinaryControlRestoreSource;
  actuationMode: BinaryControlActuationMode;
  flowBackedControl: boolean;
}): string {
  const {
    isEv,
    logContext,
    desired,
    name,
    reason,
    restoreSource,
    actuationMode,
    flowBackedControl,
  } = params;
  if (flowBackedControl) {
    return isEv
      ? buildFlowBackedEvBinaryControlRequestLogMessage(logContext, desired, name, reason, actuationMode)
      : buildFlowBackedBinaryControlRequestLogMessage({
        logContext,
        desired,
        name,
        reason,
        restoreSource,
        actuationMode,
      });
  }
  return isEv
    ? buildEvBinaryControlLogMessage(logContext, desired, name, reason, actuationMode)
    : buildBinaryControlLogMessage({ logContext, desired, name, reason, restoreSource, actuationMode });
}

function buildBinaryControlFailureLogMessage(params: {
  isEv: boolean;
  desired: boolean;
  name: string;
  flowBackedControl: boolean;
}): string {
  const { isEv, desired, name, flowBackedControl } = params;
  const verb = isEv
    ? `${desired ? 'resume' : 'pause'} EV charging for`
    : `${desired ? 'turn on' : 'turn off'}`;
  return flowBackedControl
    ? `Failed to request ${verb} ${name} via flow`
    : `Failed to ${verb} ${name} via DeviceManager`;
}
