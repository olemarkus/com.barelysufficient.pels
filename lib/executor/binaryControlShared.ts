import {
  type BinaryControlOutcome,
  decideAndDispatchBinaryControl,
} from './binaryControlDispatch';
import type { BinaryControlDecision, BinaryControlDecisionSnapshot } from '../plan/planBinaryControlHelpers';
import { getDebugEmitter } from '../logging/logger';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { isHeldByLifecycleLane, type ExecutorCommandContext } from './executorCommandContext';

/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

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
  ctx: Pick<ExecutorCommandContext, 'state'>,
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

/** One binary command through the lane's claim: the command it asks for, and the read it judges by. */
export const runBinaryControl = async (
  ctx: ExecutorCommandContext,
  command: BinaryControlDecision,
  snapshot: BinaryControlDecisionSnapshot | undefined,
  forceAgainstReleasedOpposing = false,
): Promise<BinaryControlOutcome> => {
  const { deviceId, desired } = command;
  if (isHeldByLifecycleLane(ctx, deviceId)) {
    return { applied: false };
  }
  if (!ctx.binaryCommandClaim.acquire(
    deviceId,
    ctx.owner,
    desired,
    ctx.onBinaryCommandClaimReleased,
  )) {
    return { applied: false };
  }
  let outcome: BinaryControlOutcome = { applied: false };
  try {
    outcome = await decideAndDispatchBinaryControl(ctx, command, snapshot, forceAgainstReleasedOpposing);
    return outcome;
  } finally {
    ctx.binaryCommandClaim.release(deviceId, ctx.owner, desired, outcome.applied);
  }
};
