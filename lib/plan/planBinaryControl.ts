import type { DeviceObservation } from '../device/deviceObservation';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import {
  type BinaryControlActuationMode,
  type BinaryControlDecision,
  type BinaryControlDecisionSnapshot,
  type BinaryControlLogContext,
  type BinaryControlRestoreSource,
  isFlowBackedBinaryControl,
  shouldSkipBinaryControl,
} from './planBinaryControlHelpers';
// `getBinaryControlPlan` and `getEvRestoreBlockReason` moved to
// `lib/device/deviceActionProjection.ts` as chunk 1 of the planner-detype
// refactor. Re-exported here so every existing call site continues to
// work unchanged.
import { getBinaryControlPlan } from '../device/deviceActionProjection';

export {
  getBinaryControlPlan,
  getEvRestoreBlockReason,
} from '../device/deviceActionProjection';

export {
  isFlowBackedBinaryControl,
  type BinaryControlDecision,
} from './planBinaryControlHelpers';

type BinaryControlDeps = {
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  deviceObservation: DeviceObservation;
};

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
export function decideBinaryControl(params: BinaryControlDeps & {
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: BinaryControlDecisionSnapshot;
  logContext: BinaryControlLogContext;
  restoreSource?: BinaryControlRestoreSource;
  reason?: string;
  actuationMode?: BinaryControlActuationMode;
  lifecycleRelease?: boolean;
}): BinaryControlDecision | null {
  const {
    pendingBinaryCommandStore, deviceObservation,
    deviceId, name, desired, snapshot, logContext, restoreSource, reason,
    actuationMode = 'plan', lifecycleRelease,
  } = params;
  const controlPlan = getBinaryControlPlan(snapshot);
  if (shouldSkipBinaryControl({
    controlPlan,
    deviceManager: deviceObservation,
    deviceId,
    desired,
    logContext,
    actuationMode,
    name,
    snapshot,
    pendingBinaryCommandStore,
  })) {
    return null;
  }
  if (!controlPlan) return null;

  const flowBackedControl = isFlowBackedBinaryControl(snapshot, controlPlan.capabilityId);

  return {
    deviceId,
    name,
    capabilityId: controlPlan.capabilityId,
    desired,
    flowBackedControl,
    logContext,
    actuationMode,
    restoreSource,
    reason,
    ...(lifecycleRelease ? { lifecycleRelease: true } : {}),
  };
}

// `resolveBinaryCapabilityId` and `resolveCanSetBinaryControl` moved with
// `getBinaryControlPlan` to `lib/device/deviceActionProjection.ts`.
//
// `syncPendingBinaryCommands` moved to `lib/observer/pendingBinaryCommands.ts`
// as part of PR #4 of the observer/transport split. Import from observer
// directly; tests follow.
