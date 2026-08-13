import type { DeviceObservation } from '../device/deviceObservation';
import {
  type BinaryControlDecision,
  type BinaryControlDecisionSnapshot,
  type BinaryControlLogContext,
  type BinaryControlRestoreSource,
  buildBinaryControlLogMessage,
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
  | { ok: false; reason: 'dispatch_failed' | 'not_requested' };

/**
 * Outcome of a decide-and-dispatch call, surfaced to executor callers.
 *
 * Every successful dispatch stays pending until observer telemetry confirms
 * the commanded binary value. Transport routing does not change that lifecycle.
 */
export type BinaryControlOutcome =
  | { applied: false }
  | { applied: true };

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
 * clear them when the actuator declines or dispatch throws. Per PR #4 of the split, the plan
 * layer no longer touches pending state directly; writes and deletes
 * are both observer-owned (recorded around the dispatch site here,
 * cleared from the declined/failure arms here as well).
 */
export type BinaryControlTransport = {
  observation: DeviceObservation;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  /**
   * The single device write seam. Binary control routes through
   * `actuator.apply({ kind: 'binary', ... })`; transport privately resolves
   * native capability versus Flow routing.
   */
  actuator: Actuator;
};

const logger = getLogger('executor/binary-dispatch');

/**
 * Convenience wrapper: ask the plan layer to decide (reading state via the
 * transport's bound `observation`) and, if it returns a decision, dispatch
 * it via the same transport. Returns `{ applied: true }` when the
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
  lifecycleRelease?: boolean;
  forceAgainstReleasedOpposing?: boolean;
  isAuthorityCurrent?: () => boolean;
}): Promise<BinaryControlOutcome> {
  const {
    transport, deviceId, name, desired, snapshot, logContext,
    restoreSource, reason, lifecycleRelease, forceAgainstReleasedOpposing,
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
    lifecycleRelease,
    forceAgainstReleasedOpposing,
  });
  if (!decision) return { applied: false };
  const result = await dispatchBinaryControlDecision({
    decision,
    transport,
    snapshot,
    isAuthorityCurrent: params.isAuthorityCurrent,
  });
  if (!result.ok) return { applied: false };
  return { applied: true };
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
 * - When the actuator declines the request or dispatch throws, clears the entry via
 *   `transport.pendingBinaryCommandStore.clear` so the next cycle can
 *   retry without seeing a stale "already pending" guard.
 *
 * The return shape is discriminated so callers can distinguish
 * skipped-by-plan (handled by `decideAndDispatchBinaryControl`'s null
 * branch) from a declined request or dispatch failure.
 */
export async function dispatchBinaryControlDecision(params: {
  decision: BinaryControlDecision;
  transport: BinaryControlTransport;
  /** Snapshot the decision was made against; used to size the per-device pending window. */
  snapshot?: BinaryControlDecisionSnapshot;
  isAuthorityCurrent?: () => boolean;
}): Promise<DispatchBinaryControlResult> {
  const {
    decision, transport, snapshot, isAuthorityCurrent,
  } = params;
  recordPendingForDispatch({
    store: transport.pendingBinaryCommandStore,
    decision,
    snapshot,
  });
  try {
    const outcome = await dispatchBinaryCommand({
      decision,
      transport,
    });
    if (!outcome.requested) {
      transport.pendingBinaryCommandStore.clear(decision.deviceId);
      return { ok: false, reason: 'not_requested' };
    }
    if (outcome.kind !== 'binary') {
      throw new Error(`Binary actuator returned ${outcome.kind} outcome for ${decision.deviceId}`);
    }
    if (isAuthorityCurrent?.() === false) {
      transport.pendingBinaryCommandStore.clear(decision.deviceId);
      return { ok: false, reason: 'not_requested' };
    }
    if (transport.pendingBinaryCommandStore.peek(decision.deviceId)) {
      transport.pendingBinaryCommandStore.recordDispatchAccepted(decision.deviceId, decision);
    }
    emitBinaryCommandSuccess({
      decision,
    });
    return { ok: true };
  } catch (caughtError) {
    transport.pendingBinaryCommandStore.recordDispatchFailed(decision.deviceId, decision);
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
    desired: decision.desired,
    startedMs: Date.now(),
    pendingMs: resolveBinaryCommandPendingMs(snapshot?.communicationModel ?? 'local'),
    logContext: decision.logContext,
    restoreSource: decision.restoreSource,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.lifecycleRelease ? { lifecycleRelease: true } : {}),
  });
}

async function dispatchBinaryCommand(params: {
  decision: BinaryControlDecision;
  transport: BinaryControlTransport;
}): ReturnType<Actuator['apply']> {
  const { decision, transport } = params;
  const outcome = await transport.actuator.apply({
    kind: 'binary',
    deviceId: decision.deviceId,
    desired: decision.desired,
  });
  return outcome;
}

function emitBinaryCommandSuccess(params: {
  decision: BinaryControlDecision;
}): void {
  const { decision } = params;
  logger.info({
    event: 'binary_command_succeeded',
    deviceId: decision.deviceId,
    deviceName: decision.name,
    controlAxis: 'binary',
    desired: decision.desired,
    logContext: decision.logContext,
    ...(decision.restoreSource ? { restoreSource: decision.restoreSource } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    msg: buildBinaryControlSuccessLogMessage({
      logContext: decision.logContext,
      desired: decision.desired,
      name: decision.name,
      reason: decision.reason,
      restoreSource: decision.restoreSource,
    }),
  });
}

function emitBinaryCommandFailure(params: {
  decision: BinaryControlDecision;
  err: unknown;
}): void {
  const { decision, err } = params;
  logger.error({
    event: 'binary_command_failed',
    reasonCode: 'control_request_failed',
    deviceId: decision.deviceId,
    deviceName: decision.name,
    desired: decision.desired,
    controlAxis: 'binary',
    logContext: decision.logContext,
    ...(decision.restoreSource ? { restoreSource: decision.restoreSource } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    err,
    msg: buildBinaryControlFailureLogMessage({
      desired: decision.desired,
      name: decision.name,
    }),
  });
}

function buildBinaryControlSuccessLogMessage(params: {
  logContext: BinaryControlLogContext;
  desired: boolean;
  name: string;
  reason?: string;
  restoreSource?: BinaryControlRestoreSource;
}): string {
  const {
    logContext,
    desired,
    name,
    reason,
    restoreSource,
  } = params;
  return buildBinaryControlLogMessage({ logContext, desired, name, reason, restoreSource });
}

function buildBinaryControlFailureLogMessage(params: {
  desired: boolean;
  name: string;
}): string {
  const { desired, name } = params;
  const verb = `${desired ? 'turn on' : 'turn off'}`;
  return `Failed to ${verb} ${name} via DeviceTransport`;
}
