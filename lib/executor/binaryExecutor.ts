import {
  isBinaryControlled,
  isBinaryObservedOff,
  isBinaryOnOrUnknown,
} from '../../packages/shared-domain/src/binaryControlState';
import { getDebugEmitter, getLogger } from '../logging/logger';
import {
  shouldSkipShedding,
} from './executorSupport';
import {
  getBinaryControlPlan,
} from '../plan/planBinaryControl';
import {
  shedActuationStampsCapacityMarkers,
} from './lifecycleReleaseRecording';
import type {
  ExecutableBinaryIntent,
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import { runBinaryControl, skipRestoreForExternalOffHold } from './binaryControlShared';
import type { ExecutorCommandContext } from './executorCommandContext';
import {
  applyBinaryRestoreWithSnapshot,
  canApplyRestoreSnapshot,
} from './binaryRestoreHelpers';

const logger = getLogger('executor/binary');
/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

export const applyBinaryRestore = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableBinaryIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  if (!intent || !intent.desiredOn || intent.source !== 'controlled') return false;
  const snapshot = ctx.readDevice(intent.deviceId) ?? observed?.snapshot;
  if (snapshot && isBinaryOnOrUnknown(snapshot)) return false;
  if (!canApplyRestoreSnapshot(ctx, snapshot, intent.deviceId, intent.name, 'capacity') || !snapshot) return false;
  return applyBinaryRestoreWithSnapshot(ctx, intent.deviceId, intent.name, snapshot);
};

export const applyUncontrolledBinaryRestore = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableBinaryIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  if (!intent || !intent.desiredOn || intent.source !== 'uncontrolled') return false;
  // Only a shed PELS has not undone is PELS's to undo. A baseline-off posture
  // hold never counts (`ShedDecisions.standingShedIds`), so a dump load is
  // never started here.
  if (!ctx.state.shedDecisions.standingShedIds.has(intent.deviceId)) return false;
  const entry = ctx.readDevice(intent.deviceId) ?? observed?.snapshot;
  if (entry && isBinaryOnOrUnknown(entry)) return false;
  if (!canApplyRestoreSnapshot(ctx, entry, intent.deviceId, intent.name, 'capacity_control_off') || !entry) {
    return false;
  }
  // "Leave off until turned on again" holds here too: losing control authority
  // is not consent to undo the owner's own off action.
  if (skipRestoreForExternalOffHold(ctx, intent.deviceId, intent.name)) return false;
  try {
    const outcome = await runBinaryControl({
      ctx,
      deviceId: intent.deviceId,
      name: intent.name,
      desired: true,
      snapshot: entry,
      logContext: 'capacity_control_off',
    });
    return outcome.applied;
  } catch (error) {
    logger.error({
      event: 'executor_binary_error',
      msg: `Failed to restore ${intent.name} via DeviceTransport`,
      err: error,
    });
    return false;
  }
};

/**
 * A capacity shed: turn the device off unless it is unreachable, already off,
 * or already being shed (`shouldSkipShedding`), tracked as a pending shed while
 * the write is in flight. Capacity dry run suppresses it.
 */
export const applyBinarySheddingToDevice = async (
  ctx: ExecutorCommandContext,
  deviceId: string,
  deviceName: string,
): Promise<boolean> => {
  if (ctx.getCapacityDryRun()) return false;
  const snapshot = ctx.readDevice(deviceId);
  if (shouldSkipShedding(ctx.state.actuation, deviceId, deviceName, snapshot)) return false;
  ctx.state.actuation.beginShed(deviceId);
  try {
    return await turnOffDevice(ctx, deviceId, deviceName, snapshot, false, false);
  } finally {
    ctx.state.actuation.endShed(deviceId);
  }
};

/**
 * A smart task's lifecycle-end disable. It is off the capacity path, so it
 * skips the capacity precheck, the pending-shed bookkeeping and the dry-run
 * fence, and records through the diagnostic-only recorder — for both the
 * direct write here and any deferred flow-backed confirmation in
 * `handleConfirmedBinaryCommand`. `snapshot` is the trusted observer projection
 * when the caller holds one; otherwise the device is read now.
 */
