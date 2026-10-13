import {
  type BinaryControlDecision,
  type BinaryControlDecisionSnapshot,
  type BinaryControlDeps,
  shouldSkipBinaryControl,
} from './planBinaryControlHelpers';
// `getBinaryControlPlan` moved to `lib/device/deviceActionProjection.ts` as
// chunk 1 of the planner-detype refactor. Re-exported here so every existing
// call site continues to work unchanged.
import { getBinaryControlPlan } from '../device/deviceActionProjection';

export { getBinaryControlPlan } from '../device/deviceActionProjection';

export { type BinaryControlDecision } from './planBinaryControlHelpers';

/**
 * Decide whether the device should actuate this cycle.
 *
 * Returns the populated `BinaryControlDecision` or `null` when the
 * device should be skipped (already matched, pending, or lacks a
 * setable control plan). Plan does NOT touch pending state — recording
 * happens in `dispatchBinaryControlDecision` (executor) against the
 * observer-owned pending-binary-command store (PR #4 of the
 * observer/transport split).
 */
export function decideBinaryControl(
  deps: BinaryControlDeps,
  command: BinaryControlDecision,
  snapshot: BinaryControlDecisionSnapshot | undefined,
  forceAgainstReleasedOpposing: boolean,
): BinaryControlDecision | null {
  const controlPlan = getBinaryControlPlan(snapshot);
  const decision: BinaryControlDecision = {
    deviceId: command.deviceId,
    name: command.name,
    desired: command.desired,
    logContext: command.logContext,
    ...(command.lifecycleRelease ? { lifecycleRelease: true } : {}),
  };
  if (shouldSkipBinaryControl(deps, controlPlan, decision, snapshot, forceAgainstReleasedOpposing)) {
    return null;
  }
  return decision;
}

// `getBinaryControlPlan` moved to `lib/device/deviceActionProjection.ts`, where
// `resolveCanSetBinaryControl` collapsed into `resolveCanSetControl` and
// `resolveBinaryCapabilityId` gave way to the `hasBinaryAxis` shape check.
//
// `syncPendingBinaryCommands` moved to `lib/observer/pendingBinaryCommands.ts`
// as part of PR #4 of the observer/transport split. Import from observer
// directly; tests follow.
