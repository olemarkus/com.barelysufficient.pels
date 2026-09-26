import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { ExecutorDeviceRead } from './executorDeviceRead';
import {
  type BinaryControlOutcome,
  type BinaryControlTransport,
  decideAndDispatchBinaryControl,
} from './binaryControlDispatch';
import type { PlanEngineState } from '../plan/planState';
import type { BinaryControlDecisionSnapshot } from '../plan/planBinaryControlHelpers';
import { getDebugEmitter } from '../logging/logger';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { BinaryCommandClaim, BinaryCommandClaimState } from './binaryCommandClaim';
import type { TargetCommandOwner } from './targetCommandClaim';

/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

export type PlanExecutorBinaryContext = {
  state: PlanEngineState;
  /** The device as the executor reads it now — descriptor joined with the observer's record. */
  readDevice: (deviceId: string) => ExecutorDeviceRead | undefined;
  capacityDryRun: boolean;
  buildBinaryControlTransport: () => BinaryControlTransport;
  recordShedActuation: (deviceId: string, name: string, now: number) => void;
  // Diagnostic-only recorder for the smart-task lifecycle-end disable path: records
  // the pels_shed diagnostic + closes the activation attempt WITHOUT stamping the
  // capacity cooldown markers (a lifecycle disable is not capacity pressure).
  recordReleaseShedActuation: (deviceId: string, name: string, now: number) => void;
  recordRestoreActuation: (deviceId: string, name: string, now: number) => void;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  binaryCommandClaim: BinaryCommandClaim;
  binaryCommandOwner: TargetCommandOwner;
  isLifecycleFallbackActive?: (deviceId: string) => boolean;
  /** Prevents late actuator completion from installing pending state after authority ended. */
  isBinaryCommandAuthorityCurrent?: () => boolean;
  /** Lifecycle-only retry scheduled when an already-running ordinary write releases its claim. */
  onBinaryCommandClaimReleased?: (released: BinaryCommandClaimState) => void;
};

export type BinaryCommandDispatchContext = Pick<
PlanExecutorBinaryContext,
'buildBinaryControlTransport' | 'binaryCommandClaim' | 'binaryCommandOwner'
| 'isLifecycleFallbackActive' | 'isBinaryCommandAuthorityCurrent'
| 'onBinaryCommandClaimReleased'
>;

/**
 * "Leave off until turned on again" restore carve-out. A device the user turned
 * off outside PELS must never be commanded back ON: not by a plan built before
 * the hold existed, not by the capacity-control-off force-ON lane, and not by a
 * smart task's deferred restore.
 *
 * Reads the plan-less-safe flat getter on engine state, never the plan device,
 * so a cold/absent/stale plan cannot bypass it. That getter applies the SAME
 * resolution as the producer (hold AND still observed off), so this can never
 * refuse a resume the planner thinks is fine. It is persistence-backed, so the
 * guard also holds across a restart.
 *
 * Deliberately does NOT clear the shed bookkeeping: the device is off because
 * the user turned it off, and nothing PELS recorded about it is released by that.
 */
export const skipRestoreForExternalOffHold = (
  ctx: Pick<PlanExecutorBinaryContext, 'state'>,
  deviceId: string,
  name: string,
): boolean => {
  if (!ctx.state.isExternalOffHeld(deviceId)) return false;
  emitExecutorDebug({
    event: 'restore_command_skipped',
    reasonCode: PLAN_REASON_CODES.externalOffHold,
    deviceId,
    deviceName: name,
  });
  return true;
};

export const runBinaryControl = async (params: {
  ctx: BinaryCommandDispatchContext;
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: BinaryControlDecisionSnapshot;
  logContext: 'capacity' | 'capacity_control_off';
  reason?: string;
  lifecycleRelease?: boolean;
  forceAgainstReleasedOpposing?: boolean;
}): Promise<BinaryControlOutcome> => {
  const {
    ctx, deviceId, name, desired, snapshot, logContext, reason,
    lifecycleRelease,
    forceAgainstReleasedOpposing,
  } = params;
  if (ctx.binaryCommandOwner === 'ordinary' && ctx.isLifecycleFallbackActive?.(deviceId) === true) {
    return { applied: false };
  }
  if (!ctx.binaryCommandClaim.acquire(
    deviceId,
    ctx.binaryCommandOwner,
    desired,
    ctx.onBinaryCommandClaimReleased,
  )) {
    return { applied: false };
  }
  let outcome: BinaryControlOutcome = { applied: false };
  try {
    outcome = await decideAndDispatchBinaryControl({
      transport: ctx.buildBinaryControlTransport(),
      deviceId,
      name,
      desired,
      snapshot,
      logContext,
      reason,
      lifecycleRelease,
      forceAgainstReleasedOpposing,
      isAuthorityCurrent: ctx.isBinaryCommandAuthorityCurrent,
    });
    return outcome;
  } finally {
    ctx.binaryCommandClaim.release(deviceId, ctx.binaryCommandOwner, desired, outcome.applied);
  }
};