export const applyBinaryLifecycleRelease = async (
  ctx: ExecutorCommandContext,
  deviceId: string,
  deviceName: string,
  snapshot: ExecutorDeviceSnapshot | undefined,
  forceAgainstReleasedOpposing: boolean,
): Promise<boolean> => turnOffDevice(
  ctx,
  deviceId,
  deviceName,
  snapshot ?? ctx.readDevice(deviceId),
  true,
  forceAgainstReleasedOpposing,
);

export const applyDeferredBinaryCommand = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableReleaseIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
  options: {
    preferObservedSnapshot?: boolean;
    forceAgainstReleasedOpposing?: boolean;
  } = {},
): Promise<boolean> => {
  if (!intent) return false;
  if (intent.kind === 'shed_release') return false;
  const snapshot = options.preferObservedSnapshot
    ? observed?.snapshot
    : ctx.readDevice(intent.deviceId) ?? observed?.snapshot;
  // Requires a binary control handle (onoff or evcharger_charging). The actuation is
  // device-agnostic — the dispatched command's capability is derived from the device's
  // `binaryCapabilityId`, never hardcoded — so this accepts any binary control.
  if (!snapshot || !isBinaryControlled(snapshot)) return false;

  if (intent.kind === 'binary_release') {
    // A released binary device is just onoff=false; release only one that is
    // currently on. `binaryControl.on` is the consolidated binary truth.
    // Lifecycle-end release (smart task satisfied/idle), not a capacity shed:
    // it routes through the diagnostic-only recorder and bypasses the capacity
    // precheck / pendingSheds path so it does not stamp the cooldown markers.
    // The binary-on check is the trusted-evidence gate, mirroring
    // applyShedReleaseBinaryOff's gate.
    if (options.forceAgainstReleasedOpposing !== true && isBinaryObservedOff(snapshot)) return false;
    return applyBinaryLifecycleRelease(
      ctx,
      intent.deviceId,
      intent.name,
      snapshot,
      options.forceAgainstReleasedOpposing === true,
    );
  }

  // Restore only an off device — i.e. released. Reads the binary truth
  // (`binaryControl.on`), not any device-specific state string. Commandability is
  // NOT re-derived here: `canApplyRestoreSnapshot` below runs the same gate
  // through `canTurnOnDevice` and logs the skip, so a second silent copy of it
  // only added a way for the two to disagree.
  if (isBinaryOnOrUnknown(snapshot)) return false;
  if (!canApplyRestoreSnapshot(ctx, snapshot, intent.deviceId, intent.name, 'capacity')) return false;
  return applyBinaryRestoreWithSnapshot(ctx, intent.deviceId, intent.name, snapshot);
};

const turnOffDevice = async (
  ctx: ExecutorCommandContext,
  deviceId: string,
  name: string,
  snapshot: ExecutorDeviceSnapshot | undefined,
  lifecycleRelease: boolean,
  forceAgainstReleasedOpposing: boolean,
): Promise<boolean> => {
  const controlPlan = getBinaryControlPlan(snapshot);
  if (!controlPlan) {
    const hasTarget = Array.isArray(snapshot?.targets) && snapshot.targets.length > 0;
    if (shedActuationStampsCapacityMarkers(lifecycleRelease)) {
      const now = Date.now();
      ctx.state.actuation.markShed(deviceId, now);
    }
    emitExecutorDebug({
      event: 'binary_command_skipped',
      reasonCode: hasTarget ? 'missing_onoff_capability' : 'missing_control_targets',
      deviceId,
      deviceName: name,
      desired: false,
      logContext: 'capacity',
      hasTargets: hasTarget,
      controlAxis: 'binary',
    });
    emitExecutorDebug({ event: 'executor_binary_log_debug', msg: hasTarget
      ? `Capacity: skip turn_off for ${name}, device has no onoff capability`
      : `Capacity: skip turn_off for ${name}, device has no onoff or temperature target` });
    return false;
  }
  try {
    const outcome = await runBinaryControl({
      ctx,
      deviceId,
      name,
      desired: false,
      snapshot,
      logContext: 'capacity',
      lifecycleRelease,
      forceAgainstReleasedOpposing,
    });
    if (!outcome.applied) return false;
    return true;
  } catch (error) {
    logger.error({ event: 'executor_binary_error', msg: `Failed to turn off ${name} via DeviceTransport`, err: error });
    return false;
  }
};
