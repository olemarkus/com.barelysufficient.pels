import type { DeviceObservation } from '../device/deviceObservation';
import {
  type BinaryControlActuationMode,
  type BinaryControlDecision,
  type BinaryControlDecisionSnapshot,
  type BinaryControlLogContext,
  type BinaryControlRestoreSource,
  buildBinaryControlLogMessage,
  buildFlowBackedBinaryControlRequestLogMessage,
} from '../plan/planBinaryControlHelpers';
import { decideBinaryControl } from '../plan/planBinaryControl';
import { resolveBinaryCommandPendingMs } from '../observer/pendingBinaryCommandTypes';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import type { Actuator } from '../actuator/deviceActuator';
import { getLogger } from '../logging/logger';

/**
 * Discriminated dispatch outcome. `decideAndDispatchBinaryControl`
 * collapses this to a boolean for callers that don't distinguish
 * "plan skipped" from "dispatch failed".
 */
export type DispatchBinaryControlResult =
  | { ok: true }
  | { ok: false; reason: 'dispatch_failed' };

/**
 * Outcome of a decide-and-dispatch call, surfaced to executor callers.
 *
 * `flowBacked` carries the producer-resolved routing decision
 * (`BinaryControlDecision.flowBackedControl`) outward so post-write recording
 * sites never re-derive it from the snapshot. This is what seals the
 * flow-vs-native transport detail behind this seam: the executor records
 * direct actuation only when a real capability write happened
 * (`applied && !flowBacked`); a flow trigger leaves no direct write to record.
 */
export type BinaryControlOutcome =
  | { applied: false }
  | { applied: true; flowBacked: boolean };

/**
 * Transport seam for binary-control dispatch. Executor talks to this
 * (an interface implementing the two writeable seams) rather than
 * importing `DeviceTransport` directly. Today the same concrete object
 * services both reads (`DeviceObservation`) and writes — PRs #2 and #3
 * of the observer/transport split established this shape; only the
 * implementer changed when `DeviceManager` was renamed to
 * `DeviceTransport` in PR #3.
 *
 * Carries the observer-owned `pendingBinaryCommandStore` so the
 * dispatcher can record pending entries on every issued command and
 * clear them when dispatch throws. Per PR #4 of the split, the plan
 * layer no longer touches pending state directly; writes and deletes
 * are both observer-owned (recorded around the dispatch site here,
 * cleared from the caught failure here as well).
 */
export type BinaryControlTransport = {
  observation: DeviceObservation;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  /**
   * The single device write seam. Binary control routes through
   * `actuator.apply({ kind: 'binary', ... })`; the actuator owns the
   * flow-vs-native routing on the producer-resolved `flowBacked` flag.
   */
  actuator: Actuator;
};

const logger = getLogger('executor/binary-dispatch');

/**
 * Convenience wrapper: ask the plan layer to decide (reading state via the
 * transport's bound `observation`) and, if it returns a decision, dispatch
 * it via the same transport. Returns `{ applied: true, flowBacked }` when the
 * underlying dispatch succeeded, `{ applied: false }` when the plan skipped or
 * the dispatch failed.
 *
 * The decide-and-dispatch pair must share one observation source to avoid
 * deciding against one snapshot and logging against another; that's why the
 * wrapper sources both from `transport.observation` rather than accepting a
 * second `DeviceObservation` parameter.
 */
