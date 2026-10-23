import {
  type BinaryControlDecision,
  type BinaryControlDecisionSnapshot,
  type ObservedBinaryControlRead,
} from '../plan/planBinaryControlHelpers';
import { decideBinaryControl } from '../plan/planBinaryControl';
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
 * Transport seam for binary-control dispatch. Executor talks to this rather
 * than importing `DeviceTransport` directly. Its one read is the observer's
 * record (`getObservedState`, whose binary axis decides), so the decision cannot consult a
 * transport snapshot the projection has not recorded (stage 5 of the snapshot
 * decomposition); its writes go through the actuator.
 *
 * Carries the observer-owned `pendingBinaryCommandStore` so the
 * dispatcher can record pending entries on every issued command and
 * clear them when the actuator declines or dispatch throws. Per PR #4 of the split, the plan
 * layer no longer touches pending state directly; writes and deletes
 * are both observer-owned (recorded around the dispatch site here,
 * cleared from the declined/failure arms here as well).
 */
export type BinaryControlTransport = {
  getObservedState: ObservedBinaryControlRead;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  /**
   * The single device write seam. Binary control routes through
   * `actuator.apply({ kind: 'binary', ... })`; transport privately resolves
   * native capability versus Flow routing.
   */
  actuator: Actuator;
  /** False once the issuing lane lost the device mid-write; its outcome is then not recorded. */
  isAuthorityCurrent: () => boolean;
};

const logger = getLogger('executor/binary-dispatch');

/**
 * Convenience wrapper: ask the plan layer to decide (reading the binary axis
 * via the transport's `getObservedState`) and, if it returns a
 * decision, dispatch it via the same transport. Returns `{ applied: true }`
 * when the underlying dispatch succeeded, `{ applied: false }` when the plan
 * skipped or the dispatch failed.
 *
 * The decide-and-dispatch pair must share one observation source to avoid
 * deciding against one reading and logging against another; that's why the
 * wrapper sources both from the transport rather than accepting a second
 * observed read.
 */
export async function decideAndDispatchBinaryControl(
  transport: BinaryControlTransport,
  command: BinaryControlDecision,
  snapshot: BinaryControlDecisionSnapshot | undefined,
  forceAgainstReleasedOpposing = false,
): Promise<BinaryControlOutcome> {
  const decision = decideBinaryControl(transport, command, snapshot, forceAgainstReleasedOpposing);
  if (!decision) return { applied: false };
  const result = await dispatchBinaryControlDecision({ decision, transport });
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
 * - When the actuator declines the request, authority is lost, or the transport
 *   gives a DEFINITE failure, clears the entry via
 *   `transport.pendingBinaryCommandStore.clear` so the next cycle can
 *   retry without seeing a stale "already pending" guard.
 * - **A timed-out write is not a definite failure**, so it keeps the entry and
 *   is treated as accepted. The outcome is genuinely unknown — the command may
 *   still land — and only telemetry can settle it. Clearing here would both
 *   claim knowledge PELS does not have and invite a duplicate re-issue into a
 *   live write. It reports `{ ok: true }` for the same reason a success does:
 *   a write left the process, so the device is worth re-reading.
 *
 * The return shape is discriminated so callers can distinguish
 * skipped-by-plan (handled by `decideAndDispatchBinaryControl`'s null
 * branch) from a declined request or dispatch failure.
 */
export async function dispatchBinaryControlDecision(params: {
  decision: BinaryControlDecision;
  transport: BinaryControlTransport;
}): Promise<DispatchBinaryControlResult> {
  const { decision, transport } = params;
  recordPendingForDispatch({
    store: transport.pendingBinaryCommandStore,
    decision,
  });
  try {
    const outcome = await transport.actuator.apply({
      kind: 'binary', deviceId: decision.deviceId, desired: decision.desired,
    });
    if (!outcome.requested) {
      transport.pendingBinaryCommandStore.clear(decision.deviceId);
      return { ok: false, reason: 'not_requested' };
    }
    if (outcome.kind !== 'binary') {
      throw new Error(`Binary actuator returned ${outcome.kind} outcome for ${decision.deviceId}`);
    }
    if (!transport.isAuthorityCurrent()) {
      transport.pendingBinaryCommandStore.clear(decision.deviceId);
      return { ok: false, reason: 'not_requested' };
    }
    transport.pendingBinaryCommandStore.recordDispatchAccepted(decision.deviceId, decision);
    if (outcome.acknowledged) emitBinaryCommandSuccess({ decision });
    else emitBinaryCommandOutcomeUnknown({ decision, err: outcome.err });
    return { ok: true };
  } catch (caughtError) {
    // Everything else is a definite answer from the transport — a rejection, a
    // 4xx/5xx, an actuator that declined. Nothing is in flight, so the entry
    // goes and the next cycle may retry without tripping its own guard.
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
}): void {
  const { store, decision } = params;
  store.record(decision.deviceId, {
    desired: decision.desired,
    startedMs: Date.now(),
    logContext: decision.logContext,
    ...(decision.lifecycleRelease ? { lifecycleRelease: true } : {}),
  });
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
    err,
  });
}

/**
 * Deliberately neither the success nor the failure event. It is not
 * `binary_command_succeeded`, because nothing confirmed the device changed; it
 * is not `binary_command_failed`, because nothing confirmed it did not. Keeping
 * a third event means a prod log can separate "the hub said no" from "the hub
 * never answered" — the pair used to be indistinguishable, which is what let a
 * timeout quietly erase an in-flight command.
 */
function emitBinaryCommandOutcomeUnknown(params: {
  decision: BinaryControlDecision;
  err: unknown;
}): void {
  const { decision, err } = params;
  logger.warn({
    event: 'binary_command_outcome_unknown',
    reasonCode: 'control_request_timed_out',
    deviceId: decision.deviceId,
    deviceName: decision.name,
    desired: decision.desired,
    controlAxis: 'binary',
    logContext: decision.logContext,
    err,
  });
}