export async function decideAndDispatchBinaryControl(params: {
  transport: BinaryControlTransport;
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: BinaryControlDecisionSnapshot;
  logContext: BinaryControlLogContext;
  restoreSource?: BinaryControlRestoreSource;
  reason?: string;
  actuationMode?: BinaryControlActuationMode;
  lifecycleRelease?: boolean;
}): Promise<BinaryControlOutcome> {
  const {
    transport, deviceId, name, desired, snapshot, logContext,
    restoreSource, reason, actuationMode, lifecycleRelease,
  } = params;
  const decision = decideBinaryControl({
    pendingBinaryCommandStore: transport.pendingBinaryCommandStore,
    deviceObservation: transport.observation,
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
  if (!decision) return { applied: false };
  const result = await dispatchBinaryControlDecision({ decision, transport, snapshot });
  if (!result.ok) return { applied: false };
  return { applied: true, flowBacked: decision.flowBackedControl };
}

/**
 * Dispatch a decision produced by the plan layer.
 *
 * Pending bookkeeping is observer-owned (PR #4 of the
 * observer/transport split):
 *
 * - On entry, records the pending entry via `transport.pendingBinaryCommandStore.record`
 *   so subsequent cycles see "command in flight". This replaces the
 *   previous write inside `decideBinaryControl` (plan layer).
 * - On success, leaves the entry intact for
 *   `syncPendingBinaryCommands` to clear once telemetry confirms.
 * - On caught failure, clears the entry via
 *   `transport.pendingBinaryCommandStore.clear` so the next cycle can
 *   retry without seeing a stale "already pending" guard.
 *
 * The return shape is discriminated so callers can distinguish
 * skipped-by-plan (handled by `decideAndDispatchBinaryControl`'s null
 * branch) from dispatch_failed.
 */
export async function dispatchBinaryControlDecision(params: {
  decision: BinaryControlDecision;
  transport: BinaryControlTransport;
  /** Snapshot the decision was made against; used to size the per-device pending window. */
  snapshot?: BinaryControlDecisionSnapshot;
}): Promise<DispatchBinaryControlResult> {
  const { decision, transport, snapshot } = params;
  recordPendingForDispatch({ store: transport.pendingBinaryCommandStore, decision, snapshot });
  try {
    await dispatchBinaryCommand({
      decision,
      transport,
    });
    emitBinaryCommandSuccess({
      decision,
    });
    return { ok: true };
  } catch (caughtError) {
    transport.pendingBinaryCommandStore.clear(decision.deviceId);
    emitBinaryCommandFailure({
      decision,
      err: caughtError,
    });
    return { ok: false, reason: 'dispatch_failed' };
  }
}

function recordPendingForDispatch(params: {
  store: PendingBinaryCommandStore;
  decision: BinaryControlDecision;
  snapshot?: BinaryControlDecisionSnapshot;
}): void {
  const { store, decision, snapshot } = params;
  store.record(decision.deviceId, {
    capabilityId: decision.capabilityId,
    desired: decision.desired,
    startedMs: Date.now(),
    pendingMs: resolveBinaryCommandPendingMs(snapshot?.communicationModel),
    flowBackedControl: decision.flowBackedControl,
    logContext: decision.logContext,
    restoreSource: decision.restoreSource,
    actuationMode: decision.actuationMode,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.lifecycleRelease ? { lifecycleRelease: true } : {}),
  });
}

async function dispatchBinaryCommand(params: {
  decision: BinaryControlDecision;
  transport: BinaryControlTransport;
}): Promise<void> {
  const { decision, transport } = params;
  await transport.actuator.apply({
    kind: 'binary',
    deviceId: decision.deviceId,
    control: decision.capabilityId,
    desired: decision.desired,
    flowBacked: decision.flowBackedControl,
  });
  if (decision.flowBackedControl) {
    logger.info({
      event: 'flow_backed_binary_command_requested',
      deviceId: decision.deviceId,
      deviceName: decision.name,
      capabilityId: decision.capabilityId,
      desired: decision.desired,
      logContext: decision.logContext,
      actuationMode: decision.actuationMode,
    });
  }
}

function emitBinaryCommandSuccess(params: {
  decision: BinaryControlDecision;
}): void {
  const { decision } = params;
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
      logContext: decision.logContext,
      desired: decision.desired,
      name: decision.name,
      reason: decision.reason,
      restoreSource: decision.restoreSource,
      actuationMode: decision.actuationMode,
      flowBackedControl: decision.flowBackedControl,
    }),
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
      desired: decision.desired,
      name: decision.name,
      flowBackedControl: decision.flowBackedControl,
    }),
  });
}

function buildBinaryControlSuccessLogMessage(params: {
  logContext: BinaryControlLogContext;
  desired: boolean;
  name: string;
  reason?: string;
  restoreSource?: BinaryControlRestoreSource;
  actuationMode: BinaryControlActuationMode;
  flowBackedControl: boolean;
}): string {
  const {
    logContext,
    desired,
    name,
    reason,
    restoreSource,
    actuationMode,
    flowBackedControl,
  } = params;
  if (flowBackedControl) {
    return buildFlowBackedBinaryControlRequestLogMessage({
      logContext,
      desired,
      name,
      reason,
      restoreSource,
      actuationMode,
    });
  }
  return buildBinaryControlLogMessage({ logContext, desired, name, reason, restoreSource, actuationMode });
}

function buildBinaryControlFailureLogMessage(params: {
  desired: boolean;
  name: string;
  flowBackedControl: boolean;
}): string {
  const { desired, name, flowBackedControl } = params;
  const verb = `${desired ? 'turn on' : 'turn off'}`;
  return flowBackedControl
    ? `Failed to request ${verb} ${name} via flow`
    : `Failed to ${verb} ${name} via DeviceTransport`;
}
